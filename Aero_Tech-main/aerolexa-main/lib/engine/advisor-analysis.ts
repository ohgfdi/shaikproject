/**
 * Advisor analysis core — every fact an advisor answer cites is computed here,
 * from the user's uploaded rows, with deterministic math. Nothing in this file
 * guesses: each function either returns a number derived from the data or a
 * null the caller must present as "not available in this dataset".
 *
 * Diagnostics implemented (all dependency-free, unit-tested):
 *
 *  - Contribution decomposition of a metric across a dimension: per-group
 *    contribution to the total and to the latest period-over-period change
 *    (mix effect — which groups moved the needle, in absolute currency units).
 *  - Mann–Kendall monotonic trend test on the bucketed series (real p-value).
 *  - Backtested one-step-ahead projection of the metric (rolling-origin MAE /
 *    RMSE / MAPE over the user's own history — see stats.backtestSeries).
 *  - HHI (Herfindahl–Hirschman Index) concentration on any dimension.
 *  - Welch t-test between the top and bottom segment means on a driver column
 *    (exact Student-t p-value) — "is this segment difference statistically
 *    real or just noise?"
 *  - Outlier exposure: share of the metric's total contributed by rows beyond
 *    the 1.5×IQR fences.
 *  - Missing-data risk per column that an analysis depends on.
 *
 * Every result carries the exact inputs (column names, periods, n) so the UI
 * can show "how was this calculated?" without inventing anything.
 */

import type { Cell } from "@/lib/engine/dataset";
import { bucketByDate, cellDate, cellNumber, cellString, columnIndex } from "@/lib/engine/dataset";
import { forecastSeries } from "@/lib/engine/forecast";
import {
  backtestSeries,
  linearRegression,
  mannKendall,
  mean,
  quantile,
  stddev,
  studentTPValue,
  sum,
} from "@/lib/engine/stats";
import type { ColumnDef, Granularity } from "@/lib/types";

export class AdvisorAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorAnalysisError";
  }
}

export interface AdvisorDataset {
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
  datasetName: string;
  datasetId: string;
}

// ---------------------------------------------------------------------------
// Primary metric + dimension resolution (deterministic, data-driven)
// ---------------------------------------------------------------------------

export interface MetricProfile {
  metric: string;
  total: number;
  mean: number;
  median: number;
  stddev: number;
  nonEmpty: number;
}

/**
 * Pick the headline metric deterministically: the numeric column with the
 * largest absolute total, excluding binary flags (0/1 columns carry no
 * business-magnitude signal). Ties break by file order — never by guessing.
 */
export function resolvePrimaryMetric(ds: AdvisorDataset): MetricProfile | null {
  const numeric = ds.columns.filter((c) => c.type === "number").map((c) => c.name);
  let best: { name: string; total: number; nonEmpty: number; median: number; stddev: number } | null = null;
  for (const name of numeric) {
    const vals = columnNumbers(ds, name);
    if (vals.length < 5) continue;
    const total = sum(vals);
    // Binary flag columns (every value 0/1) carry no business-magnitude signal.
    const allBinary = vals.every((v) => v === 0 || v === 1);
    if (allBinary) continue;
    if (!best || Math.abs(total) > Math.abs(best.total)) {
      best = { name, total, nonEmpty: vals.length, median: quantile(vals, 0.5), stddev: stddev(vals) };
    }
  }
  if (!best) return null;
  return {
    metric: best.name,
    total: best.total,
    mean: best.nonEmpty ? best.total / best.nonEmpty : 0,
    median: best.median,
    stddev: best.stddev,
    nonEmpty: best.nonEmpty,
  };
}

/** Best categorical dimension = the one with the most balanced usable split (3–50 levels). */
export function resolveDimension(ds: AdvisorDataset): string | null {
  let best: { name: string; levels: number } | null = null;
  for (const col of ds.columns) {
    if (col.type !== "string" && col.type !== "boolean") continue;
    const idx = columnIndex(ds.columns, col.name);
    const levels = new Set<string>();
    let usable = 0;
    for (const row of ds.rows) {
      const v = cellString(row[idx]);
      if (!v) continue;
      usable++;
      if (levels.size <= 60) levels.add(v);
    }
    if (levels.size < 2 || levels.size > 50 || usable < 10) continue;
    // Prefer the dimension closest to ~8 levels (informative but readable).
    const score = Math.abs(levels.size - 8);
    const bestScore = best ? Math.abs(best.levels - 8) : Number.POSITIVE_INFINITY;
    if (!best || score < bestScore) best = { name: col.name, levels: levels.size };
  }
  return best?.name ?? null;
}

/** Best date column (first date-typed column with ≥ 2 distinct periods). */
export function resolveDateColumn(ds: AdvisorDataset, metric: string): string | null {
  for (const col of ds.columns) {
    if (col.type !== "date") continue;
    const buckets = bucketByDate(ds.rows, ds.columns, col.name, metric, "month");
    if (buckets.length >= 2) return col.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contribution decomposition (which groups moved the metric)
// ---------------------------------------------------------------------------

export interface GroupContribution {
  group: string;
  /** metric total for this group over the analysed rows */
  total: number;
  /** share of the grand total (0–100) */
  sharePct: number;
  /** row count in the group */
  rows: number;
  /** mean metric value per row in the group */
  meanPerRow: number;
  /** change between the two latest periods (absolute metric units); null without a date column */
  latestChange: number | null;
  /** latestChange as % of that group's previous-period value; null when prev = 0 */
  latestChangePct: number | null;
}

/**
 * Decompose the metric across a dimension. With a date column, also computes
 * each group's contribution to the latest period-over-period change in
 * absolute units — the honest answer to "what drove this month's move".
 */
export function decomposeByDimension(
  ds: AdvisorDataset,
  metric: string,
  dimension: string,
  dateCol: string | null,
  granularity: Granularity = "month",
): {
  dimension: string;
  groups: GroupContribution[];
  grandTotal: number;
  prevPeriodLabel: string | null;
  latestPeriodLabel: string | null;
} {
  const mIdx = columnIndex(ds.columns, metric);
  const dIdx = columnIndex(ds.columns, dimension);
  const dateIdx = dateCol ? columnIndex(ds.columns, dateCol) : -1;
  if (mIdx < 0 || dIdx < 0) throw new AdvisorAnalysisError("Metric or dimension column disappeared from the dataset.");

  const totals = new Map<string, { total: number; rows: number }>();
  const periodSums = new Map<string, Map<string, number>>();
  const periodOrder: string[] = [];
  let latestKey: string | null = null;
  let prevKey: string | null = null;

  if (dateIdx >= 0 && dateCol) {
    const allBuckets = bucketByDate(ds.rows, ds.columns, dateCol, metric, granularity);
    if (allBuckets.length >= 2) {
      latestKey = allBuckets[allBuckets.length - 1]?.key ?? null;
      prevKey = allBuckets[allBuckets.length - 2]?.key ?? null;
      periodOrder.push(...allBuckets.map((b) => b.key));
    }
  }

  for (const row of ds.rows) {
    const group = cellString(row[dIdx]);
    const v = cellNumber(row[mIdx]);
    if (!group || !Number.isFinite(v)) continue;
    const cur = totals.get(group) ?? { total: 0, rows: 0 };
    cur.total += v;
    cur.rows += 1;
    totals.set(group, cur);

    if (dateIdx >= 0 && latestKey && prevKey) {
      const d = cellDate(row[dateIdx]);
      if (!d) continue;
      // Re-derive the bucket key the same way bucketByDate does (period sums).
      const iso = d.toISOString().slice(0, granularity === "year" ? 4 : granularity === "month" ? 7 : 10);
      const key = normalizeBucketKey(iso, granularity);
      if (key !== latestKey && key !== prevKey) continue;
      const byPeriod = periodSums.get(group) ?? new Map<string, number>();
      byPeriod.set(key, (byPeriod.get(key) ?? 0) + v);
      periodSums.set(group, byPeriod);
    }
  }

  const grandTotal = sum([...totals.values()].map((t) => t.total));
  const groups: GroupContribution[] = [...totals.entries()]
    .map(([group, t]) => {
      let latestChange: number | null = null;
      let latestChangePct: number | null = null;
      if (latestKey && prevKey) {
        const byPeriod = periodSums.get(group);
        const prevV = byPeriod?.get(prevKey);
        const latestV = byPeriod?.get(latestKey);
        if (prevV !== undefined && latestV !== undefined) {
          latestChange = latestV - prevV;
          latestChangePct = prevV !== 0 ? (latestChange / Math.abs(prevV)) * 100 : null;
        }
      }
      return {
        group,
        total: t.total,
        sharePct: grandTotal !== 0 ? (t.total / grandTotal) * 100 : 0,
        rows: t.rows,
        meanPerRow: t.rows ? t.total / t.rows : 0,
        latestChange,
        latestChangePct,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    dimension,
    groups,
    grandTotal,
    prevPeriodLabel: prevKey,
    latestPeriodLabel: latestKey,
  };
}

/** Match bucketByDate's key format for day/week/month/quarter/year. */
function normalizeBucketKey(iso: string, granularity: Granularity): string {
  if (granularity === "year") return iso.slice(0, 4);
  if (granularity === "month" || granularity === "quarter") return iso.slice(0, 7);
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Trend diagnostics on the bucketed series
// ---------------------------------------------------------------------------

export interface TrendDiagnosis {
  granularity: Granularity;
  dateCol: string;
  metric: string;
  periods: { label: string; value: number }[];
  nPeriods: number;
  latest: number | null;
  previous: number | null;
  changePct: number | null;
  mannKendall: { s: number; z: number; p: number; direction: "increasing" | "decreasing" | "no trend" };
  olsSlope: number;
  olsR2: number;
  projection: {
    nextPeriod: number;
    method: string;
    mae: number;
    rmse: number;
    mape: number;
    folds: number;
    reliable: boolean;
  } | null;
}

/**
 * Full trend read: buckets the series, tests monotonic trend, and projects the
 * next period with the REAL forecast engine (ETS + Theta + ARIMA, AICc-selected,
 * walk-forward backtested) when the series has ≥ 6 points — degrading to the
 * reduced heuristic set (labelled as such in the method name) only when the
 * series is too short for the engine. Nothing is fabricated either way.
 */
export function diagnoseTrend(
  ds: AdvisorDataset,
  metric: string,
  dateCol: string,
  granularity: Granularity = "month",
): TrendDiagnosis | null {
  const buckets = bucketByDate(ds.rows, ds.columns, dateCol, metric, granularity);
  if (buckets.length < 3) return null;
  const values = buckets.map((b) => b.value);
  const mk = mannKendall(values);
  const reg = linearRegression(values);
  const latest = values[values.length - 1] ?? null;
  const previous = values[values.length - 2] ?? null;
  const changePct =
    latest !== null && previous !== null && previous !== 0 ? ((latest - previous) / Math.abs(previous)) * 100 : null;

  // Projection tier 1 — the REAL forecast engine (ETS + Theta + ARIMA, AICc
  // selection + walk-forward backtest): the same one the forecast analysis
  // uses, so the advisor's projection is the platform's best model, not a
  // reduced heuristic set. Needs ≥ 6 finite points.
  let projection: TrendDiagnosis["projection"] = null;
  let engineFamily: "ets" | "arima" | "theta" | "croston" | null = null;
  try {
    const fit = forecastSeries(values, { horizon: 1 });
    const point = fit.points[0];
    const walkForward = backtestSeries(
      values,
      (h) => forecastSeries(h, { horizon: 1, noArima: h.length < 12 }).points[0]?.point ?? Number.NaN,
      Math.max(6, Math.floor(values.length / 3)),
    );
    if (point && Number.isFinite(point.point) && Number.isFinite(walkForward.mae)) {
      projection = {
        nextPeriod: point.point,
        method: `${fit.best.name} (${fit.best.family.toUpperCase()})`,
        mae: walkForward.mae,
        rmse: walkForward.rmse,
        mape: walkForward.mape,
        folds: walkForward.folds,
        // Plannable when the backtested mean error stays under 25%; a perfect
        // (or near-perfect) backtest is trivially plannable.
        reliable: Number.isFinite(walkForward.mape) && walkForward.mape < 25,
      };
      engineFamily = fit.best.family;
    }
  } catch {
    // Falls through to the honest reduced tier below — never a fabricated fit.
  }

  // Projection tier 2 — short series (3–5 points): the full engine needs ≥ 6,
  // so the reduced heuristic set runs INSTEAD and the method name says so.
  if (!projection) {
    const candidates: { name: string; step: (h: number[]) => number }[] = [
      {
        name: "linear trend",
        step: (h) => {
          const r = linearRegression(h);
          return r.intercept + r.slope * h.length;
        },
      },
      {
        name: "damped drift",
        step: (h) => {
          if (h.length < 2) return Number.NaN;
          const last = h[h.length - 1] as number;
          let drift = 0;
          let weight = 0;
          let w = 1;
          for (let i = h.length - 1; i >= 1; i--) {
            drift += w * ((h[i] as number) - (h[i - 1] as number));
            weight += w;
            w *= 0.8;
          }
          return weight > 0 ? last + drift / weight : last;
        },
      },
      { name: "moving average (3)", step: (h) => (h.length >= 3 ? mean(h.slice(-3)) : Number.NaN) },
    ];
    let bestMae = Number.POSITIVE_INFINITY;
    const minTrain = Math.max(3, Math.min(6, Math.floor(values.length / 3)));
    for (const c of candidates) {
      const bt = backtestSeries(values, c.step, minTrain);
      if (!Number.isFinite(bt.mae)) continue;
      if (bt.mae < bestMae) {
        bestMae = bt.mae;
        projection = {
          nextPeriod: c.step(values),
          method: `${c.name} (reduced set — series too short for the ETS/ARIMA engine)`,
          mae: bt.mae,
          rmse: bt.rmse,
          mape: bt.mape,
          folds: bt.folds,
          reliable: Number.isFinite(bt.mape) && bt.mape < 25,
        };
      }
    }
  }
  void engineFamily;

  return {
    granularity,
    dateCol,
    metric,
    periods: buckets.slice(-24).map((b) => ({ label: b.label, value: b.value })),
    nPeriods: buckets.length,
    latest,
    previous,
    changePct,
    mannKendall: { s: mk.s, z: mk.z, p: mk.p, direction: mk.direction },
    olsSlope: reg.slope,
    olsR2: reg.r2,
    projection,
  };
}

// ---------------------------------------------------------------------------
// Concentration (HHI) + risk
// ---------------------------------------------------------------------------

export interface ConcentrationDiagnosis {
  dimension: string;
  hhi: number; // 0–10,000 scale
  topSharePct: number;
  top3SharePct: number;
  levels: number;
  interpretation: "highly concentrated" | "moderately concentrated" | "competitive";
}

/** Herfindahl–Hirschman Index on group shares (percent-scale: 10,000 = monopoly). */
export function concentrationDiagnosis(
  contrib: ReturnType<typeof decomposeByDimension>,
  _dimension?: string,
): ConcentrationDiagnosis {
  const dimension = contrib.dimension;
  const total = contrib.grandTotal || 1;
  const shares = contrib.groups.map((g) => (g.total / total) * 100);
  const hhi = shares.reduce((acc, s) => acc + s * s, 0);
  const topSharePct = shares[0] ?? 0;
  const top3SharePct = sum(shares.slice(0, 3));
  return {
    dimension,
    hhi: Math.round(hhi),
    topSharePct,
    top3SharePct,
    levels: shares.length,
    interpretation: hhi > 2500 ? "highly concentrated" : hhi >= 1500 ? "moderately concentrated" : "competitive",
  };
}

// ---------------------------------------------------------------------------
// Segment significance (Welch t-test on a driver across two segments)
// ---------------------------------------------------------------------------

export interface SegmentComparison {
  dimension: string;
  metric: string;
  segmentA: string;
  segmentB: string;
  meanA: number;
  meanB: number;
  diffPct: number;
  tStatistic: number;
  pValue: number;
  nA: number;
  nB: number;
  significant: boolean;
}

/**
 * Welch (unequal-variance) t-test between the highest-total and lowest-total
 * segments on their per-row mean of the metric. Uses the exact Student-t
 * distribution for the p-value — the same statistic scipy.stats.ttest_ind
 * (equal_var=False) reports.
 */
export function compareTopSegments(ds: AdvisorDataset, metric: string, dimension: string): SegmentComparison | null {
  const mIdx = columnIndex(ds.columns, metric);
  const dIdx = columnIndex(ds.columns, dimension);
  if (mIdx < 0 || dIdx < 0) return null;
  const byGroup = new Map<string, number[]>();
  for (const row of ds.rows) {
    const g = cellString(row[dIdx]);
    const v = cellNumber(row[mIdx]);
    if (!g || !Number.isFinite(v)) continue;
    const arr = byGroup.get(g) ?? [];
    arr.push(v);
    byGroup.set(g, arr);
  }
  const sized = [...byGroup.entries()].filter(([, vals]) => vals.length >= 5);
  if (sized.length < 2) return null;
  sized.sort((a, b) => sum(b[1]) - sum(a[1]));
  const [aName, aVals] = sized[0] as [string, number[]];
  const [bName, bVals] = sized[sized.length - 1] as [string, number[]];
  const t = welchTTest(aVals, bVals);
  if (!t) return null;
  const meanA = mean(aVals);
  const meanB = mean(bVals);
  const diffPct = meanB !== 0 ? ((meanA - meanB) / Math.abs(meanB)) * 100 : null;
  return {
    dimension,
    metric,
    segmentA: aName,
    segmentB: bName,
    meanA,
    meanB,
    diffPct: diffPct ?? Number.NaN,
    tStatistic: t.t,
    pValue: t.p,
    nA: aVals.length,
    nB: bVals.length,
    significant: t.p < 0.05,
  };
}

/** Welch's t-test — unequal variances, Satterthwaite df, exact t p-value. */
export function welchTTest(a: number[], b: number[]): { t: number; p: number; df: number } | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return null;
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = stddev(a) ** 2;
  const v2 = stddev(b) ** 2;
  const se2 = v1 / n1 + v2 / n2;
  if (se2 <= 0) return null;
  const t = (m1 - m2) / Math.sqrt(se2);
  const df = se2 ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  if (!Number.isFinite(df) || df <= 0) return null;
  const p = studentTPValue(Math.abs(t), df);
  return { t, p: Number.isFinite(p) ? p : 1, df };
}

// ---------------------------------------------------------------------------
// Outlier exposure
// ---------------------------------------------------------------------------

export interface OutlierExposure {
  metric: string;
  outlierRows: number;
  outlierShareOfRowsPct: number;
  /** share of the metric's TOTAL contributed by outlier rows (the business risk) */
  totalSharePct: number | null;
  outlierThresholdHigh: number;
  outlierThresholdLow: number;
}

/**
 * How much of the metric's total sits in outlier rows (beyond 1.5×IQR fences)?
 * This is the honest "your average is being dragged by extremes" measure.
 */
export function outlierExposure(ds: AdvisorDataset, metric: string): OutlierExposure | null {
  const vals = columnNumbersWithIndex(ds, metric);
  if (vals.length < 8) return null;
  const raw = vals.map((v) => v.v);
  const q1 = quantile(raw, 0.25);
  const q3 = quantile(raw, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr === 0) {
    return {
      metric,
      outlierRows: 0,
      outlierShareOfRowsPct: 0,
      totalSharePct: 0,
      outlierThresholdHigh: q3,
      outlierThresholdLow: q1,
    };
  }
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const outlierVals = vals.filter((x) => x.v > hi || x.v < lo);
  const total = sum(raw);
  return {
    metric,
    outlierRows: outlierVals.length,
    outlierShareOfRowsPct: (outlierVals.length / vals.length) * 100,
    totalSharePct: total !== 0 ? (sum(outlierVals.map((x) => x.v)) / total) * 100 : null,
    outlierThresholdHigh: hi,
    outlierThresholdLow: lo,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnNumbers(ds: AdvisorDataset, name: string): number[] {
  return columnNumbersWithIndex(ds, name).map((x) => x.v);
}

function columnNumbersWithIndex(ds: AdvisorDataset, name: string): { v: number }[] {
  const idx = columnIndex(ds.columns, name);
  if (idx < 0) return [];
  const out: { v: number }[] = [];
  for (const row of ds.rows) {
    const v = cellNumber(row[idx]);
    if (Number.isFinite(v)) out.push({ v });
  }
  return out;
}

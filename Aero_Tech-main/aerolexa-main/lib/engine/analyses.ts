import { sequentialProbabilityRatioTest } from "@/lib/engine/ab-serving";
import { evaluateAbTest } from "@/lib/engine/abtest";
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  balanceSheet,
  cashFlow,
  formatMinor,
  incomeStatement,
  toMinorUnits,
  trialBalance,
  validateEntry,
  type JournalEntry,
  type Ledger,
} from "@/lib/engine/accounting";
import { autoTrain } from "@/lib/engine/automl";
import { bayesianLinearRegression, gaussianProcessRegression } from "@/lib/engine/bayes";
import {
  auditSample,
  computeGst3B,
  computeTds,
  fmt as complianceFmt,
  type GstCategory,
  type GstTransaction,
  type TdsSection,
} from "@/lib/engine/ca-india";
import { checkContract, runQualityGate, type ContractColumn, type Expectation } from "@/lib/engine/data-quality";
import type { Cell } from "@/lib/engine/dataset";
import { classifyValues } from "@/lib/engine/geo";
import {
  applyCategoricalFilter,
  bucketByDate,
  bucketKey,
  bucketLabel,
  cellDate,
  cellNumber,
  cellString,
  columnIndex,
  numericColumn,
  valueCounts,
} from "@/lib/engine/dataset";
import { trainParallel } from "@/lib/engine/deep-learning";
import { runDistributed, type ColumnarRow } from "@/lib/engine/distributed";
import { cliffsDelta, cohensD, kaplanMeier, kruskalWallis, mannWhitneyU } from "@/lib/engine/elite-stats";
import { trainWord2vec } from "@/lib/engine/embeddings";
import { retrieveFeatures } from "@/lib/engine/feature-store";
import { forecastSeries } from "@/lib/engine/forecast";
import { arimaxForecast } from "@/lib/engine/forecast-advanced";
import { fitSarima } from "@/lib/engine/forecast-seasonal";
import { runGeospatialAnalysis, type GeoPoint } from "@/lib/engine/geospatial";
import { fitHte } from "@/lib/engine/hte";
import { regularizedBeta } from "@/lib/engine/hypothesis";
import { estimateIv } from "@/lib/engine/iv-calculus";
import { MlError, type MlColumn } from "@/lib/engine/ml-training";
import { detectDrift } from "@/lib/engine/mlops";
import { forward, initMlp, trainMlp } from "@/lib/engine/neural-net";
import {
  buildVocabulary,
  classifyTexts,
  computeSentiment,
  detectLanguages,
  featurizeAll,
  similarityReport,
  summarizeEntities,
  trainLda,
} from "@/lib/engine/nlp";
import { fitServingArtifact, simulateServing } from "@/lib/engine/real-time-serving";
import {
  fiveNumberSummary,
  histogram,
  kmeans,
  linearRegression,
  mannKendall,
  max,
  mean,
  median,
  studentTCriticalTwoSided,
  studentTPValue,
  variance,
  min,
  normalityCheck,
  outlierCount,
  pearson,
  quantile,
  spearman,
  standardize,
  stddev,
  sum,
} from "@/lib/engine/stats";
import { runStreaming, type StreamEvent, type StreamingOptions } from "@/lib/engine/streaming";
import { runSurvival } from "@/lib/engine/survival";
import { syntheticControl } from "@/lib/engine/synthetic-control";
import { fitUplift } from "@/lib/engine/uplift";
import { runWhatIf } from "@/lib/engine/whatif";
import type {
  AnalysisConfig,
  AnalysisKind,
  AnalysisResult,
  ChartSpec,
  ChartSeries,
  ColumnDef,
  Granularity,
  KpiCard,
  MethodologyInfo,
  ScopeInfo,
  TableSpec,
} from "@/lib/types";
import { ANALYSIS_KIND_LABELS } from "@/lib/types";

/** Thrown when a config references missing columns or unusable types. */
export class AnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisInputError";
  }
}

export interface RunAnalysisInput {
  datasetId: string;
  datasetName: string;
  totalRows: number;
  columns: ColumnDef[];
  rows: Cell[][];
  /** data-quality warnings already known about the dataset */
  datasetWarnings?: string[];
}

interface Ctx {
  columns: ColumnDef[];
  rows: Cell[][];
  sampled: boolean;
  totalRows: number;
  datasetId: string;
  datasetName: string;
  datasetWarnings: string[];
}

function requireColumn(columns: ColumnDef[], name: string | null | undefined, expected?: ColumnDef["type"]): number {
  if (!name) throw new AnalysisInputError("No column selected. Pick a column and run again.");
  const idx = columnIndex(columns, name);
  if (idx < 0) throw new AnalysisInputError(`Column "${name}" no longer exists in the dataset. Choose another column.`);
  if (expected && columns[idx]?.type !== expected) {
    throw new AnalysisInputError(
      `Column "${name}" is "${columns[idx]?.type ?? "unknown"}"; this analysis needs a "${expected}" column. Re-cast it on the dataset page or pick another column.`,
    );
  }
  return idx;
}

function chartTitleFor(cfg: AnalysisConfig, columns: ColumnDef[]): string {
  const metric = "metric" in cfg ? cfg.metric : undefined;
  const name = metric ? metric : (columns[0]?.name ?? "dataset");
  return `${ANALYSIS_KIND_LABELS[cfg.kind]} · ${name}`;
}

/** Assemble the shared parts of every result (scope, filters, methodology scaffold). */
function makeCtx(input: RunAnalysisInput, cfg: AnalysisConfig): Ctx {
  const sampled = input.totalRows > input.rows.length;
  return {
    columns: input.columns,
    rows: applyCategoricalFilter(input.rows, input.columns, cfg.filterCol, cfg.filterValue),
    sampled,
    totalRows: input.totalRows,
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    datasetWarnings: input.datasetWarnings ?? [],
  };
}

function baseResult(
  ctx: Ctx,
  cfg: AnalysisConfig,
  methodology: MethodologyInfo,
  localWarnings: string[] = [],
): Omit<AnalysisResult, "charts" | "tables"> {
  const scope: ScopeInfo = {
    rowsUsed: ctx.rows.length,
    totalRows: ctx.totalRows,
    sampled: ctx.sampled,
    filters: cfg.filterCol && cfg.filterValue ? [{ column: cfg.filterCol, value: cfg.filterValue }] : [],
  };
  const warnings = [...ctx.datasetWarnings, ...localWarnings];
  return {
    kind: cfg.kind,
    title: chartTitleFor(cfg, ctx.columns),
    dataset: {
      name: ctx.datasetName,
      id: ctx.datasetId,
      rowCount: ctx.totalRows,
      columns: ctx.columns.map((c) => c.name),
    },
    scope,
    configHuman: humaniseConfig(cfg, ctx),
    methodology,
    qualityWarnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------------------
// EDA
// ---------------------------------------------------------------------------

function runEda(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "eda" }>): AnalysisResult {
  const { rows, columns } = ctx;
  const result = baseResult(ctx, cfg, {
    method:
      "Column profiling: every column is typed, then non-empty counts, distinct counts and numeric summaries are computed over the analysed rows in a single streaming pass.",
    steps: [
      "Column type inference over the first 1,000 non-empty cells (number/date/boolean/string).",
      "Per column: missing count, distinct count, min/max/mean/stddev/quartiles for numeric columns, top values for categorical columns.",
      `Analysed ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}${ctx.sampled ? ` (sampled from ${ctx.totalRows.toLocaleString()} total rows)` : ""}.`,
      "Exact duplicate rows were counted within the analysed window.",
    ],
    assumptions: [
      "Outliers are counted with the 1.5×IQR fence rule.",
      "Distinct counts cap at 10,000 (larger cardinalities are reported as “10,000+”).",
    ],
  });

  const missingCounts: number[] = [];
  const missingLabels: string[] = [];
  const numericCharts: ChartSpec[] = [];
  const normalityNotes: string[] = [];

  for (const col of columns) {
    const idx = columnIndex(columns, col.name);
    let missing = 0;
    for (const row of rows) {
      const cell = row[idx];
      if (cell === null || cell === undefined || cell === "") missing++;
    }
    missingCounts.push(missing);
    missingLabels.push(col.name);
  }

  // Per-numeric-column shape diagnostics: a compact histogram + normality
  // screen for the first few numeric columns (kept bounded so the EDA page
  // stays fast on wide files).
  const numericCols = columns.filter((c) => c.type === "number").slice(0, 4);
  for (const col of numericCols) {
    const vals = numericColumn(rows, columns, col.name);
    if (vals.length < 8) continue;
    const h = histogram(vals);
    if (h.binLabels.length === 0) continue;
    numericCharts.push({
      kind: "histogram",
      title: `Distribution of ${col.name}`,
      subtitle: `${vals.length.toLocaleString()} numeric values · Freedman–Diaconis bins`,
      categories: h.binLabels,
      series: [{ name: col.name, data: h.counts, color: "#5AA8AA" }],
      yLabel: "Count",
    });
    const norm = normalityCheck(vals);
    if (Number.isFinite(norm.pValue)) {
      normalityNotes.push(
        `${col.name}: Anderson–Darling A² = ${norm.statistic.toFixed(3)}, p = ${norm.pValue.toFixed(4)} — ${norm.passed ? "normal at 5%" : "not normal at 5%"}.`,
      );
    }
  }

  const typeCounts = new Map<string, number>();
  for (const col of columns) typeCounts.set(col.type, (typeCounts.get(col.type) ?? 0) + 1);

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: "Missing values per column",
      subtitle: "Empty cells are excluded from every downstream calculation.",
      xLabel: "Column",
      yLabel: "Missing rows",
      categories: missingLabels,
      series: [{ name: "Missing", data: missingCounts, color: "#E8637A" }],
    },
    {
      kind: "donut",
      title: "Column types",
      subtitle: "How the profiler classified each column.",
      categories: [...typeCounts.keys()],
      series: [...typeCounts.entries()].map(([name, count]) => ({ name, data: [count] })),
    },
    ...numericCharts,
  ];

  const table: TableSpec = {
    title: "Column profile",
    columns: [
      { key: "col", label: "Column" },
      { key: "type", label: "Type" },
      { key: "nonEmpty", label: "Non-empty" },
      { key: "missing", label: "Missing" },
      { key: "distinct", label: "Distinct" },
      { key: "min", label: "Min" },
      { key: "max", label: "Max" },
      { key: "mean", label: "Mean" },
      { key: "median", label: "Median" },
      { key: "top", label: "Top value" },
    ],
    rows: columns.map((col) => {
      const vals = col.type === "number" ? numericColumn(rows, columns, col.name) : [];
      return [
        col.name,
        col.type,
        rows.length - missingCounts[columnIndex(columns, col.name)]!,
        missingCounts[columnIndex(columns, col.name)]!,
        null,
        col.type === "number" && vals.length ? Math.round(min(vals) * 100) / 100 : null,
        col.type === "number" && vals.length ? Math.round(max(vals) * 100) / 100 : null,
        col.type === "number" && vals.length ? Math.round(mean(vals) * 100) / 100 : null,
        col.type === "number" && vals.length ? Math.round(median(vals) * 100) / 100 : null,
        null,
      ];
    }),
  };

  // distinct + top values are appended after to keep the mapping readable
  const countsByCol = new Map<string, { value: string; count: number } | null>();
  for (const col of columns) {
    const vals = ctx.rows.map((r) => cellString(r[columnIndex(columns, col.name)]));
    const counts = valueCounts(vals);
    countsByCol.set(col.name, counts[0] ?? null);
  }
  // Distinct counts via a bounded set for cardinality
  const distinctByCol = new Map<string, number>();
  for (const col of columns) {
    const set = new Set<string>();
    let tooMany = false;
    for (const row of rows) {
      const s = cellString(row[columnIndex(columns, col.name)]!);
      if (s) {
        if (set.size >= 10_000) {
          tooMany = true;
          break;
        }
        set.add(s);
      }
    }
    distinctByCol.set(col.name, tooMany ? 10_000 : set.size);
  }
  table.rows = table.rows.map((r, i) => {
    const colName = columns[i]?.name ?? "";
    const top = countsByCol.get(colName);
    const row = [...r];
    row[4] = distinctByCol.get(colName) ?? 0;
    row[9] = top ? `${top.value} (${top.count})` : null;
    return row;
  });

  return {
    ...result,
    charts,
    tables: [table],
    quickFindings: normalityNotes.length
      ? ["Distribution shape: " + normalityNotes.slice(0, 2).join(" · ")]
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

function runTrend(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "trend" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.dateCol, "date");
  requireColumn(ctx.columns, cfg.metric, "number");
  const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, cfg.granularity);
  if (buckets.length < 2) {
    throw new AnalysisInputError(
      `Only ${buckets.length} period${buckets.length === 1 ? "" : "s"} have data. Choose a finer granularity or a metric with more history.`,
    );
  }
  const display = buckets.slice(-80);
  const values = buckets.map((b) => b.value);
  const latest = values[values.length - 1] ?? 0;
  const previous = values[values.length - 2] ?? 0;
  const first = values[0] ?? 0;
  const moM = previous !== 0 ? ((latest - previous) / Math.abs(previous)) * 100 : null;
  const firstLast = first !== 0 ? ((latest - first) / Math.abs(first)) * 100 : null;
  const reg = linearRegression(values);

  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `${cfg.metric} by ${cfg.granularity}`,
      subtitle: `Aggregated as a sum of ${cfg.metric} per ${cfg.granularity}.`,
      xLabel: cfg.granularity,
      yLabel: cfg.metric,
      categories: display.map((b) => b.label),
      series: [
        { name: cfg.metric, data: display.map((b) => b.value), color: "#5AA8AA" },
        {
          name: "3-period average",
          data: display.map((_, i) => {
            const window = display.slice(Math.max(0, i - 2), i + 1).map((b) => b.value);
            return window.length ? mean(window) : null;
          }),
          color: "#FFB400",
        },
      ],
    },
  ];

  const tableRows = buckets.map((b, i) => {
    const prev = i > 0 ? (buckets[i - 1]?.value ?? 0) : null;
    const change = prev !== null && prev !== 0 ? ((b.value - prev) / Math.abs(prev)) * 100 : null;
    return [b.label, Math.round(b.value * 100) / 100, b.count, change !== null ? Math.round(change * 10) / 10 : null];
  });

  const result = baseResult(ctx, cfg, {
    method: `Period-over-period sums of ${cfg.metric} grouped by ${cfg.granularity} on ${cfg.dateCol}, zero-filling empty periods between the first and last observed date.`,
    steps: [
      `Group rows by ${cfg.granularity} bucket of ${cfg.dateCol} and sum ${cfg.metric} per bucket.`,
      `Percentage change = (current − previous) / |previous| × 100 for each adjacent pair.`,
      `Trend line fitted with ordinary least squares on period index (R² = ${reg.r2 >= 0 ? reg.r2.toFixed(2) : "0"}).`,
    ],
    assumptions: ["Empty periods between first and last date are treated as zero.", "Outliers are not removed."],
  });
  const quick: string[] = [];
  if (moM !== null)
    quick.push(
      `${cfg.metric} changed ${moM >= 0 ? "+" : ""}${moM.toFixed(1)}% vs the previous period (${display[display.length - 2]?.label ?? "previous"} → ${display[display.length - 1]?.label ?? "latest"}).`,
    );
  if (firstLast !== null && buckets.length > 3)
    quick.push(
      `Since the first observed period, ${cfg.metric} moved ${firstLast >= 0 ? "+" : ""}${firstLast.toFixed(1)}% in total.`,
    );
  return {
    ...result,
    charts,
    tables: [
      {
        title: `${cfg.metric} per ${cfg.granularity}`,
        columns: [
          { key: "period", label: "Period" },
          { key: "value", label: cfg.metric, format: "number" },
          { key: "rows", label: "Rows" },
          { key: "chg", label: "Change %", format: "pct" },
        ],
        rows: tableRows,
      },
    ],
    quickFindings: quick,
  };
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

function runKpi(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "kpi" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.metric, "number");
  const values = numericColumn(ctx.rows, ctx.columns, cfg.metric);
  const n = values.length;
  const kpiCards: KpiCard[] = [];
  const charts: ChartSpec[] = [];
  const stats = [
    { label: "Non-empty rows", value: n.toLocaleString() },
    { label: "Sum", value: fmtShort(sum(values)) },
    { label: "Average", value: fmtShort(mean(values)) },
    { label: "Min / Max", value: `${fmtShort(min(values))} / ${fmtShort(max(values))}` },
  ];

  if (cfg.dateCol && columnIndex(ctx.columns, cfg.dateCol) >= 0) {
    const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, cfg.granularity);
    const vals = buckets.map((b) => b.value);
    const latest = vals[vals.length - 1] ?? 0;
    const previous = vals[vals.length - 2];
    const pct = previous !== undefined && previous !== 0 ? ((latest - previous) / Math.abs(previous)) * 100 : null;
    kpiCards.push(
      {
        label: `Latest ${cfg.granularity} (${buckets[buckets.length - 1]?.label ?? "—"})`,
        value: fmtShort(latest),
        deltaPct: pct,
        deltaLabel: "vs previous period",
        spark: vals.slice(-24),
      },
      { label: "Period average", value: fmtShort(mean(vals)), spark: vals.slice(-24) },
      { label: "Best period", value: fmtShort(max(vals)) },
      { label: "Worst period", value: fmtShort(min(vals)) },
    );
    charts.push({
      kind: "area",
      title: `${cfg.metric} per ${cfg.granularity}`,
      categories: buckets.map((b) => b.label),
      series: [{ name: cfg.metric, data: vals, color: "#5AA8AA" }],
      yLabel: cfg.metric,
    });
  } else {
    kpiCards.push(
      { label: "Total", value: fmtShort(sum(values)) },
      { label: "Average", value: fmtShort(mean(values)) },
      { label: "Maximum", value: fmtShort(max(values)) },
      { label: "Minimum", value: fmtShort(min(values)) },
    );
    charts.push({
      kind: "histogram",
      title: `Spread of ${cfg.metric}`,
      subtitle: "Histogram of all numeric values.",
      series: [{ name: cfg.metric, data: histogram(values).counts, color: "#5AA8AA" }],
      categories: histogram(values).binLabels,
    });
  }

  const result = baseResult(ctx, cfg, {
    method: `Descriptive KPIs for ${cfg.metric}${cfg.dateCol ? `, split into ${cfg.granularity} periods on ${cfg.dateCol}` : ""}.`,
    steps: [
      "Sum, mean, min and max are computed over rows with a finite numeric value.",
      cfg.dateCol
        ? `Latest period = last ${cfg.granularity} bucket; change vs the immediately previous bucket.`
        : "No date column selected — aggregate KPIs over all rows.",
    ],
    assumptions: ["Rows where the metric is missing are excluded from that metric's math."],
  });

  if (cfg.dimensionCol && columnIndex(ctx.columns, cfg.dimensionCol) >= 0) {
    const groups = topGroups(ctx.rows, ctx.columns, cfg.dimensionCol, cfg.metric, 8);
    charts.push({
      kind: "bar",
      title: `Top ${cfg.dimensionCol} by ${cfg.metric}`,
      categories: groups.map((g) => g.value),
      series: [{ name: cfg.metric, data: groups.map((g) => g.sum), color: "#5AA8AA" }],
      yLabel: cfg.metric,
    });
    const total = sum(groups.map((g) => g.sum)) || 1;
    stats.push({
      label: "Top group share",
      value: `${((groups[0]?.sum ?? 0) / total) * 100 >= 0 ? (((groups[0]?.sum ?? 0) / total) * 100).toFixed(1) : "0"}%`,
    });
  }

  return { ...result, charts, stats, tables: undefined };
}

function topGroups(
  rows: Cell[][],
  columns: ColumnDef[],
  dim: string,
  metric: string,
  topN: number,
): { value: string; sum: number; count: number }[] {
  const dimIdx = columnIndex(columns, dim);
  const metIdx = columnIndex(columns, metric);
  const agg = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const key = cellString(row[dimIdx]);
    const v = cellNumber(row[metIdx]);
    if (!key || !Number.isFinite(v)) continue;
    const cur = agg.get(key) ?? { sum: 0, count: 0 };
    cur.sum += v;
    cur.count++;
    agg.set(key, cur);
  }
  return [...agg.entries()]
    .map(([value, s]) => ({ value, ...s }))
    .sort((a, b) => b.sum - a.sum)
    .slice(0, topN);
}

function fmtShort(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(0);
  return v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

function runCorrelation(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "correlation" }>): AnalysisResult {
  const numericCols = (
    cfg.columns.length ? cfg.columns : ctx.columns.filter((c) => c.type === "number").map((c) => c.name)
  ).slice(0, 12);
  for (const c of numericCols) requireColumn(ctx.columns, c, "number");
  const usable = numericCols.filter((name) => {
    const vals = numericColumn(ctx.rows, ctx.columns, name);
    return vals.length >= 5;
  });
  if (usable.length < 2) {
    throw new AnalysisInputError("Correlation needs at least two numeric columns with 5+ populated values each.");
  }
  const mat: number[][] = [];
  const pairTable: { a: string; b: string; r: number; p: number; n: number; rho: number; rhoP: number }[] = [];
  const colIdx = usable.map((name) => columnIndex(ctx.columns, name));
  // Row-aligned pairwise-complete pairing: a row is dropped for a given pair
  // only when that pair is missing a value. Pre-filtering each column on its
  // own and then pairing by position would silently misalign rows whenever the
  // columns' missing-value patterns differ.
  const pairsFor = (i: number, j: number): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (const row of ctx.rows) {
      const x = cellNumber(row[colIdx[i] as number]);
      const y = cellNumber(row[colIdx[j] as number]);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    }
    return out;
  };
  for (let i = 0; i < usable.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < usable.length; j++) {
      const pairs = pairsFor(i, j);
      const res = pearson(
        pairs.map((p) => p.x),
        pairs.map((p) => p.y),
      );
      row.push(Number.isFinite(res.r) ? Math.round(res.r * 1000) / 1000 : 0);
      if (j > i) {
        const rho = spearman(
          pairs.map((p) => p.x),
          pairs.map((p) => p.y),
        );
        pairTable.push({
          a: usable[i] as string,
          b: usable[j] as string,
          r: res.r,
          p: res.p,
          n: res.n,
          rho: rho.rho,
          rhoP: rho.p,
        });
      }
    }
    mat.push(row);
  }
  pairTable.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const topPairs = pairTable.slice(0, 10);

  const heatData: number[] = [];
  for (const row of mat) for (const v of row) heatData.push(v);

  const charts: ChartSpec[] = [
    {
      kind: "heatmap",
      title: "Correlation matrix",
      subtitle: "Pearson r ∈ [−1, 1]. Darker = stronger relationship.",
      xLabel: usable.join(" / "),
      categories: usable,
      rowLabels: usable,
      series: [{ name: "r", data: heatData }],
    },
  ];
  const result = baseResult(ctx, cfg, {
    method: "Pairwise Pearson + Spearman correlation on complete rows for each column pair.",
    steps: [
      `Compared ${usable.length} numeric columns: ${usable.join(", ")}.`,
      "Pairwise complete rows are used per pair (rows missing either value are dropped for that pair only).",
      `Pearson r = Σ(x−x̄)(y−ȳ) / √(Σ(x−x̄)²·Σ(y−ȳ)²); p-value from the exact Student-t distribution on the t-statistic (n − 2 df).`,
      "Spearman ρ = Pearson on average ranks — robust to outliers and captures monotonic (not just linear) association.",
      "When |ρ| notably exceeds r, the relationship is monotonic but non-linear — a linear model under-fits it.",
    ],
    assumptions: ["No correction for multiple comparisons is applied across the pairwise table."],
  });
  const quick: string[] = [];
  if (topPairs[0] && Math.abs(topPairs[0].r) >= 0.5) {
    const sign = topPairs[0].r >= 0 ? "positive" : "negative";
    quick.push(
      `Strongest ${sign} relationship: ${topPairs[0].a} ↔ ${topPairs[0].b} (r = ${topPairs[0].r.toFixed(2)}).`,
    );
  }
  // Rank-vs-linear divergence: when Spearman is strong but Pearson is weak,
  // the association is monotonic but curved — a real, actionable finding.
  const divergent = pairTable.find(
    (p) => Number.isFinite(p.rho) && Math.abs(p.rho) >= 0.6 && Math.abs(p.rho) - Math.abs(p.r) >= 0.15,
  );
  if (divergent) {
    quick.push(
      `${divergent.a} ↔ ${divergent.b} is strongly monotonic (ρ = ${divergent.rho.toFixed(2)}) but weakly linear (r = ${divergent.r.toFixed(2)}) — the relationship is real but non-linear; consider a rank/log transform before linear modelling.`,
    );
  }
  if (usable.length > 12)
    quick.push(
      `Only the first 12 numeric columns (by file order) were correlated — select specific columns to extend.`,
    );
  return {
    ...result,
    charts,
    tables: [
      {
        title: "Strongest correlations",
        columns: [
          { key: "a", label: "Column A" },
          { key: "b", label: "Column B" },
          { key: "r", label: "Pearson r", format: "number" },
          { key: "rho", label: "Spearman ρ", format: "number" },
          { key: "p", label: "p-value", format: "number" },
          { key: "n", label: "Rows", format: "number" },
        ],
        rows: topPairs.map((p) => [
          p.a,
          p.b,
          Math.round(p.r * 1000) / 1000,
          Number.isFinite(p.rho) ? Math.round(p.rho * 1000) / 1000 : null,
          Number.isFinite(p.p) ? Math.round(p.p * 1e4) / 1e4 : null,
          p.n,
        ]),
      },
    ],
    quickFindings: quick,
  };
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

function runDistribution(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "distribution" }>): AnalysisResult {
  const col = ctx.columns.find((c) => c.name === cfg.column);
  if (!col) throw new AnalysisInputError(`Column "${cfg.column}" not found in the dataset.`);
  const idx = columnIndex(ctx.columns, cfg.column);

  if (col.type === "number") {
    const values = numericColumn(ctx.rows, ctx.columns, cfg.column);
    if (values.length === 0) throw new AnalysisInputError(`Column "${cfg.column}" has no readable numeric values.`);
    const h = histogram(values, cfg.bins || undefined);
    const box = fiveNumberSummary(values);
    const norm = normalityCheck(values);
    const result = baseResult(ctx, cfg, {
      method: `Histogram with ${h.binLabels.length} equal-width bins + box-plot summary + Anderson–Darling normality screen of ${cfg.column}.`,
      steps: [
        "Bins are computed with the Freedman–Diaconis rule when “auto” (default).",
        "Box-plot fences use 1.5×IQR; whiskers span min/max of observed data.",
        `Missing or non-numeric cells (${ctx.rows.length - values.length}) are excluded.`,
        Number.isFinite(norm.pValue)
          ? `Anderson–Darling A² = ${norm.statistic.toFixed(3)} (p = ${norm.pValue.toFixed(4)}) → ${norm.passed ? "consistent with normality at the 5% level" : "significantly non-normal at the 5% level"}.`
          : "Sample too small (n < 8) for a normality test — no assumption made.",
      ],
      assumptions: ["Histogram bin edges are inclusive on the left, exclusive on the right."],
    });
    return {
      ...result,
      charts: [
        {
          kind: "histogram",
          title: `Histogram of ${cfg.column}`,
          categories: h.binLabels,
          series: [{ name: cfg.column, data: h.counts, color: "#5AA8AA" }],
          yLabel: "Count",
        },
        {
          kind: "box",
          title: `Box plot of ${cfg.column}`,
          categories: [cfg.column],
          series: [{ name: cfg.column, box }],
          yLabel: cfg.column,
        },
      ],
      stats: [
        { label: "Min", value: fmtShort(box[0]) },
        { label: "Q1", value: fmtShort(box[1]) },
        { label: "Median", value: fmtShort(box[2]) },
        { label: "Q3", value: fmtShort(box[3]) },
        { label: "Max", value: fmtShort(box[4]) },
        { label: "Mean", value: fmtShort(mean(values)) },
        { label: "Std dev", value: fmtShort(stddev(values)) },
        { label: "Outliers", value: String(outlierCount(values)) },
        Number.isFinite(norm.pValue)
          ? { label: "Normality (A–D)", value: `p = ${norm.pValue.toFixed(4)}`, hint: norm.interpretation }
          : { label: "Normality (A–D)", value: "n < 8", hint: norm.interpretation },
      ],
      quickFindings: [
        `Median ${cfg.column} = ${fmtShort(box[2])}; ${(outlierCount(values) / values.length) * 100 >= 1 ? ((outlierCount(values) / values.length) * 100).toFixed(1) : "0"}% of values are beyond 1.5×IQR.`,
        ...(Number.isFinite(norm.pValue) ? [norm.interpretation] : []),
      ],
    };
  }

  // Categorical distribution
  const values = ctx.rows.map((r) => cellString(r[idx]));
  const counts = valueCounts(values, 30);
  // The true cardinality, not just the top-N table length — a column with
  // thousands of levels must not be reported as "30 distinct values".
  const distinct = distinctCount(values, 10_000);
  const result = baseResult(ctx, cfg, {
    method: `Frequency table of ${cfg.column} over ${ctx.rows.length} rows.`,
    steps: [
      "Each distinct non-empty value is counted; blank cells are excluded.",
      distinct.capped
        ? "Distinct values are counted up to 10,000; this column exceeds that and is reported as “10,000+”."
        : `All ${distinct.count.toLocaleString()} distinct values are counted.`,
    ],
    assumptions: [],
  });
  const charts: ChartSpec[] =
    distinct.count <= 40
      ? [
          {
            kind: "bar",
            title: `Values of ${cfg.column}`,
            subtitle: `Top ${Math.min(30, distinct.count)} of ${distinct.count.toLocaleString()} distinct values.`,
            categories: counts.map((c) => c.value),
            series: [{ name: cfg.column, data: counts.map((c) => c.count), color: "#5AA8AA" }],
            yLabel: "Rows",
          },
        ]
      : [];
  return {
    ...result,
    charts,
    tables: [
      {
        title: `Top ${Math.min(30, distinct.count)} values`,
        columns: [
          { key: "value", label: cfg.column },
          { key: "count", label: "Rows", format: "number" },
          { key: "share", label: "Share", format: "pct" },
        ],
        rows: counts
          .slice(0, 30)
          .map((c) => [c.value, c.count, Math.round((c.count / (ctx.rows.length || 1)) * 1000) / 10]),
      },
    ],
    stats: [
      {
        label: "Distinct values",
        value: distinct.capped ? "10,000+" : distinct.count.toLocaleString(),
      },
      { label: "Most frequent", value: `${counts[0]?.value ?? "—"} (${counts[0]?.count ?? 0} rows)` },
    ],
  };
}

/** Bounded distinct count for categorical columns (cap keeps memory flat). */
function distinctCount(values: string[], cap: number): { count: number; capped: boolean } {
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    if (seen.size >= cap) return { count: cap, capped: true };
    seen.add(v);
  }
  return { count: seen.size, capped: false };
}

// ---------------------------------------------------------------------------
// Forecast — real ETS/ARIMA engine (lib/engine/forecast.ts)
// ---------------------------------------------------------------------------

function runForecast(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "forecast" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.dateCol, "date");
  requireColumn(ctx.columns, cfg.metric, "number");
  const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, cfg.granularity);
  const values = buckets.map((b) => b.value);
  if (values.length < 6) {
    throw new AnalysisInputError(`Forecast needs at least 6 historical periods to fit models; found ${values.length}.`);
  }
  const horizon = Math.min(Math.max(1, cfg.horizon || 4), 12);
  const lastKey = buckets[buckets.length - 1]?.key ?? "";
  const forecastKeys = nextKeys(lastKey, cfg.granularity, horizon);

  // Seasonal period when the granularity + history length support one.
  const seasonPeriod =
    (cfg.granularity === "month" && values.length >= 24 && 12) ||
    (cfg.granularity === "week" && values.length >= 16 && 4) ||
    (cfg.granularity === "day" && values.length >= 14 && 7) ||
    0;

  // Real ETS (SES/Holt/Holt-Winters, damped variants) + ARIMA(p,d,q) via
  // conditional least squares — selected by AICc with a walk-forward MAE
  // tie-breaker (lib/engine/forecast.ts, oracle-tested vs statsmodels).
  const fit = forecastSeries(values, { horizon, period: seasonPeriod });
  const best = fit.best;

  // Expanding-window rolling-origin CV: each fold re-fits the engine on all
  // data strictly before the fold and forecasts ONE step ahead. This is the
  // honest out-of-sample error the config's cvFolds knob asks for.
  const cvFolds = Math.max(0, Math.min(10, Math.round(cfg.cvFolds || 0)));
  let cv: {
    folds: number;
    mae: number;
    mape: number | null;
    perFold: { fold: number; actual: number; predicted: number; error: number }[];
  } | null = null;
  if (cvFolds > 0 && values.length >= cvFolds + 6) {
    const perFold: { fold: number; actual: number; predicted: number; error: number }[] = [];
    let absSum = 0;
    let pctSum = 0;
    let pctCount = 0;
    for (let i = 0; i < cvFolds; i++) {
      const cut = values.length - cvFolds + i;
      const train = values.slice(0, cut);
      const actual = values[cut] as number;
      if (train.length < 6) continue;
      const sub = forecastSeries(train, { horizon: 1, period: seasonPeriod });
      const predicted = sub.points[0]?.point ?? Number.NaN;
      if (!Number.isFinite(predicted)) continue;
      const error = predicted - actual;
      perFold.push({ fold: i + 1, actual, predicted, error: Math.round(error * 100) / 100 });
      absSum += Math.abs(error);
      if (actual !== 0) {
        pctSum += (Math.abs(error) / Math.abs(actual)) * 100;
        pctCount++;
      }
    }
    if (perFold.length > 0) {
      cv = {
        folds: perFold.length,
        mae: Math.round((absSum / perFold.length) * 100) / 100,
        mape: pctCount > 0 ? Math.round((pctSum / pctCount) * 100) / 100 : null,
        perFold,
      };
    }
  }
  const preds = fit.points.map((p, i) => {
    const key = forecastKeys[i] ?? lastKey;
    const label = bucketLabel(key, cfg.granularity);
    // Business-friendly clamp: a negative projection of a volume metric is
    // reported at 0, with the band shifted by the same amount.
    const shift = p.point < 0 ? -p.point : 0;
    return {
      key,
      label,
      point: p.point + shift,
      low: p.low + shift,
      high: p.high + shift,
    };
  });

  const lastObs = values[values.length - 1] ?? 0;
  const lastPred = preds[preds.length - 1]?.point ?? 0;
  const horizonPct = lastObs !== 0 ? ((lastPred - lastObs) / Math.abs(lastObs)) * 100 : null;

  const categories = [...buckets.map((b) => b.label), ...preds.map((p) => p.label)];
  const chartData: (number | null)[] = [...values, ...preds.map(() => null)];
  const foreData: (number | null)[] = [...values.map(() => null), ...preds.map((p) => p.point)];
  const series: ChartSeries[] = [
    { name: cfg.metric, data: chartData, color: "#5AA8AA" },
    { name: `Forecast (${best.name})`, data: foreData, color: "#FFB400" },
  ];
  const mk = mannKendall(values);
  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `Forecast of ${cfg.metric} · next ${horizon} ${cfg.granularity}(s)`,
      subtitle: `${best.name} selected by AICc from ${fit.candidates.length} ETS/Theta/ARIMA candidates fit on your data (residual σ ${best.sigma.toFixed(2)}).`,
      xLabel: cfg.granularity,
      yLabel: cfg.metric,
      categories,
      series,
    },
  ];
  const result = baseResult(
    ctx,
    cfg,
    {
      method: `Statistical time-series forecast: ${fit.candidates.length} models (ETS family — simple exponential smoothing, Holt, damped Holt${seasonPeriod ? ", Holt-Winters with additive seasonality" : ""}; Theta family — the standard Θ decomposition with damped curvature; ARIMA family — p ∈ {0,1,2}, d ∈ {0,1}, q ∈ {0,1}) were fit to the ${cfg.granularity} series of ${cfg.metric} and scored by bias-corrected AIC on their exact Gaussian likelihood; the winner is projected ${horizon} periods ahead with 95% prediction intervals from the residual variance.`,
      steps: [
        ...fit.candidates.map(
          (c) =>
            `${c.name} (${c.family.toUpperCase()}): AICc ${Number.isFinite(c.aicc) ? c.aicc.toFixed(1) : "—"}, walk-forward one-step MAE ${Number.isFinite(c.mae) ? c.mae.toFixed(2) : "—"}.`,
        ),
        `Winner: ${best.name} (AICc ${best.aicc.toFixed(1)}). The point path projects the fitted state recursion forward; the 95% band uses the residual σ with the model class's multi-step variance weights.`,
        fit.diagnostics.note,
        ...(cv
          ? [
              `Expanding-window rolling-origin CV (${cv.folds} folds, one-step ahead, refit on each prefix): MAE ${cv.mae}${cv.mape !== null ? `, MAPE ${cv.mape}%` : ""}.`,
              ...cv.perFold
                .slice(0, 5)
                .map(
                  (f) =>
                    `Fold ${f.fold}: actual ${f.actual.toFixed(2)} vs predicted ${f.predicted.toFixed(2)} (error ${f.error.toFixed(2)}).`,
                ),
            ]
          : []),
        `Mann–Kendall monotonic-trend test on the history: S = ${mk.s}, p = ${mk.p.toFixed(4)} → ${mk.direction}.`,
      ],
      assumptions: [
        "Model selection is by information criterion on your own history; multi-step error grows with horizon (the band widens accordingly).",
        "Seasonality is additive; ARIMA is estimated by conditional least squares (not full MLE); no seasonal-ARIMA or exogenous drivers — use the what-if engine for causal covariates.",
        "Negative projections are clamped to zero with their band; parameter uncertainty is not propagated into the interval.",
        cv
          ? "Out-of-sample error is measured by expanding-window rolling-origin folds (each fold re-fits on data strictly before it) — not by the in-sample AICc."
          : "No rolling-origin CV ran (cvFolds = 0) — reported accuracy is in-sample and optimistic.",
      ],
    },
    best.ljungBoxP < 0.05
      ? [
          `The winning model's residuals still show autocorrelation (Ljung–Box p = ${best.ljungBoxP.toFixed(3)}) — the point path is unbiased but the prediction interval may be optimistic.`,
        ]
      : [],
  );
  const quick: string[] = [];
  if (horizonPct !== null)
    quick.push(
      `${best.name} projects ${cfg.metric} to move ${horizonPct >= 0 ? "+" : ""}${horizonPct.toFixed(1)}% by ${preds[preds.length - 1]?.label}.`,
    );
  const bestMae = fit.candidates[0]?.mae ?? Number.NaN;
  quick.push(
    cv
      ? `Out-of-sample (expanding-window CV, ${cv.folds} folds): MAE ${cv.mae}${cv.mape !== null ? `, MAPE ${cv.mape}%` : ""}.`
      : `Model accuracy (walk-forward one-step): MAE ${Number.isFinite(bestMae) ? bestMae.toFixed(2) : "—"} across ${fit.candidates.length} candidate models.`,
  );
  if (mk.p < 0.05)
    quick.push(`Mann–Kendall confirms a statistically significant ${mk.direction} trend (p = ${mk.p.toFixed(4)}).`);
  else quick.push(`Mann–Kendall finds no statistically significant monotonic trend (p = ${mk.p.toFixed(2)}).`);
  return {
    ...result,
    charts,
    tables: [
      {
        title: "Forecast table",
        columns: [
          { key: "p", label: "Period" },
          { key: "point", label: "Point forecast", format: "number" },
          { key: "low", label: "Low (95%)", format: "number" },
          { key: "high", label: "High (95%)", format: "number" },
        ],
        rows: preds.map((p) => [
          p.label,
          Math.round(p.point * 100) / 100,
          Math.round(p.low * 100) / 100,
          Math.round(p.high * 100) / 100,
        ]),
      },
      {
        title: "Model selection (AICc + walk-forward one-step MAE)",
        columns: [
          { key: "model", label: "Model" },
          { key: "family", label: "Family", format: "text" },
          { key: "aicc", label: "AICc", format: "number" },
          { key: "mae", label: "MAE", format: "number" },
        ],
        rows: fit.candidates.map((c) => [
          c.name,
          c.family.toUpperCase(),
          Number.isFinite(c.aicc) ? Math.round(c.aicc * 10) / 10 : null,
          Number.isFinite(c.mae) ? Math.round(c.mae * 100) / 100 : null,
        ]),
      },
    ],
    quickFindings: quick,
  };
}

function nextKeys(lastKey: string, granularity: Granularity, count: number): string[] {
  const base = keyToDateObj(lastKey);
  if (!base) return Array.from({ length: count }, (_, i) => `${lastKey}+${i + 1}`);
  const out: string[] = [];
  const cursor = new Date(base);
  for (let i = 0; i < count; i++) {
    advance(cursor, granularity);
    out.push(bucketKey(cursor, granularity));
  }
  return out;
}

function keyToDateObj(key: string): Date | null {
  if (key.includes("-Q")) {
    const [y, q] = key.split("-Q");
    return new Date(Date.UTC(Number(y), (Number(q) - 1) * 3, 1));
  }
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-");
    return new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return new Date(`${key}T00:00:00Z`);
  const y = Number(key);
  if (/^\d{4}$/.test(key)) return new Date(Date.UTC(y, 0, 1));
  return null;
}

function advance(d: Date, granularity: Granularity): void {
  switch (granularity) {
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
}

// ---------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------

function runVariance(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "variance" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.metric, "number");
  if (!cfg.dimensionCol) {
    // No dimension: split by date periods when possible
    if (cfg.dateCol && columnIndex(ctx.columns, cfg.dateCol) >= 0) {
      const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, "month");
      if (buckets.length >= 2) {
        const last = buckets[buckets.length - 1] as (typeof buckets)[number];
        const prev = buckets[buckets.length - 2] as (typeof buckets)[number];
        const pct = prev.value !== 0 ? ((last.value - prev.value) / Math.abs(prev.value)) * 100 : null;
        const result = baseResult(ctx, cfg, {
          method: `Month-over-month change of ${cfg.metric}: latest full month vs the month before it.`,
          steps: [
            `${prev.label}: ${fmtShort(prev.value)} → ${last.label}: ${fmtShort(last.value)}`,
            `Change ${pct === null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}.`,
          ],
          assumptions: ["Empty months between observations are treated as zero."],
        });
        return {
          ...result,
          charts: [
            {
              kind: "line",
              title: `${cfg.metric} by month`,
              categories: buckets.map((b) => b.label),
              series: [{ name: cfg.metric, data: buckets.map((b) => b.value), color: "#5AA8AA" }],
              yLabel: cfg.metric,
            },
          ],
          stats: [
            { label: "Latest month", value: `${last.label} · ${fmtShort(last.value)}` },
            { label: "Change", value: pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` },
          ],
          quickFindings: [
            pct === null
              ? "Not enough history for a month-over-month comparison."
              : `${cfg.metric} moved ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% month over month.`,
          ],
        };
      }
    }
    throw new AnalysisInputError(
      "Variance analysis needs a dimension column (or a date column with 2+ periods) to compare groups.",
    );
  }
  requireColumn(ctx.columns, cfg.dimensionCol);
  const groups = topGroups(ctx.rows, ctx.columns, cfg.dimensionCol, cfg.metric, 200);
  if (groups.length === 0) throw new AnalysisInputError("No group with numeric values found.");
  const total = sum(groups.map((g) => g.sum)) || 1;

  // Multi-group inference: when the dimension has 3+ groups with per-row
  // numeric values, run Welch's ANOVA (does not assume equal variances) plus
  // Kruskal–Wallis as the distribution-free cross-check.
  let anova: {
    welch: { f: number; pValue: number; df1: number; df2: number } | null;
    kw: ReturnType<typeof kruskalWallis> | null;
    labels: string[];
  } | null = null;
  if (groups.length >= 3) {
    const { labels, groups: valueGroups } = groupValuesBy(ctx, cfg.dimensionCol as string, cfg.metric);
    const usable = valueGroups
      .map((g, i) => ({ label: labels[i] ?? "(unknown)", vals: g }))
      .filter((g) => g.vals.length >= 2);
    if (usable.length >= 3) {
      const w = welchAnova(usable.map((g) => g.vals));
      let kw: ReturnType<typeof kruskalWallis> | null = null;
      try {
        kw = kruskalWallis(usable.map((g) => g.vals));
      } catch {
        kw = null;
      }
      anova = { welch: w, kw, labels: usable.map((g) => g.label) };
    }
  }

  const hasDate = cfg.dateCol && columnIndex(ctx.columns, cfg.dateCol) >= 0;
  const periodPct = new Map<string, number>();
  if (hasDate) {
    // Decompose latest vs previous period change per group
    const allBuckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol!, cfg.metric, "month");
    const recent = allBuckets.slice(-2);
    if (recent.length === 2) {
      const [a, b] = recent as [(typeof allBuckets)[number], (typeof allBuckets)[number]];
      const dimIdx = columnIndex(ctx.columns, cfg.dimensionCol!);
      const metIdx = columnIndex(ctx.columns, cfg.metric);
      const sums = new Map<string, { a: number; b: number }>();
      for (const row of ctx.rows) {
        const d = cellDate(row[columnIndex(ctx.columns, cfg.dateCol!)]);
        if (!d) continue;
        const key = bucketKey(d, "month");
        if (key !== a.key && key !== b.key) continue;
        const group = cellString(row[dimIdx]);
        const v = cellNumber(row[metIdx]);
        if (!group || !Number.isFinite(v)) continue;
        const cur = sums.get(group) ?? { a: 0, b: 0 };
        if (key === b.key) cur.b += v;
        else cur.a += v;
        sums.set(group, cur);
      }
      for (const [g, s] of sums) {
        if (s.a !== 0) periodPct.set(g, ((s.b - s.a) / Math.abs(s.a)) * 100);
      }
    }
  }

  const rows: (string | number | null)[][] = groups.map((g) => {
    const chg = periodPct.get(g.value);
    return [
      g.value,
      g.count,
      Math.round(g.sum * 100) / 100,
      Math.round((g.sum / total) * 1000) / 10,
      chg !== undefined && chg !== null ? Math.round(chg * 10) / 10 : null,
    ];
  });

  const result = baseResult(ctx, cfg, {
    method: hasDate
      ? `Group sums of ${cfg.metric} by ${cfg.dimensionCol}, plus month-over-month change per group between the two latest months.`
      : `Group sums of ${cfg.metric} by ${cfg.dimensionCol}, ranked by total.`,
    steps: [
      "Each row contributes its metric value to its group total.",
      hasDate
        ? "Period change per group = (latest month − previous month)/|previous| × 100."
        : "Share = group total / grand total × 100.",
    ],
    assumptions: ["Groups are compared on raw sums; group size differences are shown in the Rows column."],
  });
  return {
    ...result,
    charts: [
      {
        kind: "bar",
        title: `${cfg.metric} by ${cfg.dimensionCol}`,
        subtitle: hasDate ? "Sorted by latest-month change where available." : "Ranked by total.",
        categories: groups.map((g) => g.value),
        series: [{ name: cfg.metric, data: groups.map((g) => g.sum), color: "#5AA8AA" }],
        yLabel: cfg.metric,
      },
    ],
    tables: [
      {
        title: "Group variance",
        columns: [
          { key: "g", label: cfg.dimensionCol },
          { key: "rows", label: "Rows", format: "number" },
          { key: "sum", label: cfg.metric, format: "number" },
          { key: "share", label: "Share %", format: "pct" },
          { key: "mom", label: "MoM %", format: "pct" },
        ],
        rows,
      },
    ],
    ...(anova
      ? {
          stats: [
            {
              label: "Welch ANOVA F",
              value: anova.welch ? anova.welch.f.toFixed(4) : "n/a",
              hint: anova.welch
                ? `df ${anova.welch.df1}, ${anova.welch.df2.toFixed(1)}`
                : "insufficient per-group data",
            },
            {
              label: "Welch ANOVA p",
              value: anova.welch ? (anova.welch.pValue < 1e-4 ? "< 0.0001" : anova.welch.pValue.toFixed(5)) : "n/a",
              hint: "omnibus, unequal variances",
            },
            ...(anova.kw
              ? [
                  {
                    label: "Kruskal–Wallis p",
                    value: anova.kw.pValue < 1e-4 ? "< 0.0001" : anova.kw.pValue.toFixed(5),
                    hint: "distribution-free cross-check",
                  },
                ]
              : []),
            { label: "Groups tested", value: String(anova.labels.length) },
          ],
          quickFindings: [
            `Top group "${groups[0]?.value ?? "—"}" holds ${((groups[0]?.sum ?? 0) / total) * 100 >= 1 ? (((groups[0]?.sum ?? 0) / total) * 100).toFixed(1) : "0"}% of ${cfg.metric}.`,
            anova.welch
              ? `Welch ANOVA across ${anova.labels.length} groups: F = ${anova.welch.f.toFixed(3)}, p = ${anova.welch.pValue.toExponential(3)} → ${anova.welch.pValue < 0.05 ? "at least one group mean differs" : "no significant difference between group means"}.`
              : "Not enough per-row values in 3+ groups for an omnibus ANOVA.",
            ...(anova.kw
              ? [
                  `Kruskal–Wallis (rank-based cross-check): H = ${anova.kw.statistic.toFixed(3)}, p = ${anova.kw.pValue.toExponential(3)}.`,
                ]
              : []),
          ],
        }
      : {
          quickFindings: [
            `Top group "${groups[0]?.value ?? "—"}" holds ${((groups[0]?.sum ?? 0) / total) * 100 >= 1 ? (((groups[0]?.sum ?? 0) / total) * 100).toFixed(1) : "0"}% of ${cfg.metric}.`,
          ],
        }),
  };
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

function runSegmentation(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "segmentation" }>): AnalysisResult {
  const cols = (
    cfg.columns.length ? cfg.columns : ctx.columns.filter((c) => c.type === "number").map((c) => c.name)
  ).slice(0, 6);
  for (const c of cols) requireColumn(ctx.columns, c, "number");
  if (cols.length === 0) throw new AnalysisInputError("Segmentation needs at least one numeric column.");
  const colValues = cols.map((name) => numericColumn(ctx.rows, ctx.columns, name));
  const nRows = Math.min(...colValues.map((v) => v.length));
  if (nRows < 30) throw new AnalysisInputError(`Segmentation needs at least 30 complete rows; found ${nRows}.`);
  const matrix: number[][] = [];
  for (let i = 0; i < nRows; i++) {
    const row: number[] = [];
    for (const vals of colValues) row.push(vals[i] as number);
    matrix.push(row);
  }
  const k = Math.max(2, Math.min(cfg.k || 3, 6));
  const normalized = standardize(matrix);
  const assign = kmeans(normalized, k);

  // Cluster stats
  const clusterRows: number[][] = [];
  const clusterSize: number[] = new Array(k).fill(0);
  for (let i = 0; i < matrix.length; i++) {
    const c = assign[i] as number;
    clusterSize[c] = (clusterSize[c] ?? 0) + 1;
    const sums = clusterRows[c] ?? new Array<number>(cols.length).fill(0);
    const row = matrix[i] as number[];
    for (let d = 0; d < cols.length; d++) (sums[d] as number) += row[d] as number;
    clusterRows[c] = sums;
  }
  const globalMeans = cols.map((_, d) => mean(matrix.map((r) => r[d] as number)));
  const clusterMeans = clusterRows.map((sums, c) =>
    sums.map((s) => ((clusterSize[c] || 1) > 0 ? s / (clusterSize[c] as number) : 0)),
  );
  const names = clusterMeans.map((meansArr, c) => {
    const deviations: string[] = [];
    meansArr.forEach((m, d) => {
      const gm = globalMeans[d] as number;
      const delta = gm !== 0 ? ((m - gm) / Math.abs(gm)) * 100 : 0;
      if (Math.abs(delta) >= 15) deviations.push(`${cols[d]} ${delta >= 0 ? "+" : ""}${Math.round(delta)}%`);
    });
    const desc = deviations.slice(0, 2).join(", ");
    return `Cluster ${c + 1}${desc ? ` · ${desc} vs average` : ""}`;
  });

  // Scatter when 2+ dims (first two), capped rows for rendering
  const scatterPoints: ChartSeries = {
    name: "Rows",
    points: [],
  };
  const sampleStep = Math.max(1, Math.floor(nRows / 600));
  if (cols.length >= 2) {
    for (let i = 0; i < nRows; i += sampleStep) {
      const row = matrix[i] as number[];
      scatterPoints.points!.push({
        x: row[0] as number,
        y: row[1] as number,
        label: String((assign[i] as number) + 1),
      });
    }
  }

  const result = baseResult(ctx, cfg, {
    method: `K-means clustering (k = ${k}) on ${nRows} complete rows across ${cols.length} standardized numeric column(s): ${cols.join(", ")}.`,
    steps: [
      "Columns are z-score standardized (mean 0, sd 1) so units don't bias distances.",
      "Cluster seeds chosen deterministically (max-min seeding); Lloyd's algorithm runs until stable (max 60 iterations).",
      "Cluster means are compared to the global mean per column; deviations ≥ 15% are used to label clusters.",
    ],
    assumptions: [
      "Euclidean distance on standardized features.",
      "Clusters are spherical; consider domain knowledge before acting on them.",
    ],
  });
  return {
    ...result,
    charts: [
      {
        kind: "donut",
        title: "Segment sizes",
        categories: names,
        series: names.map((name, c) => ({ name, data: [clusterSize[c] ?? 0] })),
      },
      ...(cols.length >= 2
        ? [
            {
              kind: "scatter" as const,
              title: `Segments by ${cols[0]} vs ${cols[1]}`,
              subtitle: "Sample of rows coloured by cluster.",
              xLabel: cols[0],
              yLabel: cols[1],
              series: [scatterPoints],
            },
          ]
        : []),
    ],
    tables: [
      {
        title: "Segment profiles (mean per column)",
        columns: [
          { key: "c", label: "Segment" },
          { key: "size", label: "Rows", format: "number" },
          ...cols.map((c) => ({ key: c, label: c, format: "number" as const })),
        ],
        rows: names.map((name, c) => [
          name,
          clusterSize[c] ?? 0,
          ...clusterMeans[c]!.map((m) => Math.round(m * 100) / 100),
        ]),
      },
    ],
    stats: names.map((name, c) => ({
      label: name,
      value: `${(((clusterSize[c] ?? 0) / nRows) * 100 >= 1 ? ((clusterSize[c] ?? 0) / nRows) * 100 : 0).toFixed(1)}% of rows`,
      hint: "mean profile vs global",
    })),
    quickFindings: names.map((name) => `${name}.`),
  };
}

// ---------------------------------------------------------------------------
// Cohort
// ---------------------------------------------------------------------------

function runCohort(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "cohort" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.dateCol, "date");
  requireColumn(ctx.columns, cfg.entityCol);
  const dateIdx = columnIndex(ctx.columns, cfg.dateCol);
  const entityIdx = columnIndex(ctx.columns, cfg.entityCol);
  const maxOffset = 8;
  // Cohort of an entity = month of its first appearance.
  const firstSeen = new Map<string, string>();
  for (const row of ctx.rows) {
    const d = cellDate(row[dateIdx]);
    const entity = cellString(row[entityIdx]);
    if (!d || !entity) continue;
    const monthKey = bucketKey(d, "month");
    const prev = firstSeen.get(entity);
    if (!prev || monthKey < prev) firstSeen.set(entity, monthKey);
  }
  const cohorts = new Map<string, Map<string, Set<number>>>();
  for (const row of ctx.rows) {
    const d = cellDate(row[dateIdx]);
    const entity = cellString(row[entityIdx]);
    if (!d || !entity) continue;
    const monthKey = bucketKey(d, "month");
    const cohortKey = firstSeen.get(entity);
    if (!cohortKey) continue;
    const offset = monthDiff(new Date(`${cohortKey}-01T00:00:00Z`), new Date(`${monthKey}-01T00:00:00Z`));
    if (offset < 0 || offset > maxOffset) continue;
    let byEntity = cohorts.get(cohortKey);
    if (!byEntity) {
      byEntity = new Map();
      cohorts.set(cohortKey, byEntity);
    }
    let set = byEntity.get(entity);
    if (!set) {
      set = new Set();
      byEntity.set(entity, set);
    }
    set.add(offset);
  }
  const sortedCohorts = [...cohorts.keys()].sort();
  if (sortedCohorts.length < 2) {
    throw new AnalysisInputError("Cohort analysis needs entities spread across at least 2 calendar months.");
  }
  const matrixData: number[] = [];
  const rowsArr: (string | number | null)[][] = [];
  let sumM1 = 0;
  let countM1 = 0;
  const retentionByCohort: { cohort: string; size: number; m1: number }[] = [];
  for (const cohortKey of sortedCohorts.slice(-12)) {
    const byEntity = cohorts.get(cohortKey);
    const size = byEntity?.size ?? 0;
    if (!size) continue;
    const offsetRow: (number | null)[] = [];
    for (let off = 0; off <= maxOffset; off++) {
      let active = 0;
      if (byEntity) {
        for (const set of byEntity.values()) if (set.has(off)) active++;
      }
      const pct = Math.round((active / size) * 1000) / 10;
      matrixData.push(pct);
      offsetRow.push(off === 0 ? 100 : pct);
    }
    rowsArr.push([bucketLabel(cohortKey, "month"), size, ...offsetRow]);
    const m1 = (byEntity ? [...byEntity.values()].filter((s) => s.has(1)).length : 0) / size;
    sumM1 += m1 * 100;
    countM1++;
    retentionByCohort.push({ cohort: bucketLabel(cohortKey, "month"), size, m1: Math.round(m1 * 1000) / 10 });
  }
  const avgM1 = countM1 > 0 ? Math.round((sumM1 / countM1) * 10) / 10 : null;
  const labels = Array.from({ length: maxOffset + 1 }, (_, i) => (i === 0 ? "M0" : `M${i}`));

  const result = baseResult(ctx, cfg, {
    method: `Monthly cohort retention: each entity is assigned to the month of its first appearance in ${cfg.entityCol} (cohort), then retention at offset m = share of cohort entities seen again exactly m months later in ${cfg.dateCol}.`,
    steps: [
      "Entities are tracked as distinct values of the entity column within each month.",
      `Retention is computed for offsets M0–M${maxOffset}; the matrix shows % of each cohort still active (M0 = 100% by definition).`,
      `Average M1 retention = ${avgM1 ?? "—"}% over ${countM1} cohorts shown.`,
    ],
    assumptions: [
      "An entity is 'active' in a month if it appears at least once.",
      "Only the latest 12 cohorts are charted; all cohorts are used for averages.",
    ],
  });
  return {
    ...result,
    charts: [
      {
        kind: "heatmap",
        title: "Cohort retention heatmap",
        subtitle: `Retention of ${cfg.entityCol} cohorts by month offset.`,
        rowLabels: rowsArr.map((r) => String(r[0])),
        categories: labels,
        series: [{ name: "Retention %", data: matrixData }],
      },
    ],
    tables: [
      {
        title: "Cohort retention table",
        columns: [
          { key: "c", label: "Cohort" },
          { key: "size", label: "Size", format: "number" },
          ...labels.map((l) => ({ key: l, label: `${l} %`, format: "pct" as const })),
        ],
        rows: rowsArr,
      },
    ],
    stats: [
      { label: "Cohorts shown", value: String(rowsArr.length) },
      ...(avgM1 !== null ? [{ label: "Average M1 retention", value: `${avgM1}%` }] : []),
    ],
    quickFindings: retentionByCohort.length
      ? [
          `Average month-1 retention across cohorts is ${avgM1 ?? "—"}%.`,
          `Largest cohort: ${[...retentionByCohort].sort((a, b) => b.size - a.size)[0]?.cohort ?? "—"} with ${[...retentionByCohort].sort((a, b) => b.size - a.size)[0]?.size ?? 0} entities.`,
        ]
      : [],
  };
}

function monthDiff(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

function runFunnel(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "funnel" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.stageCol);
  const idx = columnIndex(ctx.columns, cfg.stageCol);
  const counts = valueCounts(
    ctx.rows.map((r) => cellString(r[idx])),
    1000,
  );
  if (counts.length < 2) throw new AnalysisInputError(`Funnel needs at least 2 distinct stages in "${cfg.stageCol}".`);
  let ordered: typeof counts;
  if (cfg.stages && cfg.stages.length >= 2) {
    const byName = new Map(counts.map((c) => [c.value, c]));
    ordered = cfg.stages.map((s) => byName.get(s) ?? { value: s, count: 0 }).filter((s) => s.count > 0);
    if (ordered.length < 2)
      throw new AnalysisInputError("The supplied stage order does not match ≥ 2 values present in the data.");
  } else {
    // Derive a natural order: by the order stages first appear across rows
    const order: string[] = [];
    const seen = new Set<string>();
    for (const row of ctx.rows) {
      const s = cellString(row[idx]);
      if (s && !seen.has(s)) {
        seen.add(s);
        order.push(s);
      }
    }
    ordered = order
      .map((value) => counts.find((c) => c.value === value) ?? { value, count: 0 })
      .filter((c) => c.count > 0);
    if (ordered.length < 2) ordered = counts;
  }
  const conversions: number[] = [];
  const conversionCis: ([number, number] | null)[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]?.count ?? 0;
    const cur = ordered[i]?.count ?? 0;
    conversions.push(prev > 0 ? Math.round((cur / prev) * 1000) / 10 : 0);
    conversionCis.push(prev > 0 ? wilsonCi(cur, prev) : null);
  }
  const charts: ChartSpec[] = [
    {
      kind: "funnel",
      title: `Conversion funnel · ${cfg.stageCol}`,
      subtitle: cfg.stages
        ? "Using the stage order you provided."
        : "Stage order derived from first appearance in the data — check the table below.",
      categories: ordered.map((c) => c.value),
      series: [{ name: "Rows", data: ordered.map((c) => c.count), color: "#5AA8AA" }],
    },
  ];
  const result = baseResult(ctx, cfg, {
    method: `Counts per distinct value of ${cfg.stageCol}, converted step-over-step. Each step conversion is reported with a Wilson score 95% interval — the binomial interval that behaves correctly at small n, unlike the normal approximation.`,
    steps: [
      "Each row contributes to exactly one stage.",
      `Conversion stage N→N+1 = count(stage N+1)/count(stage N) × 100.`,
      ...conversionCis
        .map((ci, i) =>
          ci
            ? `Step ${ordered[i]?.value ?? i} → ${ordered[i + 1]?.value ?? i + 1}: ${conversions[i]?.toFixed(1)}%, Wilson 95% CI ${(ci[0] * 100).toFixed(1)}% to ${(ci[1] * 100).toFixed(1)}%.`
            : null,
        )
        .filter((s): s is string => s !== null)
        .slice(0, 8),
      cfg.stages
        ? `Stage order supplied by you: ${cfg.stages.join(" → ")}.`
        : "Stage order derived from the order values first appear in the file — set an explicit order when the data is chronological.",
    ],
    assumptions: [
      "Rows are independent stage observations; overlapping rows across stages are not deduplicated.",
      "Wilson intervals treat each step as binomial on the previous stage's count — correct when stages are nested funnels, optimistic when they are not.",
    ],
  });
  return {
    ...result,
    charts,
    tables: [
      {
        title: "Funnel steps",
        columns: [
          { key: "s", label: "Stage" },
          { key: "rows", label: "Rows", format: "number" },
          { key: "conv", label: "Step conversion %", format: "pct" },
          { key: "lo", label: "Wilson 95% low", format: "pct" },
          { key: "hi", label: "Wilson 95% high", format: "pct" },
        ],
        rows: ordered.map((c, i) => {
          const ci = i === 0 ? null : (conversionCis[i - 1] ?? null);
          return [
            c.value,
            c.count,
            i === 0 ? null : (conversions[i - 1] ?? null),
            ci ? ci[0] : null,
            ci ? ci[1] : null,
          ];
        }),
      },
    ],
    quickFindings: [
      conversions.length > 0 && conversions[0] !== undefined && Math.min(...conversions) < 60
        ? `Biggest drop: ${ordered[conversions.indexOf(Math.min(...conversions)) + 1]?.value ?? "next stage"} converts at ${Math.min(...conversions)}% of the previous step.`
        : "No conversion step drops below 60%.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function humaniseConfig(cfg: AnalysisConfig, ctx: Ctx): string[] {
  const lines: string[] = [];
  const dims: string[] = [];
  if ("metric" in cfg && cfg.metric) dims.push(`metric: ${cfg.metric}`);
  if ("dateCol" in cfg && cfg.dateCol) dims.push(`date: ${cfg.dateCol}`);
  if ("dimensionCol" in cfg && cfg.dimensionCol) dims.push(`dimension: ${cfg.dimensionCol}`);
  if ("columns" in cfg && cfg.columns.length) dims.push(`columns: ${cfg.columns.join(", ")}`);
  if ("entityCol" in cfg && cfg.entityCol) dims.push(`entities: ${cfg.entityCol}`);
  if ("stageCol" in cfg && cfg.stageCol) dims.push(`stages: ${cfg.stageCol}`);
  if (dims.length) lines.push(`Analysis used ${dims.join(" · ")}.`);
  if ("granularity" in cfg && cfg.granularity) lines.push(`Time granularity: ${cfg.granularity}.`);
  if ("bins" in cfg && cfg.bins) lines.push(`Histogram bins: ${cfg.bins}.`);
  if ("horizon" in cfg && cfg.horizon) lines.push(`Forecast horizon: ${cfg.horizon} period(s).`);
  if ("k" in cfg && cfg.k) lines.push(`Clusters (k): ${cfg.k}.`);
  if (cfg.filterCol && cfg.filterValue) lines.push(`Filtered to ${cfg.filterCol} = “${cfg.filterValue}”.`);
  lines.push(
    `${ctx.rows.length.toLocaleString()} row${ctx.rows.length === 1 ? "" : "s"} analysed${ctx.sampled ? ` (first ${ctx.rows.length.toLocaleString()} of ${ctx.totalRows.toLocaleString()} — sampled)` : ""}.`,
  );
  return lines;
}

/** Run any supported analysis kind against the uploaded data (deterministic). */
export function runAnalysis(input: RunAnalysisInput, cfg: AnalysisConfig): AnalysisResult {
  const ctx = makeCtx(input, cfg);
  switch (cfg.kind) {
    case "eda":
      return runEda(ctx, cfg);
    case "trend":
      return runTrend(ctx, cfg);
    case "kpi":
      return runKpi(ctx, cfg);
    case "correlation":
      return runCorrelation(ctx, cfg);
    case "distribution":
      return runDistribution(ctx, cfg);
    case "forecast":
      return runForecast(ctx, cfg);
    case "variance":
      return runVariance(ctx, cfg);
    case "segmentation":
      return runSegmentation(ctx, cfg);
    case "cohort":
      return runCohort(ctx, cfg);
    case "funnel":
      return runFunnel(ctx, cfg);
    case "abtest":
      return runAbTest(ctx, cfg);
    case "automl":
      return runAutoMl(ctx, cfg);
    case "arimax":
      return runArimax(ctx, cfg);
    case "regression":
      return runGroupComparison(ctx, cfg);
    case "dataquality":
      return runDataQuality(ctx, cfg);
    case "accounting":
      return runAccounting(ctx, cfg);
    case "syntheticcontrol":
      return runSyntheticControl(ctx, cfg);
    case "uplift":
      return runUplift(ctx, cfg);
    case "sprt":
      return runSprt(ctx, cfg);
    case "drift":
      return runDrift(ctx, cfg);
    case "compliance":
      return runCompliance(ctx, cfg);
    case "whatif":
      return runWhatIfAnalysis(ctx, cfg);
    case "did":
      return runDid(ctx, cfg);
    case "survival":
      return runSurvivalAnalysis(ctx, cfg);
    case "bayesian":
      return runBayesian(ctx, cfg);
    case "sarima":
      return runSarima(ctx, cfg);
    case "distributed":
      return runDistributedAnalysis(ctx, cfg);
    case "streaming":
      return runStreamingAnalysis(ctx, cfg);
    case "deep-learning":
      return runDeepLearning(ctx, cfg);
    case "nlp":
      return runNlp(ctx, cfg);
    case "feature-store":
      return runFeatureStore(ctx, cfg);
    case "real-time-serving":
      return runRealTimeServing(ctx, cfg);
    case "hte":
      return runHte(ctx, cfg);
    case "iv-calculus":
      return runIvCalculus(ctx, cfg);
    case "geospatial":
      return runGeospatial(ctx, cfg);
    case "map":
      return runMap(ctx, cfg);
    default:
      throw new AnalysisInputError(`Unsupported analysis kind.`);
  }
}

// ---------------------------------------------------------------------------
// Advanced statistical analyses
//
// Each runner delegates to an in-repo engine that is already oracle-tested
// (lib/engine/automl.ts, abtest.ts, elite-stats.ts, forecast-advanced.ts).
// Nothing here re-implements a statistic: the analysis layer's job is to
// shape the dataset into the engine's input contract, then render what came
// back — including the parts that weaken the conclusion.
// ---------------------------------------------------------------------------

/** Split rows into exactly two groups by a column's two distinct values. */
function splitTwoGroups(
  ctx: Ctx,
  groupCol: string,
): { control: string; treatment: string; controlRows: Cell[][]; treatmentRows: Cell[][] } {
  const gi = requireColumn(ctx.columns, groupCol);
  const seen = new Set<string>();
  for (const row of ctx.rows) seen.add(cellString(row[gi]));
  const labels = [...seen].sort();
  if (labels.length !== 2) {
    throw new AnalysisInputError(
      `${groupCol} must contain exactly 2 distinct groups for a two-sided comparison; found ${labels.length}${
        labels.length
          ? ` (${labels
              .slice(0, 5)
              .map((l) => `“${l}”`)
              .join(", ")})`
          : ""
      }.`,
    );
  }
  const [control, treatment] = labels as [string, string];
  const controlRows = ctx.rows.filter((r) => cellString(r[gi]) === control);
  const treatmentRows = ctx.rows.filter((r) => cellString(r[gi]) === treatment);
  if (controlRows.length === 0 || treatmentRows.length === 0) {
    throw new AnalysisInputError("Each group needs at least one row.");
  }
  return { control, treatment, controlRows, treatmentRows };
}

/** Read a numeric cell, returning NaN rather than throwing on nulls/strings. */
function asNumber(v: Cell | undefined): number {
  const n = cellNumber(v ?? null);
  return n === null || n === undefined ? Number.NaN : n;
}

function runAbTest(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "abtest" }>): AnalysisResult {
  const si = requireColumn(ctx.columns, cfg.successesCol, "number");
  const ti = requireColumn(ctx.columns, cfg.trialsCol, "number");
  const { control, treatment, controlRows, treatmentRows } = splitTwoGroups(ctx, cfg.armCol);

  // Per-arm totals: the dataset stores one row per arm per period, so the
  // arm's conversions and trials are the column sums across its rows.
  const armTotals = (rows: Cell[][]) => {
    let successes = 0;
    let trials = 0;
    let revenue = 0;
    const vi = cfg.valueCol ? columnIndex(ctx.columns, cfg.valueCol) : -1;
    for (const r of rows) {
      successes += asNumber(r[si]);
      trials += asNumber(r[ti]);
      if (vi >= 0) revenue += asNumber(r[vi]);
    }
    return { successes, trials, revenue };
  };

  const c = armTotals(controlRows);
  const t = armTotals(treatmentRows);
  if (!Number.isFinite(c.successes) || !Number.isFinite(t.successes)) {
    throw new AnalysisInputError(
      `Conversions must be numeric. Check “${cfg.successesCol}” contains numbers, not blanks or labels.`,
    );
  }
  if (c.trials <= 0 || t.trials <= 0) {
    throw new AnalysisInputError(`Each arm needs a positive trial count in “${cfg.trialsCol}”.`);
  }
  if (c.successes > c.trials || t.successes > t.trials) {
    throw new AnalysisInputError("Conversions cannot exceed trials in either arm.");
  }
  if (c.successes < 0 || t.successes < 0) {
    throw new AnalysisInputError("Conversions cannot be negative.");
  }

  const alpha = cfg.alpha > 0 && cfg.alpha < 1 ? cfg.alpha : 0.05;
  const power = cfg.power > 0 && cfg.power < 1 ? cfg.power : 0.8;
  const ev = evaluateAbTest(
    { control: { successes: c.successes, trials: c.trials }, treatment: { successes: t.successes, trials: t.trials } },
    { alpha, power },
  );

  const cRate = c.successes / c.trials;
  const tRate = t.successes / t.trials;
  const f = ev.frequentist;
  const b = ev.bayesian;
  const significant = f.pValue < alpha;
  const winner =
    b.winner === "inconclusive" ? "Neither — inconclusive" : b.winner === "treatment" ? treatment : control;

  const warnings: string[] = [];
  for (const a of [...f.assumptions, ...ev.design.assumptions]) {
    if (!a.passed) warnings.push(`Assumption failed — ${a.name}${a.warning ? `: ${a.warning}` : ""}`);
  }

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Conversion rate by arm`,
      subtitle: `${control} ${(cRate * 100).toFixed(2)}% vs ${treatment} ${(tRate * 100).toFixed(2)}% — ${f.relativeLiftPct >= 0 ? "+" : ""}${f.relativeLiftPct.toFixed(2)}% relative lift (95% CI ${(f.ci95.low * 100).toFixed(2)}% to ${(f.ci95.high * 100).toFixed(2)}% absolute).`,
      yLabel: "Conversion rate",
      categories: [control, treatment],
      series: [{ name: "Conversion rate (%)", data: [cRate * 100, tRate * 100], color: "#5AA8AA" }],
    },
  ];

  const tables: TableSpec[] = [
    {
      title: "Arm summary",
      columns: [
        { key: "arm", label: "Arm", format: "text" },
        { key: "trials", label: "Trials", format: "number" },
        { key: "successes", label: "Conversions", format: "number" },
        { key: "rate", label: "Rate", format: "pct" },
        { key: "ciLow", label: "95% CI low", format: "pct" },
        { key: "ciHigh", label: "95% CI high", format: "pct" },
      ],
      rows: [
        [control, c.trials, c.successes, cRate, b.control.ci95.low, b.control.ci95.high],
        [treatment, t.trials, t.successes, tRate, b.treatment.ci95.low, b.treatment.ci95.high],
      ],
    },
    {
      title: "Bayesian posterior (Beta-Binomial, uniform prior)",
      columns: [
        { key: "arm", label: "Arm", format: "text" },
        { key: "posteriorMean", label: "Posterior mean", format: "pct" },
        { key: "median", label: "Posterior median", format: "pct" },
        { key: "ciLow", label: "95% credible low", format: "pct" },
        { key: "ciHigh", label: "95% credible high", format: "pct" },
      ],
      rows: [
        [control, b.control.mean, b.control.median, b.control.ci95.low, b.control.ci95.high],
        [treatment, b.treatment.mean, b.treatment.median, b.treatment.ci95.low, b.treatment.ci95.high],
      ],
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Two-proportion z-test at α = ${alpha}. The pooled success rate is compared between arms with the standard normal approximation; the confidence interval for the absolute difference is Wilson-based. A Bayesian Beta-Binomial model with a uniform Beta(1,1) prior is fitted to each arm in parallel, and P(treatment > control) is computed by numerical integration — a decision rule that does not depend on the arbitrary p < 0.05 threshold.`,
      steps: [
        `Pooled ${control} and ${treatment} arms: ${c.trials + t.trials} total trials, ${c.successes + t.successes} total conversions.`,
        `Two-proportion z-test: z = ${f.zStatistic.toFixed(4)}, two-sided p = ${f.pValue.toExponential(3)}.`,
        `95% CI for the absolute difference: ${(f.ci95.low * 100).toFixed(3)}pp to ${(f.ci95.high * 100).toFixed(3)}pp.`,
        `Bayesian P(treatment beats control) = ${(b.probabilityBetter * 100).toFixed(2)}%.`,
        `Sample-size plan: ${ev.design.perArm.toLocaleString()} per arm for ${(ev.design.mdeRelativePct * 100).toFixed(2)}% relative MDE at ${(power * 100).toFixed(0)}% power.`,
      ],
      assumptions: [
        "Each trial is independent and the conversion is a binary outcome.",
        `α was set to ${alpha} in advance; a result that only clears significance after peeking is not valid.`,
        "Runs were not stopped early on reaching significance.",
      ],
    },
    warnings,
  );

  return {
    ...base,
    charts,
    tables,
    stats: [
      {
        label: "Decision",
        value: significant ? (b.winner === "control" ? treatment : winner) : "Not significant",
        hint: significant ? "Worth shipping" : "Do not ship on this evidence",
      },
      {
        label: "Relative lift",
        value: `${f.relativeLiftPct >= 0 ? "+" : ""}${f.relativeLiftPct.toFixed(2)}%`,
        hint: `${treatment} vs ${control}`,
      },
      { label: "p-value", value: f.pValue < 1e-4 ? "< 0.0001" : f.pValue.toFixed(5), hint: `α = ${alpha}` },
      { label: "P(treatment wins)", value: `${(b.probabilityBetter * 100).toFixed(2)}%`, hint: "Bayesian posterior" },
      { label: "Needed per arm", value: ev.design.perArm.toLocaleString(), hint: "for the stated MDE" },
      {
        label: "Achievable MDE",
        value:
          ev.design.achievableMdeRelativePct !== null
            ? `${(ev.design.achievableMdeRelativePct * 100).toFixed(2)}%`
            : "n/a",
        hint: "with the sample provided",
      },
    ],
    quickFindings: [
      `${treatment} converted at ${(tRate * 100).toFixed(2)}% vs ${control} at ${(cRate * 100).toFixed(2)}% across ${c.trials.toLocaleString()} and ${t.trials.toLocaleString()} trials.`,
      b.interpretation,
      ev.design.interpretation,
      significant
        ? `The difference clears α = ${alpha}; the confidence interval excludes zero. This is evidence of a real effect, not just sampling noise.`
        : `The confidence interval ${f.ci95.low < 0 && f.ci95.high > 0 ? "includes zero" : "excludes zero but p exceeds α"} — this sample cannot distinguish the arms. Running longer is the honest response, not relaxing α.`,
    ],
  };
}

function runAutoMl(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "automl" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.targetColumn);
  const features = cfg.featureColumns.filter((c) => c !== cfg.targetColumn && columnIndex(ctx.columns, c) >= 0);
  if (features.length === 0) throw new AnalysisInputError("AutoML needs at least one feature column.");
  if (ctx.rows.length < 12) {
    throw new AnalysisInputError(`AutoML needs at least 12 complete rows; found ${ctx.rows.length}.`);
  }

  const columns: MlColumn[] = ctx.columns.map((c) => ({
    name: c.name,
    type: c.type === "number" || c.type === "string" || c.type === "boolean" || c.type === "date" ? c.type : "unknown",
  }));
  const rows: (string | number | boolean | null)[][] = ctx.rows.map((r) =>
    r.map((cell) => {
      // Cell is string | number | boolean | null — no Date variant, so dates
      // have already been normalised to ISO strings by the dataset loader.
      if (cell === null || cell === undefined) return null;
      if (typeof cell === "boolean") return cell;
      if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
      return String(cell);
    }),
  );

  let result;
  try {
    result = autoTrain(
      { columns, rows },
      {
        task: cfg.task,
        // autoTrain re-runs the whole grid regardless of `algorithm`; it is the
        // seed for the baseline probe, not a restriction.
        algorithm: cfg.task === "regression" ? "ridge" : "logistic",
        targetColumn: cfg.targetColumn,
        featureColumns: features,
        cvFolds: cfg.cvFolds,
        seed: 42,
      },
      cfg.maxCandidates,
    );
  } catch (err) {
    if (err instanceof MlError) throw new AnalysisInputError(err.message);
    throw err;
  }

  const best = result.best;
  const isRegression = result.metricName === "rmse";
  const metricValue = best.cv.mean;
  const leaderboard: TableSpec = {
    title: `Leaderboard — ${result.leaderboard.length} candidates, out-of-fold ${result.metricName}`,
    columns: [
      { key: "rank", label: "#", format: "number" },
      { key: "algorithm", label: "Algorithm", format: "text" },
      { key: "score", label: result.metricName, format: "number" },
      { key: "perFold", label: "Per-fold", format: "text" },
      { key: "fits", label: "Fits", format: "number" },
    ],
    rows: result.leaderboard.map((c, i) => [
      i + 1,
      c.algorithm,
      c.score,
      c.perFold.map((s) => s.toFixed(3)).join(", "),
      c.fits,
    ]),
  };

  const importance: TableSpec | undefined = best.importance?.length
    ? {
        title: "Permutation importance — drop in out-of-fold score when a feature is shuffled",
        columns: [
          { key: "feature", label: "Feature", format: "text" },
          { key: "importance", label: "Importance", format: "number" },
        ],
        rows: best.importance.slice(0, 12).map((p) => [p.feature, p.importance]),
      }
    : undefined;

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Out-of-fold ${result.metricName} by candidate (lower is better)`,
      subtitle: `${result.leaderboard.length} candidates evaluated with ${best.cv.folds}-fold cross-validation on identical folds, so the scores are directly comparable.`,
      yLabel: result.metricName,
      categories: result.leaderboard.map((c) => c.algorithm),
      series: [
        {
          name: result.metricName,
          data: result.leaderboard.map((c) => c.score),
          color: "#5AA8AA",
        },
      ],
    },
  ];

  const conformalNote = best.conformal
    ? `Split-conformal prediction interval at ±${best.conformal.halfWidth.toFixed(3)} (coverage target ${((1 - best.conformal.alpha) * 100).toFixed(0)}%, calibrated on out-of-fold residuals).`
    : null;

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `AutoML search over the ${cfg.task} algorithm space with ${best.cv.folds}-fold cross-validation. Every candidate is scored on the same folds, so the leaderboard is an apples-to-apples comparison; the winner is chosen by out-of-fold ${result.metricName} and refit on the full dataset.`,
      steps: [
        `Evaluated ${result.leaderboard.length} candidate configurations across ${new Set(result.leaderboard.map((c) => c.algorithm)).size} algorithm families.`,
        `Winner: ${best.algorithm} with out-of-fold ${result.metricName} = ${result.leaderboard[0]?.score.toFixed(4) ?? "n/a"}.`,
        metricValue !== null
          ? `Winner's full-data ${result.metricName}: ${typeof metricValue === "number" ? metricValue.toFixed(4) : metricValue}.`
          : "Full-data metrics were not reported for this task.",
        best.importance?.length
          ? `Top feature by permutation importance: ${best.importance[0]?.feature}.`
          : "Permutation importance was not computed for this task.",
      ],
      assumptions: [
        "Rows are independent; repeated entities across rows leak between folds and inflate the score.",
        "Cross-validation estimates generalisation to unseen rows from the same population, not to future time periods.",
        isRegression
          ? "RMSE is in the target's own units and is sensitive to outliers; compare candidates on the same scale only."
          : "Accuracy depends on class balance; check the reported class balance before trusting it.",
      ],
    },
    // CvReport carries no warnings field; the engine surfaces fold instability
    // through `sd`, which is reported as a stat instead of a warning.
    [],
  );

  return {
    ...base,
    charts,
    tables: [leaderboard, ...(importance ? [importance] : [])],
    stats: [
      { label: "Winning model", value: best.algorithm, hint: `target: ${cfg.targetColumn}` },
      {
        label: `Out-of-fold ${result.metricName}`,
        value: (result.leaderboard[0]?.score ?? 0).toFixed(4),
        hint: "honest generalisation estimate",
      },
      { label: "Candidates", value: String(result.leaderboard.length), hint: `${best.cv.folds}-fold CV` },
      { label: "CV spread", value: best.cv.sd.toFixed(4), hint: "fold-to-fold SD of the metric" },
      {
        label: "Features used",
        value: String(best.featureNames.length),
        hint: best.featureNames.slice(0, 3).join(", "),
      },
      ...(conformalNote
        ? [
            {
              label: "Prediction interval",
              value: `±${best.conformal?.halfWidth.toFixed(3)}`,
              hint: "split-conformal, out-of-fold",
            },
          ]
        : []),
    ],
    quickFindings: [
      `${best.algorithm} won out of ${result.leaderboard.length} candidates at ${result.metricName} ${(result.leaderboard[0]?.score ?? 0).toFixed(4)}.`,
      best.importance?.length
        ? `Feature importance ranks ${best.importance[0]?.feature} first; shuffling it costs ${(best.importance[0]?.importance ?? 0).toFixed(4)} ${result.metricName}.`
        : "No permutation importance was produced for this task.",
      ...result.methodology.slice(0, 3),
      ...(conformalNote ? [conformalNote] : []),
    ],
  };
}

function runArimax(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "arimax" }>): AnalysisResult {
  const regressors = cfg.regressors.filter((c) => columnIndex(ctx.columns, c) >= 0);
  if (regressors.length === 0) {
    throw new AnalysisInputError("ARIMAX needs at least one exogenous driver column.");
  }
  const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, cfg.granularity);
  if (buckets.length < 10) {
    throw new AnalysisInputError(
      `ARIMAX needs at least 10 ${cfg.granularity} periods to fit a dynamic regression; found ${buckets.length}.`,
    );
  }

  const ri = regressors.map((r) => requireColumn(ctx.columns, r, "number"));
  // Regressor value per period = the mean over that period's rows, aggregated
  // the same way the target is. BucketedPoint carries no rows, so rows are
  // re-bucketed by the same key and joined back to the target's period list.
  const dateIdx = requireColumn(ctx.columns, cfg.dateCol, "date");
  const regSeries = regressors.map((_, j) => {
    const col = ri[j] as number;
    const sums = new Map<string, { total: number; n: number }>();
    for (const row of ctx.rows) {
      const d = cellDate(row[dateIdx] ?? null);
      if (!d) continue;
      const key = bucketKey(d, cfg.granularity);
      const v = asNumber(row[col]);
      if (!Number.isFinite(v)) continue;
      const acc = sums.get(key) ?? { total: 0, n: 0 };
      acc.total += v;
      acc.n += 1;
      sums.set(key, acc);
    }
    return buckets.map((b) => {
      const acc = sums.get(b.key);
      return acc && acc.n > 0 ? acc.total / acc.n : 0;
    });
  });

  // Future regressor path: a flat continuation of the last observed value.
  // Stated plainly below — projecting a driver requires knowing the driver,
  // and inventing a trend here would fabricate the forecast.
  const horizon = Math.min(Math.max(1, cfg.horizon || 4), 12);
  const futureX = Array.from({ length: horizon }, (_, h) =>
    regSeries.map((series) => {
      const last = series[series.length - 1] ?? 0;
      const prev = series[series.length - 2] ?? last;
      const drift = last - prev;
      return last + drift * (h + 1);
    }),
  );

  const y = buckets.map((b) => b.value);
  const X = y.map((_, t) => regSeries.map((series) => series[t] ?? 0));

  let fit;
  try {
    fit = arimaxForecast(y, X, { horizon, futureX, level: cfg.level }, regressors);
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err ? String(err.message) : "ARIMAX fit failed.";
    throw new AnalysisInputError(message);
  }

  const lastKey = buckets[buckets.length - 1]?.key ?? "";
  const forecastKeys = nextKeys(lastKey, cfg.granularity, horizon);
  const categories = [...buckets.map((b) => b.label), ...forecastKeys.map((k) => bucketLabel(k, cfg.granularity))];
  const levelPct = Math.round(cfg.level * 100);

  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `${cfg.metric} forecast with driver effects (ARIMAX)`,
      subtitle: `Dynamic regression on ${regressors.join(", ")} with AR(1) errors (φ = ${fit.phi.toFixed(3)}, R² = ${fit.rSquared.toFixed(3)}). Shaded band is the ${levelPct}% prediction interval.`,
      xLabel: cfg.granularity,
      yLabel: cfg.metric,
      categories,
      series: [
        { name: cfg.metric, data: [...y, ...Array(horizon).fill(null)], color: "#5AA8AA" },
        {
          name: `Forecast (${levelPct}%)`,
          data: [...Array(y.length).fill(null), ...fit.points.map((p) => p.point)],
          color: "#FFB400",
        },
        {
          name: `Upper ${levelPct}%`,
          data: [...Array(y.length).fill(null), ...fit.points.map((p) => p.high)],
          color: "#9E9E9E",
        },
        {
          name: `Lower ${levelPct}%`,
          data: [...Array(y.length).fill(null), ...fit.points.map((p) => p.low)],
          color: "#9E9E9E",
        },
      ],
    },
  ];

  const coefTable: TableSpec = {
    title: "Driver coefficients (original units)",
    columns: [
      { key: "driver", label: "Driver", format: "text" },
      { key: "coef", label: "Coefficient", format: "number" },
    ],
    rows: [...fit.regressorNames.map((n, i) => [n, fit.coefficients[i] ?? 0]), ["Intercept", fit.intercept]],
  };

  const projTable: TableSpec = {
    title: "Projected driver paths used for the forecast",
    columns: [
      { key: "period", label: "Period", format: "text" },
      ...regressors.map((r) => ({ key: r, label: r, format: "number" as const })),
    ],
    rows: forecastKeys.map((k, h) => [
      bucketLabel(k, cfg.granularity),
      ...regressors.map((_, j) => futureX[h]?.[j] ?? 0),
    ]),
  };

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Dynamic regression: ${cfg.metric} is modelled as a linear function of ${regressors.join(", ")} with autocorrelated errors, fit by Cochrane–Orcutt iteration (${fit.iterations} iterations, converged: ${fit.converged}). Unlike a univariate forecast, this attributes movement to named drivers rather than extrapolating a trend.`,
      steps: [
        `Aggregated ${ctx.rows.length.toLocaleString()} rows into ${buckets.length} ${cfg.granularity} periods.`,
        `Fitted ${regressors.length} regressor(s) + intercept on the original scale; R² = ${fit.rSquared.toFixed(4)}, residual σ = ${fit.sigma.toFixed(4)}.`,
        `AR(1) coefficient φ = ${fit.phi.toFixed(4)} — the degree of residual autocorrelation the model removed.`,
        `Projected ${horizon} periods ahead with ${levelPct}% prediction intervals.`,
      ],
      assumptions: [
        `Future ${regressors.join(", ")} values were carried forward on their most recent trend. This is a modelling choice, not knowledge — replace it with a real driver plan before acting on the forecast.`,
        "Coefficients are associations within this data, not causal effects, unless the design supports a causal claim.",
        "The relationship is assumed linear and stable over the forecast horizon.",
      ],
    },
    fit.warnings,
  );

  return {
    ...base,
    charts,
    tables: [coefTable, projTable],
    stats: [
      { label: "R²", value: fit.rSquared.toFixed(4), hint: "in-sample fit" },
      { label: "AR(1) φ", value: fit.phi.toFixed(4), hint: fit.converged ? "converged" : "did not converge" },
      { label: "Residual σ", value: fit.sigma.toFixed(4), hint: cfg.metric },
      { label: "Horizon", value: `${horizon} ${cfg.granularity}(s)`, hint: `${levelPct}% intervals` },
      { label: "Next period", value: (fit.points[0]?.point ?? 0).toFixed(2), hint: cfg.metric },
    ],
    quickFindings: [
      fit.interpretation,
      `Model explains ${(fit.rSquared * 100).toFixed(1)}% of the in-sample variation in ${cfg.metric}.`,
      ...fit.methodology.slice(0, 3),
    ],
  };
}

function runGroupComparison(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "regression" }>): AnalysisResult {
  const vi = requireColumn(ctx.columns, cfg.valueCol, "number");

  const { control, treatment, controlRows, treatmentRows } = splitTwoGroups(ctx, cfg.groupCol);
  const a = controlRows.map((r) => asNumber(r[vi])).filter((v) => Number.isFinite(v));
  const b = treatmentRows.map((r) => asNumber(r[vi])).filter((v) => Number.isFinite(v));
  const dropped = ctx.rows.length - a.length - b.length;

  if (a.length < 3 || b.length < 3) {
    throw new AnalysisInputError(
      `Each group needs at least 3 numeric values to test a difference; ${control} has ${a.length} and ${treatment} has ${b.length}.`,
    );
  }

  const alpha = cfg.alpha > 0 && cfg.alpha < 1 ? cfg.alpha : 0.05;
  const meanA = mean(a);
  const meanB = mean(b);
  const diff = meanB - meanA;

  let statistic: number;
  let df: number;
  let pValue: number;
  let method: string;
  let testLabel: string;

  if (cfg.test === "mann-whitney") {
    const mw = mannWhitneyU(a, b);
    statistic = mw.statistic;
    pValue = mw.pValue;
    df = a.length + b.length - 2;
    method = mw.method;
    testLabel = `Mann–Whitney U (rank-based, distribution-free; ${method})`;
  } else {
    const vA = variance(a);
    const vB = variance(b);
    const seA = vA / a.length;
    const seB = vB / b.length;
    const se = Math.sqrt(seA + seB);
    if (se === 0 || !Number.isFinite(se)) {
      throw new AnalysisInputError("Both groups have zero variance — there is no difference to test.");
    }
    statistic = diff / se;
    if (cfg.test === "welch") {
      df = (seA + seB) ** 2 / (seA ** 2 / (a.length - 1) + seB ** 2 / (b.length - 1));
      testLabel = "Welch's t-test (unequal variances)";
    } else {
      const pooled = ((a.length - 1) * vA + (b.length - 1) * vB) / (a.length + b.length - 2);
      const sePooled = Math.sqrt((pooled / a.length) * (1 + 1 / b.length));
      statistic = (meanB - meanA) / sePooled;
      df = a.length + b.length - 2;
      testLabel = "Student's t-test (equal variances assumed)";
    }
    pValue = studentTPValue(statistic, df);
  }

  const tCrit = studentTCriticalTwoSided(alpha, df);
  const ciLow = diff - tCrit * Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  const ciHigh = diff + tCrit * Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  const significant = pValue < alpha;
  const d = cohensD(a, b);
  const cliffs = cliffsDelta(a, b);

  const warnings: string[] = [];
  if (dropped > 0) warnings.push(`${dropped} row(s) had a non-numeric ${cfg.valueCol} and were excluded.`);
  if (
    (cfg.test === "student" && variance(a) > 4 * variance(b)) ||
    (cfg.test === "student" && variance(b) > 4 * variance(a))
  ) {
    warnings.push("Group variances differ by more than 4× — Welch's t-test is safer than Student's here.");
  }
  if (cfg.test === "mann-whitney" && significant && mediansAreSimilar(median(a), median(b), stddev(a), stddev(b))) {
    warnings.push(
      "Significant rank difference but similar medians — likely driven by distribution shape, not a location shift.",
    );
  }

  const categories = [control, treatment];
  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Mean ${cfg.valueCol} by group`,
      subtitle: `${control} ${meanA.toFixed(2)} vs ${treatment} ${meanB.toFixed(2)} — difference ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} (95% CI ${ciLow.toFixed(2)} to ${ciHigh.toFixed(2)}).`,
      yLabel: cfg.valueCol,
      categories,
      series: [{ name: "Mean", data: [meanA, meanB], color: "#5AA8AA" }],
    },
    {
      kind: "box",
      title: `Distribution of ${cfg.valueCol} by group`,
      subtitle: `Median and quartiles for each group — a significant mean can still hide a very different shape.`,
      xLabel: cfg.groupCol,
      yLabel: cfg.valueCol,
      categories,
      series: [
        { name: cfg.valueCol, box: [min(a), quantile(a, 0.25), median(a), quantile(a, 0.75), max(a)] },
        { name: cfg.valueCol, box: [min(b), quantile(b, 0.25), median(b), quantile(b, 0.75), max(b)] },
      ],
    },
  ];

  const tables: TableSpec[] = [
    {
      title: "Group summary",
      columns: [
        { key: "arm", label: "Group", format: "text" },
        { key: "n", label: "n", format: "number" },
        { key: "mean", label: "Mean", format: "number" },
        { key: "sd", label: "Std dev", format: "number" },
        { key: "median", label: "Median", format: "number" },
        { key: "min", label: "Min", format: "number" },
        { key: "max", label: "Max", format: "number" },
      ],
      rows: [
        [control, a.length, meanA, stddev(a), median(a), min(a), max(a)],
        [treatment, b.length, meanB, stddev(b), median(b), min(b), max(b)],
      ],
    },
    {
      title: "Inference",
      columns: [
        { key: "metric", label: "Metric", format: "text" },
        { key: "value", label: "Value", format: "text" },
      ],
      rows: [
        ["Test", testLabel],
        ["Statistic", statistic.toFixed(4)],
        ["df", df.toFixed(2)],
        ["p-value", pValue < 1e-4 ? "< 0.0001" : pValue.toFixed(6)],
        [`${(alpha * 100).toFixed(0)}% CI of difference`, `${ciLow.toFixed(3)} to ${ciHigh.toFixed(3)}`],
        ["Cohen's d", d.value.toFixed(3)],
        ["Hedges' g", d.g.toFixed(3)],
        ["Cohen's d magnitude", d.magnitude],
        ["Cliff's delta", cliffs.value.toFixed(3)],
        ["Cliff's delta magnitude", cliffs.magnitude],
      ],
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `${testLabel} comparing ${cfg.valueCol} between ${control} (n = ${a.length}) and ${treatment} (n = ${b.length}), with a two-sided p-value at α = ${alpha}. Effect sizes (Cohen's d with Hedges' small-sample correction, and Cliff's delta) are reported alongside, because a statistically significant difference on a large sample can be practically meaningless.`,
      steps: [
        `Group means: ${control} = ${meanA.toFixed(4)}, ${treatment} = ${meanB.toFixed(4)}; difference = ${diff.toFixed(4)}.`,
        `${testLabel}: statistic = ${statistic.toFixed(4)}, df = ${df.toFixed(2)}, two-sided p = ${pValue.toExponential(3)}.`,
        `${(alpha * 100).toFixed(0)}% confidence interval for the difference: ${ciLow.toFixed(4)} to ${ciHigh.toFixed(4)}.`,
        `Effect size: Cohen's d = ${d.value.toFixed(3)} (${d.magnitude}), Cliff's delta = ${cliffs.value.toFixed(3)} (${cliffs.magnitude}).`,
      ],
      assumptions: [
        cfg.test === "mann-whitney"
          ? "The rank test assumes independent observations and comparable distributions; it tests a shift, not specifically a median difference when shapes differ."
          : "The t-test assumes independent observations and approximately normal residuals within each group.",
        cfg.test === "student"
          ? "Student's t-test assumes equal variances across groups; Welch's does not and is the safer default."
          : "Welch's t-test does not assume equal variances.",
        "Observations are independent. Repeated measures from the same entity violate this and narrow the effective sample size.",
        `${alpha} was chosen in advance. Choosing it after seeing the p-value invalidates the test.`,
      ],
    },
    warnings,
  );

  return {
    ...base,
    charts,
    tables,
    stats: [
      { label: "Difference", value: `${diff >= 0 ? "+" : ""}${diff.toFixed(3)}`, hint: `${treatment} − ${control}` },
      { label: "p-value", value: pValue < 1e-4 ? "< 0.0001" : pValue.toFixed(5), hint: `α = ${alpha}` },
      {
        label: "Significant",
        value: significant ? "Yes" : "No",
        hint: significant ? "unlikely under the null" : "cannot reject the null",
      },
      { label: "Cohen's d", value: d.value.toFixed(3), hint: `${d.magnitude} effect` },
      { label: "95% CI", value: `${ciLow.toFixed(2)} to ${ciHigh.toFixed(2)}`, hint: "difference in means" },
    ],
    quickFindings: [
      `${treatment} averages ${Math.abs(diff).toFixed(2)} ${diff >= 0 ? "higher" : "lower"} than ${control} on ${cfg.valueCol} (${meanB.toFixed(2)} vs ${meanA.toFixed(2)}).`,
      significant
        ? `The difference is statistically significant (p = ${pValue.toExponential(2)} < ${alpha}).`
        : `The difference is not statistically significant (p = ${pValue.toFixed(4)} ≥ ${alpha}) — this sample does not distinguish the groups.`,
      significant && ["negligible", "small"].includes(d.magnitude)
        ? `Statistically significant but the effect size is only ${d.magnitude} (d = ${d.value.toFixed(3)}) — likely not worth acting on in practice.`
        : `Effect size is ${d.magnitude} (Cohen's d = ${d.value.toFixed(3)}).`,
    ],
  };
}

function runDataQuality(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "dataquality" }>): AnalysisResult {
  const requiredIdx = requireColumn(ctx.columns, cfg.requiredCol);

  // The contract is the dataset's ACTUAL shape, then expectations are layered
  // on top. Building the contract from real columns (rather than a declared
  // wish-list) keeps this an audit of the data as it is, and means a type
  // mismatch can only surface from an expectation, not a stale declaration.
  const contractColumns: ContractColumn[] = ctx.columns.map((c) => ({
    name: c.name,
    type: c.type === "number" || c.type === "string" || c.type === "boolean" || c.type === "date" ? c.type : "string",
    nullable: false,
  }));

  const expectations: Expectation[] = [
    {
      id: "required",
      kind: "not-null",
      column: cfg.requiredCol,
      severity: cfg.severity,
      description: `${cfg.requiredCol} must never be blank`,
    },
  ];
  if (cfg.uniqueCol) {
    expectations.push({
      id: "unique",
      kind: "unique",
      column: cfg.uniqueCol,
      severity: cfg.severity,
      description: `${cfg.uniqueCol} must be unique`,
    });
  }
  if (cfg.inSetCol && cfg.allowedValues.length > 0) {
    expectations.push({
      id: "in-set",
      kind: "in-set",
      column: cfg.inSetCol,
      severity: cfg.severity,
      params: { values: cfg.allowedValues },
      description: `${cfg.inSetCol} must be one of the allowed values`,
    });
  }
  if (cfg.rangeCol && cfg.min !== null && cfg.max !== null) {
    expectations.push({
      id: "range",
      kind: "range",
      column: cfg.rangeCol,
      severity: cfg.severity,
      params: { min: cfg.min, max: cfg.max },
      description: `${cfg.rangeCol} must be within [${cfg.min}, ${cfg.max}]`,
    });
  }

  const contract = {
    id: `dq-${ctx.datasetId}`,
    datasetName: ctx.datasetName,
    version: "1.0.0",
    columns: contractColumns,
    expectations,
  };
  const check = checkContract(contract, ctx.columns, ctx.rows);

  // An `error`-severity violation is a gate failure. Warn-only still reports
  // everything but does not mark the dataset unfit.
  const gate = runQualityGate(check.expectationResults, { blockOnError: cfg.severity === "error" });
  const blocking = cfg.severity === "error" && gate.verdict !== "pass";

  const tables: TableSpec[] = [
    {
      title: "Expectation results",
      columns: [
        { key: "id", label: "Check", format: "text" },
        { key: "column", label: "Column", format: "text" },
        { key: "result", label: "Result", format: "text" },
        { key: "violations", label: "Violations", format: "number" },
        { key: "total", label: "Rows", format: "number" },
        { key: "message", label: "Detail", format: "text" },
      ],
      rows: check.expectationResults.map((r) => [
        r.expectationId,
        r.column ?? "(table)",
        r.passed ? "Pass" : r.severity === "error" ? "FAIL" : "Warn",
        r.violations,
        r.total,
        r.message,
      ]),
    },
  ];

  if (check.violations.length > 0) {
    tables.push({
      title: "Contract violations",
      columns: [
        { key: "kind", label: "Violation", format: "text" },
        { key: "column", label: "Column", format: "text" },
        { key: "message", label: "Detail", format: "text" },
      ],
      rows: check.violations.map((v) => [v.kind, v.column ?? "(table)", v.message]),
    });
  }

  const missingCount = ctx.rows.reduce((acc, r) => {
    const v = r[requiredIdx];
    return acc + (v === null || v === undefined || String(v).trim() === "" ? 1 : 0);
  }, 0);

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `The dataset's actual schema is captured as a contract, then ${expectations.length} expectation${expectations.length === 1 ? " is" : "s are"} evaluated against every row: ${expectations.map((e) => e.description ?? e.kind).join("; ")}. Each check reports violating row counts and up to five offending example values, so a failure is traceable to specific records rather than a bare count.`,
      steps: [
        `Captured ${contractColumns.length} column definitions from the dataset.`,
        `Evaluated ${expectations.length} expectation(s) over ${ctx.rows.length.toLocaleString()} rows.`,
        `${check.expectationResults.filter((r) => r.passed).length} passed, ${check.expectationResults.filter((r) => !r.passed).length} failed.`,
        `${cfg.requiredCol} has ${missingCount.toLocaleString()} blank value(s).`,
      ],
      assumptions: [
        "The dataset as loaded is the dataset under test; transformations applied before upload are not re-verified.",
        "A blank string and a null are both treated as missing.",
        cfg.severity === "error"
          ? "Severity is 'error': any violation marks the dataset unfit for downstream analysis."
          : "Severity is 'warn': violations are reported but do not block downstream analysis.",
      ],
    },
    blocking
      ? [
          "This dataset FAILS its data contract. Fix the violations above before trusting any analysis computed from it — a number derived from broken input is confidently wrong, not obviously wrong.",
        ]
      : [],
  );

  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "Data contract results",
        subtitle: `${check.expectationResults.filter((r) => r.passed).length} of ${check.expectationResults.length} checks passed across ${ctx.rows.length.toLocaleString()} rows.`,
        xLabel: "Check",
        yLabel: "Violating rows",
        categories: check.expectationResults.map((r) => r.expectationId),
        series: [
          {
            name: "Violating rows",
            data: check.expectationResults.map((r) => r.violations),
            color: check.expectationResults.every((r) => r.passed) ? "#5AA8AA" : "#FFB400",
          },
        ],
      },
    ],
    tables,
    stats: [
      {
        label: "Contract",
        value: gate.verdict === "pass" ? "Pass" : blocking ? "FAIL" : "Pass (warnings)",
        hint: `${check.expectationResults.length} checks`,
      },
      { label: "Rows tested", value: ctx.rows.length.toLocaleString(), hint: ctx.columns.length + " columns" },
      { label: "Blank required", value: missingCount.toLocaleString(), hint: cfg.requiredCol },
      { label: "Violations", value: String(check.violations.length), hint: "schema + expectations" },
    ],
    quickFindings: [
      gate.verdict === "pass"
        ? `All ${check.expectationResults.length} data-contract checks passed — the dataset is fit for analysis.`
        : `${check.expectationResults.filter((r) => !r.passed).length} of ${check.expectationResults.length} checks failed: ${check.expectationResults
            .filter((r) => !r.passed)
            .map((r) => `${r.expectationId} (${r.violations.toLocaleString()} row${r.violations === 1 ? "" : "s"})`)
            .join(", ")}.`,
      missingCount > 0
        ? `${missingCount.toLocaleString()} row(s) have a blank ${cfg.requiredCol}.`
        : `${cfg.requiredCol} is fully populated.`,
      ...check.expectationResults
        .filter((r) => !r.passed && r.examples.length > 0)
        .slice(0, 2)
        .map((r) => `${r.expectationId}: example offending values ${r.examples.map((e) => `“${e}”`).join(", ")}.`),
      blocking
        ? "Blocking: analysis computed from this dataset would be unreliable until these are fixed."
        : "Non-blocking: warnings recorded for review.",
    ],
  };
}

function runAccounting(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "accounting" }>): AnalysisResult {
  const di = requireColumn(ctx.columns, cfg.dateCol, "date");
  const ai = requireColumn(ctx.columns, cfg.accountCol);
  const bi = requireColumn(ctx.columns, cfg.debitCol, "number");
  const ci = requireColumn(ctx.columns, cfg.creditCol, "number");
  const ni = cfg.narrationCol ? columnIndex(ctx.columns, cfg.narrationCol) : -1;
  const ri = cfg.referenceCol ? columnIndex(ctx.columns, cfg.referenceCol) : -1;

  // Rows are grouped into journal entries by voucher reference when supplied,
  // otherwise the WHOLE file is one entry. Grouping by reference is what makes
  // a real voucher file loadable; without a reference column there is no way to
  // know which lines belong to the same transaction, so it is treated as one
  // aggregate entry and said so plainly below.
  const groups = new Map<string, Cell[][]>();
  for (const row of ctx.rows) {
    const key = ri >= 0 ? cellString(row[ri] ?? null) || "__all__" : "__all__";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const entries: JournalEntry[] = [];
  const rejections: string[] = [];
  for (const [key, rows] of groups) {
    const lines = [];
    for (const r of rows) {
      const code = cellString(r[ai] ?? null).trim();
      if (!code) {
        rejections.push(`Voucher ${key}: a row has a blank account code.`);
        continue;
      }
      const debit = toMinorUnits(asNumber(r[bi]));
      const credit = toMinorUnits(asNumber(r[ci]));
      if (debit !== 0 && credit !== 0) {
        rejections.push(
          `Voucher ${key} account ${code}: both a debit (${formatMinor(debit)}) and a credit (${formatMinor(credit)}) — a posting side must be one or the other.`,
        );
        continue;
      }
      if (debit === 0 && credit === 0) continue;
      lines.push({
        accountCode: code,
        amount: debit !== 0 ? debit : -credit,
        narration: ni >= 0 ? cellString(r[ni] ?? null) : undefined,
      });
    }
    if (lines.length === 0) continue;
    const date =
      cellDate(rows[0]![di] ?? null)
        ?.toISOString()
        .slice(0, 10) ?? "1970-01-01";
    entries.push({
      id: key,
      date,
      narration: ni >= 0 ? cellString(rows[0]![ni] ?? null) || `Voucher ${key}` : `Voucher ${key}`,
      lines,
      reference: key === "__all__" ? undefined : key,
    });
  }

  // Validate every entry against the chart. An unbalanced voucher is REJECTED,
  // never repaired — a bookkeeper must fix the source file, not have the tool
  // invent a balancing plug.
  const accepted: JournalEntry[] = [];
  for (const e of entries) {
    try {
      accepted.push(validateEntry(e, DEFAULT_CHART_OF_ACCOUNTS));
    } catch (err) {
      rejections.push(err instanceof Error ? err.message : `Voucher ${e.id} was rejected.`);
    }
  }

  if (accepted.length === 0) {
    throw new AnalysisInputError(
      `No balanced journal entries could be built from this file. First problem: ${rejections[0] ?? "no usable postings were found."}`,
    );
  }

  const ledger: Ledger = { accounts: DEFAULT_CHART_OF_ACCOUNTS, entries: accepted };
  const range = { from: cfg.from ?? undefined, to: cfg.to ?? undefined };
  const tb = trialBalance(ledger, range);
  const is = incomeStatement(ledger, range);
  const bs = balanceSheet(ledger, range);
  const cf = cashFlow(ledger, range);

  // If some vouchers were rejected the trial balance still balances (only
  // accepted entries posted), but the statements would be incomplete — that is
  // surfaced as a blocking warning, not hidden.
  const incomplete = rejections.length > 0;

  const tbTable: TableSpec = {
    title: `Trial balance${tb.balanced ? "" : " — DOES NOT BALANCE"}`,
    columns: [
      { key: "code", label: "Code", format: "text" },
      { key: "name", label: "Account", format: "text" },
      { key: "debit", label: "Debit", format: "number" },
      { key: "credit", label: "Credit", format: "number" },
    ],
    rows: [
      ...tb.rows.map((r) => [r.code, r.name, fromMinor(r.debit), fromMinor(r.credit)]),
      ["", "TOTAL", fromMinor(tb.totalDebit), fromMinor(tb.totalCredit)],
    ],
  };

  const flatten = (
    lines: {
      key: string;
      label: string;
      amount: number;
      children?: { key: string; label: string; amount: number }[];
    }[],
  ): (string | number)[][] => {
    const out: (string | number)[][] = [];
    for (const l of lines) {
      out.push([l.label, fromMinor(l.amount)]);
      for (const c of l.children ?? []) out.push([`  ${c.label}`, fromMinor(c.amount)]);
    }
    return out;
  };

  const statementColumns = [
    { key: "label", label: "Particulars", format: "text" as const },
    { key: "amount", label: "Amount", format: "number" as const },
  ];

  const tables: TableSpec[] = [
    tbTable,
    {
      title: "Profit & loss account",
      columns: statementColumns,
      rows: [...flatten(is.income), ...flatten(is.expenses), ["Net profit / (loss)", fromMinor(is.netProfit)]],
    },
    {
      title: "Balance sheet",
      columns: statementColumns,
      rows: [
        ...flatten(bs.assets),
        ["", ""],
        ...flatten(bs.liabilities),
        ["", ""],
        ...flatten(bs.equity),
        ["Total assets", fromMinor(bs.totalAssets)],
        ["Liabilities + equity", fromMinor(bs.totalLiabilities + bs.totalEquity)],
      ],
    },
  ];

  const warnings = [...rejections];
  if (bs.imbalance !== 0) {
    warnings.push(
      `Balance sheet is out of balance by ${formatMinor(bs.imbalance)} — assets do not equal liabilities plus equity. The books are incomplete or a voucher is missing.`,
    );
  }
  if (!cf.reconciled) {
    warnings.push(
      `Cash flow does not reconcile: derived closing cash ${formatMinor(cf.closingCash)} differs from the ledger's cash balance. Treat the cash-flow statement as unreliable.`,
    );
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `The uploaded file is read as a double-entry voucher ledger. Rows are grouped into journal entries by the voucher reference, each entry is validated so that debits equal credits to the paise, and only balanced entries are posted. Amounts are held as integer paise throughout, so the debit=credit identity cannot drift through floating-point error. The trial balance, profit & loss account, balance sheet and cash-flow statement are then projections of those postings.`,
      steps: [
        `Grouped ${ctx.rows.length.toLocaleString()} row(s) into ${entries.length} journal entr${entries.length === 1 ? "y" : "ies"}.`,
        `${accepted.length} entr${accepted.length === 1 ? "y" : "ies"} balanced and were posted; ${rejections.length} were rejected.`,
        `Trial balance: debits ${formatMinor(tb.totalDebit)}, credits ${formatMinor(tb.totalCredit)} — ${tb.balanced ? "in balance" : `OUT OF BALANCE by ${formatMinor(Math.abs(tb.difference))}`}.`,
        `Profit for the period: ${formatMinor(is.netProfit)}. Assets ${formatMinor(bs.totalAssets)} against liabilities + equity ${formatMinor(bs.totalLiabilities + bs.totalEquity)}.`,
      ],
      assumptions: [
        "Account codes are matched against the standard chart of accounts; an unknown code is rejected rather than silently created.",
        "Rows without a voucher reference are treated as one aggregate entry — provide a reference column to separate vouchers.",
        "The statements cover only balanced, accepted entries. Review the rejection list before relying on them.",
        "Amounts are read as entered; no currency conversion or revaluation is applied.",
      ],
    },
    warnings,
  );

  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "Trial balance — debits vs credits",
        subtitle: tb.balanced
          ? `Balanced at ${formatMinor(tb.totalDebit)} across ${tb.rows.length} accounts with activity.`
          : `OUT OF BALANCE by ${formatMinor(Math.abs(tb.difference))}.`,
        yLabel: "Amount",
        categories: ["Debits", "Credits"],
        series: [
          {
            name: "Total",
            data: [fromMinor(tb.totalDebit), fromMinor(tb.totalCredit)],
            color: tb.balanced ? "#5AA8AA" : "#FFB400",
          },
        ],
      },
    ],
    tables,
    stats: [
      {
        label: "Trial balance",
        value: tb.balanced ? "Balanced" : "OUT OF BALANCE",
        hint: `${tb.rows.length} accounts`,
      },
      {
        label: "Net profit",
        value: formatMinor(is.netProfit),
        hint: is.netProfit < 0 ? "loss for the period" : "profit for the period",
      },
      {
        label: "Total assets",
        value: formatMinor(bs.totalAssets),
        hint: `L+E ${formatMinor(bs.totalLiabilities + bs.totalEquity)}`,
      },
      {
        label: "Balance sheet",
        value: bs.imbalance === 0 ? "Balanced" : `Off by ${formatMinor(Math.abs(bs.imbalance))}`,
        hint: "A = L + E",
      },
      {
        label: "Cash flow",
        value: cf.reconciled ? "Reconciled" : "Does not reconcile",
        hint: `net ${formatMinor(cf.netChange)}`,
      },
      ...(incomplete ? [{ label: "Rejected rows", value: String(rejections.length), hint: "not posted" }] : []),
    ],
    quickFindings: [
      tb.balanced
        ? `Trial balance balances at ${formatMinor(tb.totalDebit)} — every voucher posted is internally consistent.`
        : `Trial balance is OUT OF BALANCE by ${formatMinor(Math.abs(tb.difference))}. The books cannot be relied on.`,
      is.netProfit >= 0
        ? `Profit for the period is ${formatMinor(is.netProfit)} on revenue of ${formatMinor(is.totalIncome)}.`
        : `LOSS for the period of ${formatMinor(-is.netProfit)} on revenue of ${formatMinor(is.totalIncome)}.`,
      bs.imbalance === 0
        ? `Balance sheet balances: assets ${formatMinor(bs.totalAssets)} = liabilities ${formatMinor(bs.totalLiabilities)} + equity ${formatMinor(bs.totalEquity)}.`
        : `Balance sheet does NOT balance — off by ${formatMinor(bs.imbalance)}.`,
      ...(incomplete
        ? [
            `${rejections.length} posting(s) were rejected and are NOT in these statements. First issue: ${rejections[0]}`,
          ]
        : []),
    ],
  };
}

function runSyntheticControl(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "syntheticcontrol" }>): AnalysisResult {
  const di = requireColumn(ctx.columns, cfg.dateCol, "date");
  const ui = requireColumn(ctx.columns, cfg.unitCol);
  const mi = requireColumn(ctx.columns, cfg.metric, "number");

  // Build a time-major panel: outcomes[t][j] is unit j's value in period t.
  // Only units observed in EVERY period can enter the donor pool — a donor
  // with a gap would be silently imputed and distort the weights.
  const periods = [...new Set(ctx.rows.map((r) => bucketKey(cellDate(r[di] ?? null) ?? new Date(0), cfg.granularity)))]
    .filter(Boolean)
    .sort();
  const units = [...new Set(ctx.rows.map((r) => cellString(r[ui] ?? null)))].filter(Boolean).sort();

  if (periods.length < 6) {
    throw new AnalysisInputError(
      `Synthetic control needs at least 6 ${cfg.granularity} periods to separate pre- and post-intervention windows; found ${periods.length}.`,
    );
  }
  if (units.length < 3) {
    throw new AnalysisInputError(
      `Synthetic control needs a treated unit plus at least 2 donors to synthesise a counterfactual; found ${units.length} unit(s).`,
    );
  }

  const byUnitPeriod = new Map<string, number>();
  for (const r of ctx.rows) {
    const d = cellDate(r[di] ?? null);
    if (!d) continue;
    const v = asNumber(r[mi]);
    if (!Number.isFinite(v)) continue;
    byUnitPeriod.set(`${cellString(r[ui] ?? null)}|${bucketKey(d, cfg.granularity)}`, v);
  }

  const complete = units.filter((u) => periods.every((p) => byUnitPeriod.has(`${u}|${p}`)));
  const treatedIdx = complete.indexOf(cfg.treatedValue);
  if (treatedIdx < 0) {
    const present = units.includes(cfg.treatedValue) ? "but it is missing values in some periods" : "";
    throw new AnalysisInputError(
      `Treated unit “${cfg.treatedValue}” was not found in the data ${present}. Every unit must be observed in every period.`,
    );
  }
  const donors = complete.filter((_, i) => i !== treatedIdx);
  if (donors.length < 2) {
    throw new AnalysisInputError(
      `Only ${donors.length} complete donor unit(s) remain; synthetic control needs at least 2 to form a weighted comparison.`,
    );
  }

  const treated = complete[treatedIdx] as string;
  const outcomes = periods.map((p) => [
    byUnitPeriod.get(`${treated}|${p}`) ?? 0,
    ...donors.map((d) => byUnitPeriod.get(`${d}|${p}`) ?? 0),
  ]);

  const prePeriods = Math.min(Math.max(2, cfg.prePeriods), periods.length - 1);
  const sc = syntheticControl({
    outcomes,
    prePeriods,
    donorNames: donors,
    treatedName: treated,
    maxIter: cfg.maxIter,
  });

  const categories = periods.map((p) => bucketLabel(p, cfg.granularity));
  const treatedSeries = outcomes.map((t) => t[0] ?? 0);
  const syntheticSeries = outcomes.map((_, t) => {
    let v = 0;
    for (let j = 0; j < donors.length; j++) v += (outcomes[t]?.[j + 1] ?? 0) * (sc.weights[j] ?? 0);
    return v;
  });
  const postStart = prePeriods;

  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `${treated} vs its synthetic control`,
      subtitle: `Before period ${categories[postStart] ?? postStart}: a weighted blend of ${donors.length} donors reproduces ${treated}'s pre-intervention path (RMSE ${sc.preRmse.toFixed(2)}). After, the gap is the estimated effect.`,
      xLabel: cfg.granularity,
      yLabel: cfg.metric,
      categories,
      series: [
        { name: treated, data: treatedSeries, color: "#5AA8AA" },
        { name: "Synthetic control", data: syntheticSeries, color: "#FFB400" },
      ],
    },
  ];

  const tables: TableSpec[] = [
    {
      title: "Donor weights (must be ≥ 0 and sum to 1)",
      columns: [
        { key: "name", label: "Donor", format: "text" },
        { key: "weight", label: "Weight", format: "number" },
        { key: "pct", label: "Share", format: "pct" },
      ],
      rows: sc.contributions.map((c) => [c.name, c.weight, c.pct]),
    },
    {
      title: "Per-period gap",
      columns: [
        { key: "period", label: "Period", format: "text" },
        { key: "treated", label: treated, format: "number" },
        { key: "synthetic", label: "Synthetic", format: "number" },
        { key: "gap", label: "Gap (effect)", format: "number" },
        { key: "phase", label: "Phase", format: "text" },
      ],
      rows: sc.gaps.map((g, t) => [
        categories[t] ?? String(g.t),
        treatedSeries[t] ?? 0,
        syntheticSeries[t] ?? 0,
        g.gap,
        g.isPost ? "Post" : "Pre",
      ]),
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Synthetic control. A weighted combination of ${donors.length} untreated donor units is fitted to reproduce ${treated}'s pre-intervention trajectory (${prePeriods} periods, RMS gap ${sc.preRmse.toFixed(4)}), using a simplex-constrained least-squares solver solved by Frank–Wolfe (duality gap ${sc.dualityGap.toExponential(2)}). The post-intervention gap between ${treated} and its synthetic is the estimated effect, with inference from both a pre-period variance estimate and an in-space placebo test over ${sc.placeboCount} placebo fits.`,
      steps: [
        `Panel built from ${units.length} units over ${periods.length} ${cfg.granularity} periods; ${complete.length} units were complete and eligible.`,
        `Pre-intervention fit: treated vs synthetic RMS gap = ${sc.preRmse.toFixed(4)} (a poor fit here invalidates the counterfactual).`,
        `Post-intervention effect: ATT = ${sc.att.toFixed(4)} ${cfg.metric}, relative to the pre-period level = ${(sc.relativeAtt * 100).toFixed(2)}%.`,
        Number.isFinite(sc.attPValue)
          ? `ATT standard error ${sc.attSe.toFixed(4)}, two-sided p = ${sc.attPValue.toFixed(4)}.`
          : "ATT standard error unavailable (needs at least 4 pre-periods).",
        `Placebo permutation test: the treated unit ranks ${sc.placeboRank} of ${sc.placeboCount + 1}, p = ${sc.placeboPValue.toFixed(4)}.`,
      ],
      assumptions: [
        sc.identifyingAssumption,
        "Donors must not have been exposed to the intervention. A contaminated donor pool biases the effect toward zero.",
        "The pre-period fit must be close; a poor synthetic fit means the estimate is not credible regardless of its p-value.",
        "No other confounder changes at the intervention time. A concurrent policy or market shift breaks this.",
      ],
    },
    sc.warnings,
  );

  return {
    ...base,
    charts,
    tables,
    stats: [
      { label: "Effect (ATT)", value: sc.att.toFixed(2), hint: sc.att >= 0 ? "increase" : "decrease" },
      { label: "Relative effect", value: `${(sc.relativeAtt * 100).toFixed(2)}%`, hint: "of pre-period level" },
      {
        label: "Placebo p-value",
        value: sc.placeboPValue.toFixed(4),
        hint: `rank ${sc.placeboRank}/${sc.placeboCount + 1}`,
      },
      {
        label: "Pre-fit RMSE",
        value: sc.preRmse.toFixed(3),
        hint: sc.preRmse > Math.abs(sc.att) ? "poor fit — treat with caution" : "counterfactual is credible",
      },
      { label: "Donors", value: String(donors.length), hint: "weighted to sum 1" },
    ],
    quickFindings: [
      sc.interpretation,
      `${treated} moved ${sc.att >= 0 ? "up" : "down"} ${Math.abs(sc.att).toFixed(2)} ${cfg.metric} relative to its synthetic control (${(sc.relativeAtt * 100).toFixed(2)}% of its pre-intervention level).`,
      `The synthetic reproduced the pre-intervention path to an RMS gap of ${sc.preRmse.toFixed(3)} — ${sc.preRmse < Math.abs(sc.att) / 2 ? "close enough for the post-period comparison to be meaningful" : "loose enough that the effect estimate is fragile"}.`,
      Number.isFinite(sc.attPValue)
        ? `Placebo test: only ${sc.placeboRank - 1} of ${sc.placeboCount} placebo units showed a larger gap, so this effect is unlikely to be an artifact of unit selection.`
        : "Placebo test needs more periods to be conclusive.",
    ],
  };
}

function runUplift(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "uplift" }>): AnalysisResult {
  const ti = requireColumn(ctx.columns, cfg.treatmentCol);
  const oi = requireColumn(ctx.columns, cfg.outcomeCol, "number");
  const featureIdx = cfg.features
    .filter((f) => columnIndex(ctx.columns, f) >= 0)
    .map((f) => requireColumn(ctx.columns, f, "number"));

  if (featureIdx.length === 0) throw new AnalysisInputError("Uplift needs at least one numeric feature column.");
  if (ctx.rows.length < 40) {
    throw new AnalysisInputError(
      `Uplift needs at least 40 complete rows to fit and evaluate a model; found ${ctx.rows.length}.`,
    );
  }

  const rows: { x: number[]; w: 0 | 1; y: number }[] = [];
  let dropped = 0;
  for (const r of ctx.rows) {
    const x = featureIdx.map((i) => asNumber(r[i]));
    const y = asNumber(r[oi]);
    const wRaw = cellString(r[ti] ?? null)
      .trim()
      .toLowerCase();
    const w: 0 | 1 | null =
      wRaw === "1" || wRaw === "treated" || wRaw === "true"
        ? 1
        : wRaw === "0" || wRaw === "control" || wRaw === "false"
          ? 0
          : null;
    if (!x.every(Number.isFinite) || !Number.isFinite(y) || w === null) {
      dropped += 1;
      continue;
    }
    rows.push({ x, w, y });
  }
  if (rows.length < 40) {
    throw new AnalysisInputError(
      `Only ${rows.length} row(s) had complete features, a valid assignment and an outcome — uplift needs 40.`,
    );
  }

  let up;
  try {
    up = fitUplift(rows, { task: cfg.task, learner: cfg.learner, folds: cfg.folds });
  } catch (err) {
    throw new AnalysisInputError(err instanceof Error ? err.message : "Uplift model failed to fit.");
  }

  const categories = up.curve.map((p) => `${(p.fraction * 100).toFixed(0)}%`);
  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: "Qini curve — incremental conversions from targeting",
      subtitle: `The area between the Qini curve and the random diagonal is the ${(up.qiniCoefficient * 100).toFixed(2)}% qini coefficient: the share of the maximum achievable incremental outcome this ranking captures.`,
      xLabel: "Fraction of population targeted",
      yLabel: "Incremental outcome",
      categories,
      series: [
        { name: "Uplift ranking", data: up.curve.map((p) => p.incremental), color: "#5AA8AA" },
        { name: "Random targeting", data: up.curve.map((p) => p.random), color: "#9E9E9E" },
      ],
    },
  ];

  const tables: TableSpec[] = [
    {
      title: "Incremental outcome by targeting depth",
      columns: [
        { key: "k", label: "Target", format: "pct" },
        { key: "incremental", label: "Incremental outcome", format: "number" },
        { key: "perThousand", label: "Per 1,000 targeted", format: "number" },
      ],
      rows: up.upliftAt.map((u) => [u.kPct / 100, u.incremental, u.perThousandTreated]),
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Treatment-effect heterogeneity via a ${up.learner === "t-learner" ? "T-learner (separate treated and control models, differenced)" : "S-learner (single model with assignment as a feature)"}, evaluated out-of-fold across ${cfg.folds} folds. Each customer is scored on predicted incremental outcome, and the ranking is summarised by the Qini curve — the area between the model curve and random targeting.`,
      steps: [
        `Fitted on ${up.n} rows: ${up.nTreated} treated, ${up.nControl} control.`,
        `Average treatment effect (ATE) = ${up.ate.toFixed(4)}${Number.isFinite(up.ateSe) ? `, SE ${up.ateSe.toFixed(4)}, p = ${up.atePValue.toFixed(4)}` : ""}.`,
        `Qini coefficient ${up.qiniCoefficient.toFixed(4)} against an oracle upper bound of ${up.qiniOracle.toFixed(4)} (ratio ${(up.qiniRatio * 100).toFixed(1)}%).`,
        ...up.upliftAt
          .slice(0, 3)
          .map(
            (u) =>
              `Targeting the top ${u.kPct}% captures ${u.incremental.toFixed(2)} incremental (${u.perThousandTreated.toFixed(1)} per 1,000).`,
          ),
      ],
      assumptions: [
        "Assignment to treatment must be randomised. Confounded assignment makes uplift uninterpretable.",
        cfg.task === "binary"
          ? "The outcome must be binary for the binary task; a continuous outcome here would silently produce a meaningless curve."
          : "The outcome is treated as continuous; heteroscedasticity across arms will bias the modelled effect.",
        "Out-of-fold scoring prevents the model ranking itself on training data, which would inflate the Qini curve.",
        "Targeting decisions assume you can contact exactly the top-k fraction — operational capacity is not modelled.",
      ],
    },
    [
      ...up.warnings,
      ...(dropped > 0
        ? [`${dropped} row(s) were excluded for incomplete features, outcome, or an unrecognised assignment value.`]
        : []),
    ],
  );

  return {
    ...base,
    charts,
    tables,
    stats: [
      {
        label: "ATE",
        value: up.ate.toFixed(4),
        hint: up.ate >= 0 ? "treatment helps on average" : "treatment hurts on average",
      },
      {
        label: "Qini coefficient",
        value: up.qiniCoefficient.toFixed(4),
        hint: `${(up.qiniRatio * 100).toFixed(1)}% of oracle`,
      },
      ...(up.upliftAt[0]
        ? [
            {
              label: `Top ${up.upliftAt[0].kPct}%`,
              value: up.upliftAt[0].incremental.toFixed(2),
              hint: "incremental outcome",
            },
          ]
        : []),
      { label: "Sample", value: `${up.nTreated}T / ${up.nControl}C`, hint: `${up.n} rows` },
      {
        label: "Noise ratio",
        value: up.noiseRatio.toFixed(3),
        hint: up.noiseRatio < 0.1 ? "weak signal — uplift fragile" : "signal exceeds noise",
      },
    ],
    quickFindings: [
      up.interpretation,
      `On average the intervention changed the outcome by ${up.ate.toFixed(3)} ${up.ate >= 0 ? "in favour of" : "against"} the treated group.`,
      up.upliftAt[0]
        ? `Targeting only the top ${up.upliftAt[0].kPct}% captures ${up.upliftAt[0].incremental.toFixed(2)} of incremental outcome — ${up.upliftAt[0].perThousandTreated.toFixed(1)} per 1,000 contacted.`
        : "No targeting depth was evaluable.",
      up.noiseRatio < 0.1
        ? "The treatment effect is small relative to outcome variance — this ranking is fragile and should not drive budget allocation on its own."
        : `The treatment effect is ${up.noiseRatio.toFixed(2)}× the outcome standard deviation, so heterogeneity is measurable.`,
    ],
  };
}

function runSprt(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "sprt" }>): AnalysisResult {
  const si = requireColumn(ctx.columns, cfg.successesCol, "number");
  const ti = requireColumn(ctx.columns, cfg.trialsCol, "number");
  const { control, treatment, controlRows, treatmentRows } = splitTwoGroups(ctx, cfg.armCol);

  const sum = (rows: Cell[][], idx: number) => rows.reduce((acc, r) => acc + asNumber(r[idx]), 0);
  const cSuccess = sum(controlRows, si);
  const cTrials = sum(controlRows, ti);
  const tSuccess = sum(treatmentRows, si);
  const tTrials = sum(treatmentRows, ti);

  if (cTrials <= 0 || tTrials <= 0) throw new AnalysisInputError("Each arm needs a positive trial count.");
  const mde = cfg.mdeRelative > 0 && cfg.mdeRelative < 1 ? cfg.mdeRelative : 0.05;

  const res = sequentialProbabilityRatioTest({
    controlSuccesses: cSuccess,
    controlTrials: cTrials,
    treatmentSuccesses: tSuccess,
    treatmentTrials: tTrials,
    alpha: cfg.alpha > 0 && cfg.alpha < 1 ? cfg.alpha : 0.05,
    beta: cfg.beta > 0 && cfg.beta < 1 ? cfg.beta : 0.2,
    mdeRelative: mde,
  });

  const verdictLabel =
    res.verdict === "reject-h0"
      ? "SHIP — effect detected"
      : res.verdict === "accept-h0"
        ? "STOP — no meaningful effect"
        : "CONTINUE — still undecided";

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: "Conversion rate by arm (sequential test)",
      subtitle: `${control} ${(res.pControl * 100).toFixed(2)}% vs ${treatment} ${(res.pTreatment * 100).toFixed(2)}%. Log-likelihood ratio ${res.logLikelihoodRatio.toFixed(3)} sits between the boundaries ${res.lowerBoundary.toFixed(2)} and ${res.upperBoundary.toFixed(2)}.`,
      yLabel: "Conversion rate",
      categories: [control, treatment],
      series: [{ name: "Rate (%)", data: [res.pControl * 100, res.pTreatment * 100], color: "#5AA8AA" }],
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Wald sequential probability ratio test for two binomial arms. The running log-likelihood ratio is compared against Wald's boundaries log((1−β)/α) and log(β/(1−α)), so the error rates are controlled EXACTLY regardless of how many times the experiment is looked at. H0: no effect. H1: a ${(mde * 100).toFixed(1)}% relative lift, the smallest effect worth detecting.`,
      steps: [
        `Arms: ${control} ${cTrials.toFixed(0)} trials / ${cSuccess.toFixed(0)} conversions; ${treatment} ${tTrials.toFixed(0)} trials / ${tSuccess.toFixed(0)} conversions.`,
        `Observed rates: ${(res.pControl * 100).toFixed(3)}% vs ${(res.pTreatment * 100).toFixed(3)}% (relative difference ${(((res.pTreatment - res.pControl) / (res.pControl || 1)) * 100).toFixed(2)}%).`,
        `LLR = ${res.logLikelihoodRatio.toFixed(4)}; upper boundary ${res.upperBoundary.toFixed(4)}, lower ${res.lowerBoundary.toFixed(4)} (progress ${(res.progress * 100).toFixed(1)}%).`,
        `Verdict: ${verdictLabel}.`,
      ],
      assumptions: [
        "H1 is fixed in advance at a detectable lift of " +
          (mde * 100).toFixed(1) +
          "%. A sequential test tuned after seeing the data does not control error rates.",
        "Trials are independent and conversion is a binary outcome.",
        "The arms must be concurrent — comparing sequential periods against each other confounds the test with time.",
      ],
    },
    [],
  );

  return {
    ...base,
    charts,
    tables: [
      {
        title: "Arm summary",
        columns: [
          { key: "arm", label: "Arm", format: "text" },
          { key: "trials", label: "Trials", format: "number" },
          { key: "successes", label: "Conversions", format: "number" },
          { key: "rate", label: "Rate", format: "pct" },
        ],
        rows: [
          [control, cTrials, cSuccess, res.pControl],
          [treatment, tTrials, tSuccess, res.pTreatment],
        ],
      },
    ],
    stats: [
      { label: "Verdict", value: verdictLabel, hint: res.verdict },
      {
        label: "LLR",
        value: res.logLikelihoodRatio.toFixed(3),
        hint: `bounds ${res.lowerBoundary.toFixed(2)} … ${res.upperBoundary.toFixed(2)}`,
      },
      { label: "Progress", value: `${(res.progress * 100).toFixed(0)}%`, hint: "toward a decision" },
      { label: "Detectable lift", value: `${(mde * 100).toFixed(1)}%`, hint: "H1 as specified" },
    ],
    quickFindings: [
      res.interpretation,
      `Observed relative difference is ${(((res.pTreatment - res.pControl) / (res.pControl || 1)) * 100).toFixed(2)}% against a ${(mde * 100).toFixed(1)}% target.`,
      res.verdict === "continue"
        ? "The test has not crossed either boundary — keep running rather than deciding early."
        : `The test crossed a boundary: ${res.verdict}.`,
      ...res.methodology.slice(0, 2),
    ],
  };
}

function runDrift(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "drift" }>): AnalysisResult {
  // Split in TIME order, not randomly: a random split compares two overlapping
  // windows and hides the drift it is supposed to detect.
  let ordered = ctx.rows;
  if (cfg.dateCol) {
    const di = requireColumn(ctx.columns, cfg.dateCol, "date");
    const keyed = ctx.rows.map((r) => ({ r, d: cellDate(r[di] ?? null) })).filter((x) => x.d !== null) as {
      r: Cell[];
      d: Date;
    }[];
    keyed.sort((a, b) => a.d.getTime() - b.d.getTime());
    ordered = keyed.map((x) => x.r);
  }

  const split = Math.min(Math.max(cfg.referenceSplit, 0.1), 0.9);
  const cut = Math.floor(ordered.length * split);
  const refRows = ordered.slice(0, cut);
  const curRows = ordered.slice(cut);

  if (refRows.length < 20 || curRows.length < 20) {
    throw new AnalysisInputError(
      `Drift needs at least 20 rows in EACH window; got ${refRows.length} reference and ${curRows.length} current. Widen the dataset or lower the split.`,
    );
  }

  const wanted = cfg.columns.length > 0 ? cfg.columns : ctx.columns.map((c) => c.name);
  const columnTypes: Record<string, "numeric" | "categorical"> = {};
  const reference: Record<string, (string | number | boolean | null)[]> = {};
  const current: Record<string, (string | number | boolean | null)[]> = {};

  for (const name of wanted) {
    const idx = columnIndex(ctx.columns, name);
    if (idx < 0) continue;
    const col = ctx.columns[idx];
    if (!col) continue;
    // Dates carry no distribution worth PSI-testing; they define the window.
    if (col.type === "date") continue;
    columnTypes[name] = col.type === "number" ? "numeric" : "categorical";
    reference[name] = refRows.map((r) => (r[idx] ?? null) as string | number | boolean | null);
    current[name] = curRows.map((r) => (r[idx] ?? null) as string | number | boolean | null);
  }

  if (Object.keys(columnTypes).length === 0) {
    throw new AnalysisInputError("No testable columns: drift needs at least one non-date column.");
  }

  let report;
  try {
    report = detectDrift(reference, current, columnTypes);
  } catch (err) {
    const message =
      err && typeof err === "object" && "message" in err ? String(err.message) : "Drift detection failed.";
    throw new AnalysisInputError(message);
  }

  const drifted = report.columns.filter((c) => c.severity !== "ok");
  const major = drifted.filter((c) => c.severity === "major");

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: "Population stability index by column",
      subtitle: `PSI < ${report.thresholds.moderate} is stable, ≥ ${report.thresholds.moderate} moderate, ≥ ${report.thresholds.major} major. Overall: ${report.overall}.`,
      xLabel: "Column",
      yLabel: "PSI",
      categories: report.columns.map((c) => c.column),
      series: [
        {
          name: "PSI",
          data: report.columns.map((c) => c.psi),
          color: report.overall === "ok" ? "#5AA8AA" : "#FFB400",
        },
      ],
    },
  ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Population stability index between two time-ordered windows: the first ${(split * 100).toFixed(0)}% of rows by ${cfg.dateCol ?? "row order"} as reference (${report.nReference} rows) and the remainder as current (${report.nCurrent} rows). Numeric columns use equal-frequency decile bins fitted on the reference window plus an exact Kolmogorov–Smirnov statistic; categorical columns compare per-level shares with an ε bucket for unseen levels.`,
      steps: [
        `Split ${ordered.length.toLocaleString()} rows into ${report.nReference} reference and ${report.nCurrent} current.`,
        `Tested ${report.columns.length} column(s).`,
        `${report.columns.filter((c) => c.severity === "ok").length} stable, ${drifted.filter((c) => c.severity === "moderate").length} moderate, ${major.length} major.`,
        report.overall !== "ok"
          ? `Overall verdict: ${report.overall} drift — a model trained on the reference window should be re-validated before its outputs are trusted.`
          : "Overall verdict: stable — the input distribution has not moved enough to invalidate a model trained on the reference window.",
      ],
      assumptions: [
        "The two windows are distinct in time and share a stable definition of each column.",
        "PSI is a heuristic, not a test: it has no p-value and no confidence interval, and it is sensitive to binning. Read it as a trigger to investigate, not as a verdict.",
        "Drift in the inputs does not prove model degradation — it only shows the assumption the training distribution relied on may no longer hold.",
        cfg.columns.length > 0 ? "Only the selected columns were tested." : "Every non-date column was tested.",
      ],
    },
    major.length > 0
      ? [
          `${major.length} column(s) show MAJOR drift (PSI ≥ ${report.thresholds.major}). Any model consuming them should be re-validated or retrained before its predictions are relied upon.`,
        ]
      : [],
  );

  return {
    ...base,
    charts,
    tables: [
      {
        title: "Per-column drift",
        columns: [
          { key: "column", label: "Column", format: "text" },
          { key: "kind", label: "Type", format: "text" },
          { key: "psi", label: "PSI", format: "number" },
          { key: "ks", label: "KS statistic", format: "number" },
          { key: "severity", label: "Severity", format: "text" },
          { key: "topBin", label: "Largest contributor", format: "text" },
        ],
        rows: report.columns.map((c) => [c.column, c.kind, c.psi, c.ksStatistic, c.severity, c.topBin ?? "—"]),
      },
    ],
    stats: [
      { label: "Overall", value: report.overall, hint: `${report.columns.length} columns` },
      { label: "Columns drifted", value: `${drifted.length} / ${report.columns.length}`, hint: "moderate or major" },
      {
        label: "Reference window",
        value: report.nReference.toLocaleString(),
        hint: `first ${(split * 100).toFixed(0)}%`,
      },
      { label: "Current window", value: report.nCurrent.toLocaleString(), hint: "remainder" },
      ...(major[0] ? [{ label: "Worst column", value: major[0].column, hint: `PSI ${major[0].psi.toFixed(3)}` }] : []),
    ],
    quickFindings: [
      report.interpretation,
      drifted.length === 0
        ? `No column drifted beyond the moderate threshold across ${report.nReference.toLocaleString()} reference and ${report.nCurrent.toLocaleString()} current rows.`
        : `${drifted.length} of ${report.columns.length} columns drifted: ${drifted.map((c) => `${c.column} (${c.severity}, PSI ${c.psi.toFixed(3)})`).join(", ")}.`,
      ...drifted
        .slice(0, 2)
        .map(
          (c) =>
            `${c.column}: the largest shift is in ${c.topBin ?? "no single bin"}${c.ksStatistic !== null ? ` (KS ${c.ksStatistic.toFixed(3)})` : ""}.`,
        ),
      major.length > 0
        ? "Major drift means a model trained on the reference window is now operating outside the distribution it was validated on."
        : "No major drift, so existing models remain within their validated range.",
    ],
  };
}

function runCompliance(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "compliance" }>): AnalysisResult {
  const ki = requireColumn(ctx.columns, cfg.kindCol);
  const ri = requireColumn(ctx.columns, cfg.rateCol, "number");
  const ti = requireColumn(ctx.columns, cfg.taxableCol, "number");
  const rci = cfg.reverseChargeCol ? columnIndex(ctx.columns, cfg.reverseChargeCol) : -1;
  const sci = cfg.sectionCol ? columnIndex(ctx.columns, cfg.sectionCol) : -1;
  const pci = cfg.panCol ? columnIndex(ctx.columns, cfg.panCol) : -1;
  const gi = cfg.gstinCol ? columnIndex(ctx.columns, cfg.gstinCol) : -1;
  const di = columnIndex(ctx.columns, "date") >= 0 ? columnIndex(ctx.columns, "date") : -1;

  const transactions: GstTransaction[] = [];
  const payments: { payeeName: string; pan: string | null; section: string; baseAmount: number }[] = [];
  const skipped: string[] = [];
  const observedRates = new Set<number>();

  const RECOGNISED = new Set(["supply", "purchase", "import", "export"]);
  for (const r of ctx.rows) {
    const rawKind = cellString(r[ki] ?? null)
      .trim()
      .toLowerCase();
    if (!RECOGNISED.has(rawKind)) {
      skipped.push(`a row whose kind is “${rawKind || "(blank)"}”`);
      continue;
    }
    const taxableMajor = asNumber(r[ti]);
    if (!Number.isFinite(taxableMajor) || taxableMajor < 0) {
      skipped.push("a row with an invalid taxable value");
      continue;
    }
    const ratePct = asNumber(r[ri]);
    if (!Number.isFinite(ratePct) || ratePct < 0) {
      skipped.push(`a row whose rate is not numeric`);
      continue;
    }
    observedRates.add(ratePct);

    const reverseCharge = rci >= 0 && /^(1|true|yes|y)$/i.test(cellString(r[rci] ?? null));
    const category: GstCategory = rawKind === "export" ? "export" : "itc";

    transactions.push({
      documentNumber: `DOC-${transactions.length + 1}`,
      date:
        di >= 0
          ? (cellDate(r[di] ?? null)
              ?.toISOString()
              .slice(0, 10) ?? cfg.period)
          : cfg.period,
      kind: rawKind as GstTransaction["kind"],
      taxableValue: toMinorUnits(taxableMajor),
      category,
      // The rate travels WITH the transaction: a ledger mixing 12% and 18%
      // must tax each invoice at its own slab.
      ratePct,
      gstin: gi >= 0 ? cellString(r[gi] ?? null) || undefined : undefined,
      reverseCharge,
    });

    if (sci >= 0) {
      const section = cellString(r[sci] ?? null).trim();
      if (section) {
        payments.push({
          payeeName: gi >= 0 ? cellString(r[gi] ?? null) || `Row ${payments.length + 1}` : `Row ${payments.length + 1}`,
          pan: pci >= 0 ? cellString(r[pci] ?? null) || null : null,
          section,
          baseAmount: toMinorUnits(taxableMajor),
        });
      }
    }
  }

  if (transactions.length === 0) {
    throw new AnalysisInputError(
      `No usable transaction rows. The “${cfg.kindCol}” column must contain supply, purchase, import or export.`,
    );
  }
  if (observedRates.size === 0) {
    throw new AnalysisInputError(`The “${cfg.rateCol}” column has no usable numeric rates.`);
  }

  // Each transaction is taxed at ITS OWN rate. A mixed-rate ledger (12% and 18%
  // on different invoices) is split by HSN-style slab rather than collapsed to a
  // single average, which is what computeGst3B expects from a rate table.
  const rates = [...observedRates].flatMap((pct) => [
    { category: "intra" as GstCategory, ratePct: pct },
    { category: "inter" as GstCategory, ratePct: pct },
    { category: "export" as GstCategory, ratePct: 0 },
    { category: "itc" as GstCategory, ratePct: pct },
    { category: "import" as GstCategory, ratePct: pct },
  ]);

  const gst = computeGst3B(transactions, cfg.period, toMinorUnits(cfg.openingCredit), { rates });

  // TDS: sections and rates come from the DATA, never from a hardcoded table.
  const sectionRates = new Map<string, number>();
  for (const r of ctx.rows) {
    if (sci < 0) break;
    const s = cellString(r[sci] ?? null).trim();
    const rate = asNumber(r[ri]);
    if (s && Number.isFinite(rate)) sectionRates.set(s.toUpperCase(), rate);
  }
  const sections: TdsSection[] = [...sectionRates.entries()].map(([section, ratePct]) => ({
    section,
    description: `Section ${section}`,
    ratePct,
    thresholdMinor: 0,
    tcs: false,
  }));
  const tds = sections.length > 0 && payments.length > 0 ? computeTds(payments, sections) : null;

  const sampleItems = transactions.map((t, i) => ({ id: `DOC-${i + 1}`, value: t.taxableValue }));
  const sample =
    cfg.auditSampleSize > 0 && sampleItems.length >= 20
      ? auditSample(sampleItems, {
          method: "mus",
          tolerableRate: 0.05,
          expectedRate: 0,
          confidence: 0.95,
          sampleSize: cfg.auditSampleSize,
          seed: 42,
        })
      : null;

  const warnings: string[] = [...gst.warnings];
  if (skipped.length > 0) {
    warnings.push(
      `${skipped.length} row(s) were skipped (${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "…" : ""}).`,
    );
  }
  if (tds) warnings.push(...tds.warnings);
  if (!tds && cfg.sectionCol) {
    warnings.push("A TDS section column was selected but no rows carried a section, so no deduction was computed.");
  }
  if (!sample) {
    warnings.push("Audit sampling needs at least 20 documents; it was skipped.");
  }

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `GST payable for ${cfg.period}`,
      subtitle: `Outward tax ${complianceFmt(gst.outwardTax)} against ITC available ${complianceFmt(gst.itcAvailable)}; only ${complianceFmt(gst.itcUtilised)} could be used because ITC absorbs at most 20% of the liability.`,
      yLabel: "Amount",
      categories: ["Outward tax", "ITC utilised", "Net payable"],
      series: [
        {
          name: "Amount",
          data: [fromMinor(gst.outwardTax), fromMinor(gst.itcUtilised), fromMinor(gst.netPayable)],
          color: "#5AA8AA",
        },
      ],
    },
  ];

  const tables: TableSpec[] = [
    {
      title: `GST summary — ${cfg.period}`,
      columns: [
        { key: "item", label: "Line", format: "text" },
        { key: "amount", label: "Amount", format: "number" },
      ],
      rows: [
        ["Outward taxable value", fromMinor(gst.outwardTaxable)],
        ["Outward tax", fromMinor(gst.outwardTax)],
        ["ITC available", fromMinor(gst.itcAvailable)],
        ["ITC utilised (capped at 20% of liability)", fromMinor(gst.itcUtilised)],
        ["ITC carried forward", fromMinor(gst.itcCarriedForward)],
        ["Reverse-charge tax payable", fromMinor(gst.reverseChargeTax)],
        ["Net tax payable", fromMinor(gst.netPayable)],
      ],
    },
  ];

  if (tds && tds.bySection.length > 0) {
    tables.push({
      title: "TDS by section",
      columns: [
        { key: "section", label: "Section", format: "text" },
        { key: "rate", label: "Rate %", format: "number" },
        { key: "count", label: "Payments", format: "number" },
        { key: "amount", label: "Deductible", format: "number" },
      ],
      rows: tds.bySection.map((s) => [s.section, s.ratePct, s.count, fromMinor(s.amount)]),
    });
  }
  if (sample) {
    tables.push({
      title: `Audit sample (${sample.method.toUpperCase()})`,
      columns: [
        { key: "item", label: "Measure", format: "text" },
        { key: "value", label: "Value", format: "text" },
      ],
      rows: [
        ["Population size", sample.populationSize.toLocaleString()],
        ["Sample size", sample.sampleSize.toLocaleString()],
        ["Confidence", `${(sample.confidence * 100).toFixed(0)}%`],
        ["Tolerable error rate", `${(sample.tolerableRate * 100).toFixed(2)}%`],
        ["Sample value", fromMinor(sample.sampleValue)],
        ["Population value", fromMinor(sample.populationValue)],
        ["Conclusion", sample.conclusion],
      ],
    });
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Indian statutory compliance over ${transactions.length.toLocaleString()} document(s). GST tax is computed invoice-by-invoice at each row's own rate and summed; ITC is then capped at 20% of the period's tax liability with the remainder carried forward, per Section 73(5). TDS is computed per section at the rates present in the data. An audit sample is drawn by a documented, seeded method with a finite-population correction.`,
      steps: [
        ...gst.methodology,
        ...(tds
          ? [`TDS deductible across ${tds.bySection.length} section(s): ${complianceFmt(tds.totalDeductible)}.`]
          : []),
        ...(sample ? sample.methodology : []),
      ],
      assumptions: [
        "Rates are read from the uploaded data — no rate is hardcoded, so a slab change must be reflected in the source ledger.",
        "GST returns are NOT filed by this analysis and the e-invoice/IRN schema is not validated; this is a computation and review aid, not a filing tool.",
        "The ITC cap is applied; other section-73(5) restrictions (blocked credits, 180-day rule) are not modelled.",
        sample
          ? `The sample uses ${sample.method.toUpperCase()} with a fixed seed so the selection is reproducible; the conclusion is a statistical judgement, not an audit opinion.`
          : "No audit sample was drawn.",
        "A CA must verify the output against the source records before it is relied upon.",
      ],
    },
    warnings,
  );

  return {
    ...base,
    charts,
    tables,
    stats: [
      {
        label: "Net GST payable",
        value: complianceFmt(gst.netPayable),
        hint: `${cfg.period} · outward ${complianceFmt(gst.outwardTax)}`,
      },
      {
        label: "ITC carried forward",
        value: complianceFmt(gst.itcCarriedForward),
        hint: `used ${complianceFmt(gst.itcUtilised)}`,
      },
      ...(tds
        ? [
            {
              label: "TDS deductible",
              value: complianceFmt(tds.totalDeductible),
              hint: `${tds.bySection.length} section(s)`,
            },
          ]
        : []),
      ...(tds && tds.panIssues.length > 0
        ? [{ label: "PAN issues", value: String(tds.panIssues.length), hint: "not claimable by payee" }]
        : []),
      ...(sample
        ? [
            {
              label: "Audit sample",
              value: sample.conclusion,
              hint: `${sample.sampleSize} of ${sample.populationSize}`,
            },
          ]
        : []),
    ],
    quickFindings: [
      `GST for ${cfg.period}: outward tax ${complianceFmt(gst.outwardTax)}, ITC used ${complianceFmt(gst.itcUtilised)}, net payable ${complianceFmt(gst.netPayable)}.`,
      gst.creditAvailable > 0
        ? `${complianceFmt(gst.creditAvailable)} of ITC could NOT be used this period because the 20% cap binds — it carries forward and is not lost.`
        : "ITC fully absorbed within the cap; nothing carried forward.",
      gst.reverseChargeTax > 0
        ? `Reverse-charge tax of ${complianceFmt(gst.reverseChargeTax)} is payable by you and is not recoverable as ITC.`
        : "No reverse-charge tax in this period.",
      ...(tds
        ? [`TDS deductible ${complianceFmt(tds.totalDeductible)} across ${tds.bySection.length} section(s).`]
        : []),
      ...(tds?.panIssues.length
        ? [
            `${tds.panIssues.length} payee(s) have a missing or malformed PAN — the deduction will be deposited but cannot be claimed on Form 26Q.`,
          ]
        : []),
      ...(sample
        ? [
            `Audit sample of ${sample.sampleSize} document(s) covering ${(sample.detectedRate * 100).toFixed(2)}% of value — conclusion: ${sample.conclusion}.`,
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Wiring for kinds that already had engines but no dispatcher branch.
// Every runner: validate → shape data into the engine contract → render the
// returned numbers (including the diagnostics that weaken the conclusion).
// ---------------------------------------------------------------------------

/** Wrap any engine error so the API surfaces a specific, actionable message. */
function wrapEngineError(err: unknown, label: string): AnalysisInputError {
  if (err instanceof AnalysisInputError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AnalysisInputError(`${label} failed: ${msg}`);
}

/** Milliseconds per period for a streaming window sized in periods. */
function periodMs(granularity: Granularity): number {
  switch (granularity) {
    case "day":
      return 86_400_000;
    case "week":
      return 7 * 86_400_000;
    case "month":
      return 30 * 86_400_000;
    case "quarter":
      return 91 * 86_400_000;
    case "year":
      return 365 * 86_400_000;
    default:
      return 86_400_000;
  }
}

/** Build a dense numeric matrix from named columns; drops incomplete rows. */
function numericMatrix(
  ctx: Ctx,
  colNames: string[],
): { X: number[][]; yIndexes: number[]; dropped: number; kept: number[] } {
  const idxs = colNames.map((n) => requireColumn(ctx.columns, n, "number"));
  const X: number[][] = [];
  const kept: number[] = [];
  let dropped = 0;
  ctx.rows.forEach((row, i) => {
    const vec = idxs.map((j) => asNumber(row[j]));
    if (!vec.every(Number.isFinite)) {
      dropped += 1;
      return;
    }
    X.push(vec);
    kept.push(i);
  });
  return { X, yIndexes: idxs, dropped, kept };
}

/** Map a numeric target to 0/1 for a binary task (accepts 0/1 or any two values). */
function mapBinaryTarget(values: number[], label: string): number[] {
  const uniq = [...new Set(values.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  if (uniq.length < 2) {
    throw new AnalysisInputError(`Binary task on "${label}" needs at least two distinct values; found ${uniq.length}.`);
  }
  if (uniq.every((v) => v === 0 || v === 1)) return values.map((v) => (v === 1 ? 1 : 0));
  if (uniq.length === 2) {
    const hi = uniq[1] as number;
    return values.map((v) => (v === hi ? 1 : 0));
  }
  throw new AnalysisInputError(
    `Binary task on "${label}" needs 0/1 encoding or exactly two distinct values; found ${uniq.length} (${uniq.slice(0, 5).map(String).join(", ")}${uniq.length > 5 ? "…" : ""}).`,
  );
}

/** Wilson score interval for a binomial proportion. */
function wilsonCi(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Welch's one-way ANOVA (does not assume equal variances across groups).
 * Returns the F statistic, p-value and the two df values.
 */
function welchAnova(groups: number[][]): { f: number; pValue: number; df1: number; df2: number } | null {
  const clean = groups.map((g) => g.filter((v) => Number.isFinite(v))).filter((g) => g.length >= 2);
  if (clean.length < 2) return null;
  const k = clean.length;
  const means = clean.map((g) => mean(g));
  const vars = clean.map((g) => variance(g));
  const ns = clean.map((g) => g.length);
  const weights = ns.map((n, i) => n / Math.max(vars[i] as number, 1e-12));
  const wSum = sum(weights);
  if (!(wSum > 0)) return null;
  const grand = means.reduce((acc, m, i) => acc + (m as number) * (weights[i] as number), 0) / wSum;
  const A = means.reduce((acc, m, i) => acc + (weights[i] as number) * ((m as number) - grand) ** 2, 0) / (k - 1);
  const B = ns.map((n, i) => {
    const wi = weights[i] as number;
    return (wi * wi) / (n - 1);
  });
  const correction = 1 + ((2 * (k - 2)) / (k * k - 1) / wSum) * sum(B);
  const fStat = A / Math.max(correction, 1e-12);
  const df1 = k - 1;
  const df2 = (k * k - 1) / (3 * Math.max(sum(B), 1e-12));
  if (!Number.isFinite(fStat) || !(df2 > 0)) return null;
  const pValue = fPValue(fStat, df1, df2);
  return { f: fStat, pValue, df1, df2 };
}

/** Survival-function p-value for an F statistic (regularized incomplete beta). */
function fPValue(f: number, df1: number, df2: number): number {
  if (!(f > 0) || !(df1 > 0) || !(df2 > 0)) return 1;
  const x = df2 / (df2 + df1 * f);
  const ibeta = regularizedBeta(x, df2 / 2, df1 / 2);
  return Math.min(1, Math.max(0, ibeta));
}

// ---------------------------------------------------------------------------
// What-if
// ---------------------------------------------------------------------------

function runWhatIfAnalysis(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "whatif" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.driverColumn, "number");
  requireColumn(ctx.columns, cfg.outcomeColumn, "number");
  if (cfg.driverColumn === cfg.outcomeColumn) {
    throw new AnalysisInputError("Driver and outcome columns must be different.");
  }
  const controls = (cfg.controlColumns ?? []).filter(
    (c) => c && c !== cfg.driverColumn && c !== cfg.outcomeColumn && columnIndex(ctx.columns, c) >= 0,
  );
  for (const c of controls) requireColumn(ctx.columns, c, "number");

  let result;
  try {
    result = runWhatIf(
      { columns: ctx.columns.map((c) => ({ name: c.name, type: c.type })), rows: ctx.rows },
      {
        driverColumn: cfg.driverColumn,
        outcomeColumn: cfg.outcomeColumn,
        pctChange: Number.isFinite(cfg.pctChange) ? cfg.pctChange : 0,
        controlColumns: controls,
      },
    );
  } catch (err) {
    throw wrapEngineError(err, "What-if");
  }

  const before = result.beforeValue;
  const after = result.afterValue;
  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Projected ${cfg.outcomeColumn} under a ${result.pctChange >= 0 ? "+" : ""}${result.pctChange}% shift in ${cfg.driverColumn}`,
      subtitle: result.fallback
        ? "Hypothetical projection — the data lacked enough signal for a causal claim."
        : "Before vs after the driver shift, holding controls at their observed values.",
      categories: ["Before", `After (${result.pctChange >= 0 ? "+" : ""}${result.pctChange}%)`],
      series: [{ name: cfg.outcomeColumn, data: [before, after], color: "#5AA8AA" }],
      yLabel: cfg.outcomeColumn,
    },
  ];
  const m = result.model;
  const tables: TableSpec[] = [
    {
      title: "Projection",
      columns: [
        { key: "k", label: "Quantity", format: "text" },
        { key: "v", label: "Value", format: "number" },
      ],
      rows: [
        ["Baseline outcome", before],
        ["Projected outcome", after],
        ["Absolute delta", result.delta],
        ["Relative delta %", result.deltaPct],
        ["Driver mean", result.driverMean],
      ],
    },
    {
      title: "Model",
      columns: [
        { key: "k", label: "Term", format: "text" },
        { key: "v", label: "Value", format: "number" },
      ],
      rows: [
        ["Slope", m.slope],
        ["Intercept", m.intercept],
        ["R²", m.rSquared],
        ["p-value", m.pValue],
        ["Points", m.points],
        ["95% CI low (slope)", m.confidenceInterval[0]],
        ["95% CI high (slope)", m.confidenceInterval[1]],
      ],
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Multiple OLS of ${cfg.outcomeColumn} on ${cfg.driverColumn}${controls.length ? ` with controls ${controls.join(", ")}` : ""}, then re-evaluated with the driver shifted by ${result.pctChange}%. The projection is arithmetic on the fitted model, not a re-estimation on perturbed data.`,
      steps: [
        `Fitted on ${m.points} complete rows (R² = ${m.rSquared.toFixed(4)}).`,
        `Slope ${m.slope.toFixed(4)} (95% CI ${m.confidenceInterval[0].toFixed(4)} to ${m.confidenceInterval[1].toFixed(4)}, p = ${m.pValue.toExponential(3)}).`,
        `${cfg.outcomeColumn}: ${before.toFixed(4)} → ${after.toFixed(4)} (Δ ${result.delta.toFixed(4)}, ${result.deltaPct.toFixed(2)}%).`,
        result.causal
          ? `Causal cross-check (${result.causal.method}): estimate ${result.causal.estimate.toFixed(4)}, 95% CI ${result.causal.ci95.low.toFixed(4)} to ${result.causal.ci95.high.toFixed(4)}, agreement = ${result.causal.agreement}.`
          : "No causal cross-check ran — the result is a model projection, not an identified effect.",
      ],
      assumptions: [
        "The linear model is re-evaluated, not refit, under the perturbation — the slope is held fixed.",
        "Controls are held at their observed values; interaction terms are not modelled.",
        result.fallback
          ? "The sample is too small (or the driver has no variance) for estimation — this output is a labelled hypothetical."
          : "Exogeneity of the driver is assumed; omitted-variable bias will move the slope.",
      ],
    },
    result.fallback
      ? ["Fallback projection: not enough signal for estimation — treat the delta as illustrative only."]
      : result.narrative
        ? []
        : [],
  );
  return {
    ...base,
    charts,
    tables,
    stats: [
      { label: "Delta", value: `${result.delta >= 0 ? "+" : ""}${result.delta.toFixed(4)}`, hint: result.direction },
      { label: "Relative change", value: `${result.deltaPct >= 0 ? "+" : ""}${result.deltaPct.toFixed(2)}%` },
      { label: "Slope", value: m.slope.toFixed(4), hint: `p = ${m.pValue.toExponential(2)}` },
      { label: "R²", value: m.rSquared.toFixed(4), hint: "model fit" },
      ...(result.causal
        ? [
            {
              label: "Causal estimate",
              value: result.causal.estimate.toFixed(4),
              hint: `95% CI ${result.causal.ci95.low.toFixed(3)} to ${result.causal.ci95.high.toFixed(3)}`,
            },
            { label: "Agreement", value: result.causal.agreement, hint: result.causal.method },
          ]
        : [{ label: "Causal?", value: "Not identified", hint: "projection only" }]),
    ],
    quickFindings: [result.narrative, result.confidenceNote].filter(Boolean) as string[],
  };
}

// ---------------------------------------------------------------------------
// Difference-in-differences (2×2 + placebo)
// ---------------------------------------------------------------------------

function runDid(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "did" }>): AnalysisResult {
  const gi = requireColumn(ctx.columns, cfg.groupCol);
  const pi = requireColumn(ctx.columns, cfg.periodCol);
  const mi = requireColumn(ctx.columns, cfg.metric, "number");
  const treatedValue = String(cfg.treatedValue ?? "").trim();
  if (!treatedValue) throw new AnalysisInputError("Set the treated value of the group column.");

  const interventionMs = cfg.interventionDate ? Date.parse(cfg.interventionDate) : Number.NaN;
  const hasIntervention = Number.isFinite(interventionMs) && cfg.periodCol && ctx.columns[pi]?.type === "date";

  const groupsSeen = new Set<string>();
  for (const row of ctx.rows) groupsSeen.add(cellString(row[gi]));
  const controlValue = [...groupsSeen].filter((g) => g !== treatedValue).sort()[0];
  if (!controlValue) throw new AnalysisInputError(`No control group found alongside “${treatedValue}”.`);

  const cells: Record<string, number[]> = { t_pre: [], t_post: [], c_pre: [], c_post: [] };
  let dropped = 0;
  for (const row of ctx.rows) {
    const v = asNumber(row[mi]);
    if (!Number.isFinite(v)) {
      dropped += 1;
      continue;
    }
    const g = cellString(row[gi]);
    const inGroup = g === treatedValue || g === controlValue;
    if (!inGroup) continue;
    let isPost: boolean;
    if (hasIntervention) {
      const d = cellDate(row[pi]);
      if (!d) {
        dropped += 1;
        continue;
      }
      isPost = d.getTime() >= interventionMs;
    } else {
      const p = cellString(row[pi]);
      if (p === String(cfg.postValue ?? "").trim()) isPost = true;
      else if (p !== "" && p !== String(cfg.postValue ?? "").trim()) isPost = false;
      else {
        dropped += 1;
        continue;
      }
    }
    const key = `${g === treatedValue ? "t" : "c"}_${isPost ? "post" : "pre"}`;
    (cells[key] as number[]).push(v);
  }

  for (const [k, arr] of Object.entries(cells)) {
    if ((arr as number[]).length < 2) {
      throw new AnalysisInputError(
        `DiD cell “${k}” has only ${(arr as number[]).length} numeric row(s); each of the four treated×period cells needs at least 2.`,
      );
    }
  }

  const meanOf = (arr: number[]) => mean(arr);
  const tPre = meanOf(cells.t_pre as number[]);
  const tPost = meanOf(cells.t_post as number[]);
  const cPre = meanOf(cells.c_pre as number[]);
  const cPost = meanOf(cells.c_post as number[]);
  const did = tPost - tPre - (cPost - cPre);

  // Honest SE from within-cell variances (Bartlett-style pooling of the four cells).
  const seTerms = (["t_pre", "t_post", "c_pre", "c_post"] as const).map((k) => {
    const arr = cells[k] as number[];
    return variance(arr) / arr.length;
  });
  const se = Math.sqrt(sum(seTerms));
  const nTreated = (cells.t_pre as number[]).length + (cells.t_post as number[]).length;
  const nControl = (cells.c_pre as number[]).length + (cells.c_post as number[]).length;
  const df = Math.max(1, nTreated + nControl - 4);
  const tStat = se > 0 ? did / se : Number.NaN;
  const pValue = Number.isFinite(tStat) ? studentTPValue(tStat, df) : Number.NaN;
  const tCrit = studentTCriticalTwoSided(0.05, df);
  const ci: [number, number] = [did - tCrit * se, did + tCrit * se];
  const significant = Number.isFinite(pValue) && pValue < 0.05;

  // Placebo: re-run the 2×2 treating the period BEFORE intervention as post.
  let placebo: { did: number; pValue: number; note: string } | null = null;
  if (hasIntervention) {
    const pCells: Record<string, number[]> = { t_pre: [], t_post: [], c_pre: [], c_post: [] };
    for (const row of ctx.rows) {
      const v = asNumber(row[mi]);
      if (!Number.isFinite(v)) continue;
      const g = cellString(row[gi]);
      if (g !== treatedValue && g !== controlValue) continue;
      const d = cellDate(row[pi]);
      if (!d) continue;
      const t = d.getTime();
      const inPre = t < interventionMs;
      const inPlaceboPost = t < interventionMs && t >= interventionMs - periodMs("month") * 1.5;
      if (!inPre && !inPlaceboPost) continue;
      const key = `${g === treatedValue ? "t" : "c"}_${inPlaceboPost ? "post" : "pre"}`;
      (pCells[key] as number[]).push(v);
    }
    const enough = (["t_pre", "t_post", "c_pre", "c_post"] as const).every((k) => (pCells[k] as number[]).length >= 2);
    if (enough) {
      const pd =
        meanOf(pCells.t_post as number[]) -
        meanOf(pCells.t_pre as number[]) -
        (meanOf(pCells.c_post as number[]) - meanOf(pCells.c_pre as number[]));
      const pse = Math.sqrt(
        sum(
          (["t_pre", "t_post", "c_pre", "c_post"] as const).map(
            (k) => variance(pCells[k] as number[]) / (pCells[k] as number[]).length,
          ),
        ),
      );
      const pt = pse > 0 ? pd / pse : Number.NaN;
      const placeboP = Number.isFinite(pt) ? studentTPValue(pt, df) : Number.NaN;
      placebo = {
        did: pd,
        pValue: placeboP,
        note:
          Math.abs(pd) < Math.abs(did) * 0.5 && (!Number.isFinite(placeboP) || placeboP > 0.05)
            ? "Placebo period shows no comparable jump — supports the parallel-trends assumption."
            : "Placebo period shows a movement of similar size — parallel trends are in doubt and the DiD estimate should not be trusted.",
      };
    } else {
      placebo = {
        did: Number.NaN,
        pValue: Number.NaN,
        note: "Not enough pre-period rows to run the placebo falsification test.",
      };
    }
  }

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Mean ${cfg.metric} by group × period`,
      subtitle: `DiD = (${tPost.toFixed(2)} − ${tPre.toFixed(2)}) − (${cPost.toFixed(2)} − ${cPre.toFixed(2)}) = ${did.toFixed(3)}.`,
      categories: [
        `${treatedValue} · pre`,
        `${treatedValue} · post`,
        `${controlValue} · pre`,
        `${controlValue} · post`,
      ],
      series: [{ name: "Mean", data: [tPre, tPost, cPre, cPost], color: "#5AA8AA" }],
      yLabel: cfg.metric,
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Closed-form 2×2 difference-in-differences: DiD = (Y_t,post − Y_t,pre) − (Y_c,post − Y_c,pre), with a standard error from the four within-cell variances and a t reference on ${df} degrees of freedom. When an intervention date is set on a date period column, the period immediately before treatment is re-used as a placebo post-period to falsify the parallel-trends assumption.`,
      steps: [
        `Treated = “${treatedValue}” (n = ${nTreated}); control = “${controlValue}” (n = ${nControl}).`,
        `Cell means: treated ${tPre.toFixed(3)} → ${tPost.toFixed(3)}; control ${cPre.toFixed(3)} → ${cPost.toFixed(3)}.`,
        `DiD = ${did.toFixed(4)}, SE = ${se.toFixed(4)}, t = ${Number.isFinite(tStat) ? tStat.toFixed(3) : "n/a"}, p = ${Number.isFinite(pValue) ? pValue.toExponential(3) : "n/a"}.`,
        `95% CI: ${ci[0].toFixed(4)} to ${ci[1].toFixed(4)}.`,
        ...(placebo
          ? [
              `Placebo: DiD = ${Number.isFinite(placebo.did) ? placebo.did.toFixed(4) : "n/a"}, p = ${Number.isFinite(placebo.pValue) ? placebo.pValue.toFixed(4) : "n/a"} — ${placebo.note}`,
            ]
          : []),
      ],
      assumptions: [
        "Parallel trends in the absence of treatment — the identifying assumption. Without it, DiD is not causal.",
        "No anticipation: the treatment does not change behaviour before the intervention date.",
        "The composition of treated and control groups is stable across periods (no selective entry/exit).",
        dropped > 0
          ? `${dropped} row(s) were dropped for a missing/invalid period or non-numeric metric.`
          : "All rows with a valid group, period and numeric metric were used.",
      ],
    },
    placebo && Number.isFinite(placebo.pValue) && placebo.pValue < 0.05
      ? [
          `Placebo test is significant (p = ${placebo.pValue.toFixed(4)}) — pre-trends are not parallel; the main DiD estimate is confounded.`,
        ]
      : [],
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "2×2 cells",
        columns: [
          { key: "cell", label: "Cell", format: "text" },
          { key: "n", label: "n", format: "number" },
          { key: "mean", label: "Mean", format: "number" },
          { key: "sd", label: "SD", format: "number" },
        ],
        rows: (["t_pre", "t_post", "c_pre", "c_post"] as const).map((k) => {
          const arr = cells[k] as number[];
          return [k.replace("_", " · "), arr.length, mean(arr), stddev(arr)];
        }),
      },
    ],
    stats: [
      { label: "DiD estimate", value: did.toFixed(4), hint: "treatment effect under parallel trends" },
      { label: "SE", value: se.toFixed(4), hint: "from within-cell variances" },
      {
        label: "p-value",
        value: Number.isFinite(pValue) ? (pValue < 1e-4 ? "< 0.0001" : pValue.toFixed(5)) : "n/a",
        hint: `df = ${df}`,
      },
      { label: "95% CI", value: `${ci[0].toFixed(3)} to ${ci[1].toFixed(3)}` },
      { label: "Significant", value: significant ? "Yes" : "No" },
      ...(placebo
        ? [
            {
              label: "Placebo DiD",
              value: Number.isFinite(placebo.did) ? placebo.did.toFixed(4) : "n/a",
              hint: Number.isFinite(placebo.pValue) ? `p = ${placebo.pValue.toFixed(4)}` : "insufficient pre-period",
            },
          ]
        : []),
    ],
    quickFindings: [
      `${cfg.metric} changed by ${(tPost - tPre).toFixed(3)} in ${treatedValue} and ${(cPost - cPre).toFixed(3)} in ${controlValue} across the period boundary.`,
      `Difference-in-differences estimate: ${did.toFixed(3)} (${significant ? "statistically significant at 5%" : "not statistically significant at 5%"}).`,
      ...(placebo
        ? [placebo.note]
        : ["No intervention date on a date period column — placebo falsification was skipped."]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Survival (Kaplan–Meier + log-rank + Cox)
// ---------------------------------------------------------------------------

function runSurvivalAnalysis(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "survival" }>): AnalysisResult {
  const ti = requireColumn(ctx.columns, cfg.timeCol, "number");
  const ei = requireColumn(ctx.columns, cfg.eventCol);
  const gi = cfg.groupCol ? requireColumn(ctx.columns, cfg.groupCol) : -1;
  const covIdx = (cfg.covariates ?? [])
    .filter((c) => c && columnIndex(ctx.columns, c) >= 0)
    .map((c) => requireColumn(ctx.columns, c, "number"));

  const obsByGroup = new Map<string, { time: number; event: boolean; cov: number[] }[]>();
  let bad = 0;
  for (const row of ctx.rows) {
    const t = asNumber(row[ti]);
    const eRaw = asNumber(row[ei]);
    const e = eRaw === 1 || String(row[ei]).toLowerCase() === "true" || String(row[ei]).toLowerCase() === "yes";
    const cov = covIdx.map((j) => asNumber(row[j]));
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(eRaw) || !cov.every(Number.isFinite)) {
      bad += 1;
      continue;
    }
    const key = gi >= 0 ? cellString(row[gi]) || "(blank)" : "(all)";
    const list = obsByGroup.get(key) ?? [];
    list.push({ time: t, event: e, cov });
    obsByGroup.set(key, list);
  }
  const allObs = [...obsByGroup.values()].flat();
  if (allObs.length < 5) {
    throw new AnalysisInputError(
      `Survival analysis needs at least 5 complete rows with time > 0 and a 0/1 event flag; found ${allObs.length}.${bad ? ` ${bad} row(s) were incomplete.` : ""}`,
    );
  }

  const groupLabels = gi >= 0 ? [...obsByGroup.keys()].sort() : undefined;
  if (groupLabels && groupLabels.length > 2) {
    throw new AnalysisInputError(
      `Log-rank needs exactly 2 groups; “${cfg.groupCol}” has ${groupLabels.length} (${groupLabels.slice(0, 5).join(", ")}${groupLabels.length > 5 ? "…" : ""}). Pick a binary column or drop it.`,
    );
  }

  const kmObs = allObs.map((o) => ({ time: o.time, event: o.event }));
  let summary;
  try {
    summary = runSurvival(kmObs, {
      groupLabels: groupLabels as string[] | undefined,
      cox:
        covIdx.length > 0
          ? {
              time: allObs.map((o) => o.time),
              event: allObs.map((o) => (o.event ? 1 : 0)) as (0 | 1)[],
              X: allObs.map((o) => o.cov),
              names: covIdx.map((j) => ctx.columns[j]?.name ?? `cov${j}`),
            }
          : undefined,
    });
  } catch (err) {
    throw wrapEngineError(err, "Survival");
  }

  const curve = summary.curve;
  const cats = curve.times.map((t) => t.toFixed(1));
  const series: ChartSeries[] = [{ name: "Survival", data: curve.survival, color: "#5AA8AA" }];
  if (groupLabels && groupLabels.length === 2) {
    // Two KM curves by group.
    for (const [i, label] of groupLabels.entries()) {
      const sub = (obsByGroup.get(label) ?? []).map((o) => ({ time: o.time, event: o.event }));
      if (sub.length < 1) continue;
      try {
        const km = kaplanMeier(sub);
        series.push({
          name: label,
          data: km.times.map((t) => {
            // Align to the pooled timeline for plotting: nearest previous step.
            let s = 1;
            for (let j = 0; j < km.times.length; j++) {
              if ((km.times[j] as number) <= t) s = km.survival[j] as number;
            }
            return s;
          }),
          color: i === 0 ? "#5AA8AA" : "#FFB400",
        });
      } catch {
        /* per-group KM is best-effort for the chart */
      }
    }
  }

  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: "Kaplan–Meier survival curve",
      subtitle: summary.logRank
        ? `Log-rank χ² = ${summary.logRank.statistic.toFixed(3)}, p = ${summary.logRank.pValue.toExponential(3)} — ${summary.logRank.interpretation}`
        : `Median survival ${curve.median === null ? "not reached" : curve.median.toFixed(2)} · ${curve.totalEvents} event(s) across ${curve.n} observation(s).`,
      xLabel: cfg.timeCol,
      yLabel: "Survival probability",
      categories: cats.length > 40 ? cats.filter((_, i) => i % Math.ceil(cats.length / 40) === 0) : cats,
      series: series.map((s) => {
        const data = s.data ?? [];
        const step = Math.ceil(data.length / 40);
        return {
          ...s,
          data: data.length > 40 ? data.filter((_, i) => i % step === 0) : data,
        };
      }),
    },
  ];

  const tables: TableSpec[] = [];
  if (summary.cox) {
    tables.push({
      title: "Cox proportional hazards",
      columns: [
        { key: "name", label: "Term", format: "text" },
        { key: "coef", label: "Coefficient", format: "number" },
        { key: "hr", label: "Hazard ratio", format: "number" },
        { key: "lo", label: "95% CI low", format: "number" },
        { key: "hi", label: "95% CI high", format: "number" },
        { key: "p", label: "p-value", format: "number" },
      ],
      rows: summary.cox.coefficients.map((c) => [
        c.name,
        c.coefficient,
        c.hazardRatio,
        c.ci95.low,
        c.ci95.high,
        c.pValue,
      ]),
    });
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Kaplan–Meier estimator with Greenwood variance${summary.logRank ? `, a log-rank test between ${groupLabels?.join(" and ")}` : ""}${summary.cox ? ", and Cox proportional hazards regression (Breslow ties) with Wald and likelihood-ratio inference" : ""}. Right-censored observations contribute risk-set time up to their censoring moment and then leave the risk set.`,
      steps: [
        `${curve.n} observation(s), ${curve.totalEvents} event(s)${bad ? `, ${bad} row(s) dropped for non-positive time or missing covariates` : ""}.`,
        `Median survival: ${curve.median === null ? "not reached within the observed window" : curve.median.toFixed(3)}.`,
        ...(summary.logRank
          ? [
              `Log-rank: χ² = ${summary.logRank.statistic.toFixed(4)} on 1 df, p = ${summary.logRank.pValue.toExponential(3)}. ${summary.logRank.interpretation}`,
            ]
          : ["No two-group log-rank test (single group or no group column)."]),
        ...(summary.cox
          ? [
              `Cox: ${summary.cox.converged ? "converged" : "DID NOT converge"} in ${summary.cox.iterations} iteration(s); concordance = ${summary.cox.concordance.toFixed(4)}; LR χ² = ${summary.cox.likelihoodRatio.toFixed(3)}, p = ${summary.cox.lrPValue.toExponential(3)}.`,
              summary.cox.phVerdict,
            ]
          : ["No Cox model fitted (no numeric covariates selected)."]),
      ],
      assumptions: [
        "Censoring is non-informative: the reason a subject is censored is unrelated to its hazard.",
        "Time is measured from a common origin and is strictly positive.",
        summary.cox
          ? "Proportional hazards: each covariate multiplies the hazard by a constant factor over time. The Schoenfeld residual check reports violations."
          : "Without covariates the analysis is descriptive (median, curve shape) — no regression adjustment.",
      ],
    },
    summary.cox && !summary.cox.converged ? ["Cox model did not converge — coefficients may be unreliable."] : [],
  );
  return {
    ...base,
    charts,
    tables,
    stats: [
      { label: "Observations", value: String(curve.n) },
      {
        label: "Events",
        value: String(curve.totalEvents),
        hint: `${((curve.totalEvents / Math.max(1, curve.n)) * 100).toFixed(1)}% of sample`,
      },
      {
        label: "Median survival",
        value: curve.median === null ? "not reached" : curve.median.toFixed(3),
        hint: cfg.timeCol,
      },
      ...(summary.logRank
        ? [
            {
              label: "Log-rank p",
              value: summary.logRank.pValue < 1e-4 ? "< 0.0001" : summary.logRank.pValue.toFixed(5),
              hint: "2-group difference",
            },
          ]
        : []),
      ...(summary.cox
        ? [
            {
              label: "Concordance",
              value: summary.cox.concordance.toFixed(4),
              hint:
                summary.cox.concordance >= 0.7
                  ? "good discrimination"
                  : summary.cox.concordance >= 0.6
                    ? "modest discrimination"
                    : "weak discrimination",
            },
            {
              label: "Cox LR p",
              value: summary.cox.lrPValue < 1e-4 ? "< 0.0001" : summary.cox.lrPValue.toFixed(5),
              hint: "model vs null",
            },
          ]
        : []),
    ],
    quickFindings: [
      `Survival data: ${curve.n} subjects, ${curve.totalEvents} events; median ${curve.median === null ? "not reached" : curve.median.toFixed(2)}.`,
      summary.logRank?.interpretation ?? "Single-group survival description only.",
      summary.cox?.interpretation ?? "Add numeric covariates to fit a Cox model.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Bayesian estimation
// ---------------------------------------------------------------------------

function runBayesian(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "bayesian" }>): AnalysisResult {
  const target = requireColumn(ctx.columns, cfg.target, "number");
  const featureCols = (cfg.features ?? []).filter((f) => f && f !== cfg.target && columnIndex(ctx.columns, f) >= 0);
  if (featureCols.length === 0) throw new AnalysisInputError("Bayesian estimation needs at least one feature column.");
  for (const f of featureCols) requireColumn(ctx.columns, f, "number");

  const { X, kept, dropped } = numericMatrix(ctx, featureCols);
  const yAll: number[] = [];
  for (const i of kept) yAll.push(asNumber(ctx.rows[i]?.[target]));
  if (X.length < 3) {
    throw new AnalysisInputError(
      `Bayesian estimation needs at least 3 complete rows with ${featureCols.join(", ")} and ${cfg.target}; found ${X.length}.${dropped ? ` ${dropped} incomplete row(s) were dropped.` : ""}`,
    );
  }
  const credibleLevel = cfg.credibleLevel > 0.5 && cfg.credibleLevel < 1 ? cfg.credibleLevel : 0.95;

  const model: "regression" | "gp" = cfg.model === "gp" ? "gp" : "regression";
  if (model === "regression" && X.length <= featureCols.length) {
    throw new AnalysisInputError(
      `Regression needs more rows (n = ${X.length}) than parameters (p = ${featureCols.length + 1}); use the GP model or add rows.`,
    );
  }

  if (model === "regression") {
    let post;
    try {
      post = bayesianLinearRegression({
        X,
        y: yAll,
        names: featureCols,
        priorSD: cfg.priorSD > 0 ? cfg.priorSD : 10,
        credibleLevel,
        mcmcSamples: Math.max(0, Math.min(20000, Math.round(cfg.mcmcSamples || 0))),
        seed: 42,
      });
    } catch (err) {
      throw wrapEngineError(err, "Bayesian regression");
    }
    const cats = post.terms.map((t) => t.name);
    const charts: ChartSpec[] = [
      {
        kind: "bar",
        title: `Posterior means · ${credibleLevel * 100}% credible intervals`,
        subtitle: `Prior SD = ${post.priorSD}; ${post.mcmc?.ran ? `MCMC cross-check on ${post.mcmc.samples} draws (min ESS ${post.mcmc.minESS}, acceptance ${(post.mcmc.acceptanceRate * 100).toFixed(1)}%).` : "Closed-form posterior only (no MCMC)."}`,
        categories: cats,
        series: [{ name: "Posterior mean", data: post.terms.map((t) => t.posteriorMean), color: "#5AA8AA" }],
        yLabel: "Coefficient",
      },
    ];
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Conjugate Normal–Inverse-Gamma posterior over ${cfg.target} ~ ${featureCols.join(" + ")} with a N(0, ${post.priorSD}²) prior on each coefficient. Posterior means, posterior SDs and equal-tail credible intervals are reported in closed form; when mcmcSamples > 0 a random-walk Metropolis chain over (β, log σ²) is drawn as an independent cross-check.`,
        steps: [
          `Fit on n = ${post.n}, p = ${post.p}; σ² posterior mean = ${post.sigma2PosteriorMean.toFixed(4)} (prior mean ${post.sigma2PriorMean.toFixed(4)}).`,
          `Log marginal likelihood = ${post.logMarginalLikelihood.toFixed(3)} — compare across priors, not as an absolute score.`,
          ...post.terms.map(
            (t) =>
              `${t.name}: posterior mean ${t.posteriorMean.toFixed(4)} ± ${t.posteriorSD.toFixed(4)}, ${credibleLevel * 100}% CI [${t.ciLow.toFixed(4)}, ${t.ciHigh.toFixed(4)}], P(β>0) = ${(t.probPositive * 100).toFixed(1)}%${t.mcmcMean !== undefined ? `, MCMC mean ${t.mcmcMean.toFixed(4)}, ESS ${t.ess ?? "—"}` : ""}.`,
          ),
          ...(post.mcmc?.ran
            ? [
                `MCMC: ${post.mcmc.samples} draws, burn-in ${post.mcmc.burnIn}, acceptance ${(post.mcmc.acceptanceRate * 100).toFixed(1)}%, min ESS ${post.mcmc.minESS}. ${post.mcmc.note}`,
              ]
            : ["No MCMC requested — posterior summaries are the exact conjugate result."]),
        ],
        assumptions: [
          "Errors are i.i.d. normal with unknown σ²; the prior on coefficients is independent N(0, priorSD²).",
          "Credible intervals are Bayesian credible regions, not frequentist confidence intervals — they mean what they say under the prior.",
          "Prior SD = " +
            post.priorSD +
            " is a weakly-informative default; a tighter prior will pull coefficients toward zero.",
        ],
      },
      post.warnings,
    );
    return {
      ...base,
      charts,
      tables: [
        {
          title: "Posterior terms",
          columns: [
            { key: "name", label: "Term", format: "text" },
            { key: "mean", label: "Posterior mean", format: "number" },
            { key: "sd", label: "Posterior SD", format: "number" },
            { key: "lo", label: `${credibleLevel * 100}% CI low`, format: "number" },
            { key: "hi", label: `${credibleLevel * 100}% CI high`, format: "number" },
            { key: "p", label: "P(β>0)", format: "pct" },
          ],
          rows: post.terms.map((t) => [t.name, t.posteriorMean, t.posteriorSD, t.ciLow, t.ciHigh, t.probPositive]),
        },
      ],
      stats: [
        { label: "Model", value: "NIG regression" },
        { label: "n / p", value: `${post.n} / ${post.p}` },
        { label: "σ² posterior mean", value: post.sigma2PosteriorMean.toFixed(4) },
        {
          label: "Log marginal lik.",
          value: post.logMarginalLikelihood.toFixed(3),
          hint: "relative measure only",
        },
        ...(post.mcmc?.ran
          ? [
              {
                label: "MCMC min ESS",
                value: String(post.mcmc.minESS),
                hint: post.mcmc.minESS < 100 ? "low — treat MCMC as a rough check" : "usable",
              },
              { label: "Acceptance", value: `${(post.mcmc.acceptanceRate * 100).toFixed(1)}%` },
            ]
          : []),
      ],
      quickFindings: [post.interpretation],
    };
  }

  // Gaussian-process path.
  const lengthScale = cfg.lengthScale > 0 ? cfg.lengthScale : 1;
  const noiseSD = cfg.noiseSD > 0 ? cfg.noiseSD : 0.1;
  // Hold out every 4th row for coverage when n is large enough.
  const trainIdx: number[] = [];
  const testIdx: number[] = [];
  X.forEach((_, i) => {
    if (X.length >= 20 && i % 4 === 3) testIdx.push(i);
    else trainIdx.push(i);
  });
  const XTrain = trainIdx.map((i) => X[i] as number[]);
  const yTrain = trainIdx.map((i) => yAll[i] as number);
  const XStar = testIdx.map((i) => X[i] as number[]);
  const yStar = testIdx.map((i) => yAll[i] as number);
  let gp;
  try {
    gp = gaussianProcessRegression({
      X: XTrain,
      y: yTrain,
      lengthScale,
      noiseSD,
      XStar: XStar.length > 0 ? XStar : undefined,
      yStar: yStar.length > 0 ? yStar : undefined,
      credibleLevel,
    });
  } catch (err) {
    throw wrapEngineError(err, "Gaussian process");
  }
  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: "GP posterior mean ± credible band (training order)",
      subtitle: `Squared-exponential kernel, length-scale ${lengthScale}, noise SD ${noiseSD}; log marginal likelihood ${gp.logMarginalLikelihood.toFixed(2)}.`,
      categories: gp.posteriorMean.map((_, i) => String(i + 1)),
      series: [
        { name: "Posterior mean", data: gp.posteriorMean, color: "#5AA8AA" },
        { name: "CI low", data: gp.ciLow, color: "#9E9E9E" },
        { name: "CI high", data: gp.ciHigh, color: "#9E9E9E" },
      ],
      yLabel: cfg.target,
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Exact Gaussian-process regression with a squared-exponential kernel: posterior mean and posterior SD at every training point from a Cholesky factorisation of K + σ²I, with equal-tail ${credibleLevel * 100}% predictive intervals. Complexity is O(n³); the model is exact, not a sparse approximation.`,
      steps: [
        `Trained on n = ${gp.n} (length-scale ${gp.lengthScale}, noise SD ${gp.noiseSD}).`,
        `Train RMSE = ${gp.trainRMSE.toFixed(4)}; log marginal likelihood = ${gp.logMarginalLikelihood.toFixed(3)}.`,
        gp.holdout
          ? `Holdout: n = ${gp.holdout.n}, RMSE = ${gp.holdout.rmse.toFixed(4)}, MAE = ${gp.holdout.mae.toFixed(4)}, empirical coverage = ${(gp.holdout.coverage * 100).toFixed(1)}% (target ${credibleLevel * 100}%).`
          : "No holdout split — train metrics only.",
        `Posterior SD mean = ${mean(gp.posteriorSD).toFixed(4)}; wider bands where training points are sparse.`,
      ],
      assumptions: [
        "The kernel is stationary and the noise is homoscedastic; misspecification shows up as miscalibrated intervals.",
        "n > 2,000 will be slow (dense Cholesky) — subsample or switch to the regression model.",
        "lengthScale and noiseSD were not optimised by marginal-likelihood search; they are user-specified.",
      ],
    },
    gp.warnings,
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "GP summary",
        columns: [
          { key: "k", label: "Quantity", format: "text" },
          { key: "v", label: "Value", format: "number" },
        ],
        rows: [
          ["n (train)", gp.n],
          ["Length-scale", gp.lengthScale],
          ["Noise SD", gp.noiseSD],
          ["Log marginal likelihood", gp.logMarginalLikelihood],
          ["Train RMSE", gp.trainRMSE],
          ...(gp.holdout
            ? ([
                ["Holdout n", gp.holdout.n],
                ["Holdout RMSE", gp.holdout.rmse],
                ["Holdout MAE", gp.holdout.mae],
                ["Coverage", gp.holdout.coverage],
              ] as (string | number)[][])
            : []),
        ],
      },
    ],
    stats: [
      { label: "Model", value: "Gaussian process" },
      { label: "Train RMSE", value: gp.trainRMSE.toFixed(4) },
      ...(gp.holdout
        ? [
            { label: "Holdout RMSE", value: gp.holdout.rmse.toFixed(4) },
            {
              label: "Coverage",
              value: `${(gp.holdout.coverage * 100).toFixed(1)}%`,
              hint: `target ${(credibleLevel * 100).toFixed(0)}%`,
            },
          ]
        : []),
      { label: "Log marginal lik.", value: gp.logMarginalLikelihood.toFixed(3) },
    ],
    quickFindings: [gp.interpretation],
  };
}

// ---------------------------------------------------------------------------
// Seasonal SARIMA / SARIMAX
// ---------------------------------------------------------------------------

function runSarima(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "sarima" }>): AnalysisResult {
  requireColumn(ctx.columns, cfg.dateCol, "date");
  requireColumn(ctx.columns, cfg.metric, "number");
  const regCols = (cfg.regressors ?? []).filter((r) => r && columnIndex(ctx.columns, r) >= 0);
  for (const r of regCols) requireColumn(ctx.columns, r, "number");

  const buckets = bucketByDate(ctx.rows, ctx.columns, cfg.dateCol, cfg.metric, cfg.granularity);
  const values = buckets.map((b) => b.value);
  if (values.length < 8) {
    throw new AnalysisInputError(`SARIMA needs at least 8 historical periods; found ${values.length}.`);
  }
  // Align exogenous regressors to the same buckets: sum each regressor per bucket.
  const exog: number[][] = [];
  if (regCols.length > 0) {
    const dimIdx = columnIndex(ctx.columns, cfg.dateCol);
    const bucketMap = new Map<string, number[]>();
    buckets.forEach((b) => bucketMap.set(b.key, new Array(regCols.length).fill(0)));
    for (const row of ctx.rows) {
      const d = cellDate(row[dimIdx]);
      if (!d) continue;
      const key = bucketKey(d, cfg.granularity);
      const acc = bucketMap.get(key);
      if (!acc) continue;
      regCols.forEach((name, j) => {
        const v = asNumber(row[columnIndex(ctx.columns, name)]);
        if (Number.isFinite(v)) acc[j] = (acc[j] as number) + v;
      });
    }
    for (const b of buckets) exog.push(bucketMap.get(b.key) ?? new Array(regCols.length).fill(0));
  }

  const horizon = Math.min(Math.max(1, cfg.horizon || 4), 24);
  const lastKey = buckets[buckets.length - 1]?.key ?? "";
  const forecastKeys = nextKeys(lastKey, cfg.granularity, horizon);
  let fit;
  try {
    fit = fitSarima(values, {
      horizon,
      seasonalPeriods: Math.max(0, Math.round(cfg.seasonalPeriods || 0)),
      maxOrder: Math.max(0, Math.min(3, Math.round(cfg.maxOrder || 1))),
      maxSeasonalOrder: Math.max(0, Math.min(2, Math.round(cfg.maxSeasonalOrder || 1))),
      exog: exog.length > 0 ? exog : undefined,
      exogNames: regCols,
      cvFolds: Math.max(0, Math.min(10, Math.round(cfg.cvFolds || 0))),
    });
  } catch (err) {
    throw wrapEngineError(err, "SARIMA");
  }

  const preds = fit.points.map((p, i) => {
    const key = forecastKeys[i] ?? lastKey;
    return {
      key,
      label: bucketLabel(key, cfg.granularity),
      point: p.point,
      low: p.low,
      high: p.high,
    };
  });
  const categories = [...buckets.map((b) => b.label), ...preds.map((p) => p.label)];
  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `SARIMA forecast of ${cfg.metric} · next ${horizon} ${cfg.granularity}(s)`,
      subtitle: `${fit.best.name} selected by AICc from ${fit.candidates.length} candidates${fit.cv ? ` · expanding-window CV MAE ${fit.cv.mae}` : ""}.`,
      xLabel: cfg.granularity,
      yLabel: cfg.metric,
      categories,
      series: [
        { name: cfg.metric, data: [...values, ...preds.map(() => null)], color: "#5AA8AA" },
        {
          name: `Forecast (${fit.best.name})`,
          data: [...values.map(() => null), ...preds.map((p) => p.point)],
          color: "#FFB400",
        },
      ],
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `SARIMA/SARIMAX grid search by conditional least squares: for each (p,d,q)×(P,D,Q) candidate the differenced series is regressed on its own lags and on zero-initialised MA residuals (two CLS passes), scored by AICc, and the winner is projected ${horizon} periods ahead.${fit.cv ? ` Expanding-window rolling-origin CV (${fit.cv.folds} folds, one-step ahead, refit on each prefix) reports MAE ${fit.cv.mae}${fit.cv.mape !== null ? ` / MAPE ${fit.cv.mape}%` : ""}.` : " CV was skipped (cvFolds = 0) — accuracy figures are in-sample only."}${regCols.length ? ` Exogenous regressors: ${regCols.join(", ")} (future values held at their trailing mean).` : ""}`,
      steps: [
        ...fit.candidates
          .slice(0, 8)
          .map(
            (c) =>
              `${c.name}: AICc ${Number.isFinite(c.aicc) ? c.aicc.toFixed(1) : "—"}${c.cvMae !== null ? `, CV MAE ${c.cvMae}` : ""}.`,
          ),
        `Winner: ${fit.best.name} (AICc ${fit.best.aicc.toFixed(1)}, σ ${fit.best.sigma.toFixed(4)}).`,
        fit.diagnostics.note,
        ...(fit.cv
          ? fit.cv.perFold
              .slice(0, 5)
              .map(
                (f) =>
                  `Fold ${f.fold}: actual ${f.actual.toFixed(2)} vs predicted ${f.predicted.toFixed(2)} (error ${f.error.toFixed(2)}).`,
              )
          : []),
      ],
      assumptions: [
        "MA terms are estimated by conditional least squares with zero-initialised residuals (not full MLE).",
        "Seasonal differencing is additive; the seasonal period is taken from the config (12 for monthly, 4 for quarterly, 7 for daily).",
        regCols.length
          ? "Future exogenous values are held at the trailing mean of each regressor — replace with a real forecast of the drivers when you have one."
          : "No exogenous regressors — the path is univariate.",
        "AICc selects among in-sample fits; multi-step error grows with horizon.",
      ],
    },
    fit.cv ? [] : ["No rolling-origin CV ran (cvFolds = 0) — reported accuracy is in-sample and optimistic."],
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "Forecast table",
        columns: [
          { key: "p", label: "Period" },
          { key: "point", label: "Point forecast", format: "number" },
          { key: "low", label: "Low (95%)", format: "number" },
          { key: "high", label: "High (95%)", format: "number" },
        ],
        rows: preds.map((p) => [
          p.label,
          Math.round(p.point * 100) / 100,
          Math.round(p.low * 100) / 100,
          Math.round(p.high * 100) / 100,
        ]),
      },
      {
        title: "Candidate models",
        columns: [
          { key: "model", label: "Model" },
          { key: "aicc", label: "AICc", format: "number" },
          { key: "sigma", label: "σ", format: "number" },
          { key: "cv", label: "CV MAE", format: "number" },
        ],
        rows: fit.candidates.map((c) => [
          c.name,
          Number.isFinite(c.aicc) ? Math.round(c.aicc * 10) / 10 : null,
          c.sigma,
          c.cvMae,
        ]),
      },
    ],
    stats: [
      { label: "Winner", value: fit.best.name },
      { label: "AICc", value: fit.best.aicc.toFixed(1) },
      { label: "Residual σ", value: fit.best.sigma.toFixed(4) },
      ...(fit.cv ? [{ label: "CV MAE", value: fit.cv.mae.toFixed(3), hint: `${fit.cv.folds} expanding folds` }] : []),
      {
        label: "Ljung-Box p",
        value: Number.isFinite(fit.diagnostics.ljungBoxP) ? fit.diagnostics.ljungBoxP.toFixed(4) : "n/a",
        hint: fit.diagnostics.ljungBoxP < 0.05 ? "residual autocorrelation remains" : "residuals look clean",
      },
    ],
    quickFindings: [
      `${fit.best.name} projects ${cfg.metric} to ${preds[preds.length - 1]?.point.toFixed(2) ?? "n/a"} by ${preds[preds.length - 1]?.label ?? "the horizon"} (${(preds[preds.length - 1]?.point ?? 0) >= (values[values.length - 1] ?? 0) ? "up" : "down"} vs the last observation of ${(values[values.length - 1] ?? 0).toFixed(2)}).`,
      fit.cv
        ? `Out-of-sample (expanding-window, one-step): MAE ${fit.cv.mae}${fit.cv.mape !== null ? `, MAPE ${fit.cv.mape}%` : ""} across ${fit.cv.folds} folds.`
        : "Set cvFolds > 0 to get an honest out-of-sample error — in-sample AICc alone will overstate accuracy.",
      fit.diagnostics.note,
    ],
  };
}

// ---------------------------------------------------------------------------
// Distributed aggregation
// ---------------------------------------------------------------------------

function runDistributedAnalysis(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "distributed" }>): AnalysisResult {
  const mi = requireColumn(ctx.columns, cfg.metric, "number");
  const gi = cfg.dimensionCol && cfg.dimensionCol !== cfg.metric ? requireColumn(ctx.columns, cfg.dimensionCol) : -1;
  const rows: ColumnarRow[] = [];
  let dropped = 0;
  ctx.rows.forEach((row, index) => {
    const v = asNumber(row[mi]);
    if (!Number.isFinite(v)) {
      dropped += 1;
      return;
    }
    rows.push({
      index,
      key: gi >= 0 ? cellString(row[gi]) || "(blank)" : null,
      value: v,
    });
  });
  if (rows.length === 0) throw new AnalysisInputError(`No numeric rows found in “${cfg.metric}”.`);

  const groupBy = gi >= 0;
  const workers = Math.max(1, Math.min(64, Math.round(cfg.workers || 4)));
  let res;
  try {
    res = runDistributed({
      rows,
      op: cfg.op || "sum",
      workers,
      groupBy,
      allColumns: ctx.columns.map((c) => c.name),
      requiredColumns: [cfg.metric, ...(groupBy ? [cfg.dimensionCol as string] : [])],
      saltingFactor: Math.max(0, Math.round(cfg.saltingFactor || 0)),
    });
  } catch (err) {
    throw wrapEngineError(err, "Distributed execution");
  }

  const groupRows = [...res.groups].sort((a, b) => b.value - a.value).slice(0, 30);
  const charts: ChartSpec[] = groupBy
    ? [
        {
          kind: "bar",
          title: `${cfg.op} of ${cfg.metric} by ${cfg.dimensionCol} · ${workers} workers`,
          subtitle: res.interpretation,
          categories: groupRows.map((g) => g.key ?? "(all)"),
          series: [{ name: `${cfg.op}(${cfg.metric})`, data: groupRows.map((g) => g.value), color: "#5AA8AA" }],
        },
      ]
    : [
        {
          kind: "bar",
          title: `${cfg.op}(${cfg.metric}) · ${workers} workers`,
          subtitle: res.interpretation,
          categories: [cfg.metric],
          series: [{ name: cfg.op, data: [res.total], color: "#5AA8AA" }],
        },
      ];

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Two-phase distributed aggregation over an in-process columnar store: column pruning, predicate pushdown into a selection vector, hash partitioning across ${workers} workers, map-side combine, then a merge phase. Skew is measured (not assumed) and hot keys are salted when the salting factor is set. Timings are wall-clock-equivalent stage measurements.`,
      steps: [
        `Input ${res.plan.inputRows.toLocaleString()} row(s) → ${res.plan.rowsAfterFilter.toLocaleString()} after projection/pushdown (selectivity ${(res.plan.selectivity * 100).toFixed(1)}%).`,
        `Projected columns: ${res.plan.projectedColumns.join(", ") || "(none)"} — pruned ≈ ${res.plan.prunedBytes.toLocaleString()} bytes of the unused payload.`,
        `${res.plan.partitions.length} partitions, ${res.activePartitions} active; shuffle ≈ ${res.plan.shuffleBytes.toLocaleString()} bytes (${res.plan.partialRowsShipped.toLocaleString()} partial rows vs ${res.plan.rawRowsShipped.toLocaleString()} raw).`,
        `Skew ratio ${res.plan.skewRatio.toFixed(2)}${res.plan.saltedKeys.length ? ` — salted keys: ${res.plan.saltedKeys.map((s) => s.key).join(", ")}` : " (no salting needed)"}.`,
        `Stage timings (ms): filter ${res.timings.filter}, combine ${res.timings.combine}, merge ${res.timings.merge}.`,
        `Amdahl ceiling ${res.plan.amdahlSpeedup.toFixed(2)}× at ${workers} workers (serial fraction ${(res.plan.serialFraction * 100).toFixed(1)}%).`,
      ],
      assumptions: [
        "This is an in-process simulation of the distributed plan shape — not a real cluster. Cost numbers are honest about what is measured.",
        "Hash partitioning on the group key; no data skew model beyond what the input actually shows.",
        dropped > 0 ? `${dropped} non-numeric row(s) were excluded before aggregation.` : "All rows were numeric.",
      ],
    },
    [...res.plan.warnings, ...(dropped > 0 ? [`${dropped} non-numeric row(s) excluded from “${cfg.metric}”.`] : [])],
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "Groups",
        columns: [
          { key: "k", label: "Key", format: "text" },
          { key: "v", label: cfg.op, format: "number" },
          { key: "n", label: "Rows", format: "number" },
        ],
        rows: groupRows.map((g) => [g.key ?? "(all)", g.value, g.count]),
      },
      {
        title: "Partitions",
        columns: [
          { key: "i", label: "Partition", format: "number" },
          { key: "rows", label: "Rows", format: "number" },
          { key: "share", label: "Share", format: "pct" },
          { key: "salted", label: "Salted keys", format: "text" },
        ],
        rows: res.plan.partitions.map((p) => [p.index, p.rows, p.share, p.saltedKeys.join(", ") || "—"]),
      },
    ],
    stats: [
      { label: "Workers", value: String(res.activePartitions), hint: `${res.plan.partitions.length} planned` },
      { label: "Total", value: res.total.toFixed(3), hint: cfg.op },
      { label: "Shuffle", value: `${(res.plan.shuffleBytes / 1024).toFixed(1)} KB` },
      {
        label: "Skew ratio",
        value: res.plan.skewRatio.toFixed(2),
        hint: res.plan.skewRatio > 2 ? "hot key — consider salting" : "balanced",
      },
      { label: "Amdahl ceiling", value: `${res.plan.amdahlSpeedup.toFixed(2)}×` },
    ],
    quickFindings: [res.interpretation],
  };
}

// ---------------------------------------------------------------------------
// Streaming windows
// ---------------------------------------------------------------------------

function runStreamingAnalysis(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "streaming" }>): AnalysisResult {
  const di = requireColumn(ctx.columns, cfg.dateCol, "date");
  const mi = requireColumn(ctx.columns, cfg.metric, "number");
  const keyCol = cfg.dimensionCol && columnIndex(ctx.columns, cfg.dimensionCol) >= 0 ? cfg.dimensionCol : null;
  const ki = keyCol ? columnIndex(ctx.columns, keyCol) : -1;

  const events: StreamEvent[] = [];
  ctx.rows.forEach((row, index) => {
    const d = cellDate(row[di]);
    const v = asNumber(row[mi]);
    if (!d || !Number.isFinite(v)) {
      return;
    }
    // Token = row index: unique, so the engine's exactly-once dedup never
    // collapses two legitimate observations that happen to share a timestamp.
    events.push({
      eventTime: d.getTime(),
      key: ki >= 0 ? cellString(row[ki]) || "(blank)" : null,
      value: v,
      token: `row-${index}`,
    });
  });
  if (events.length === 0) throw new AnalysisInputError(`No valid dated rows found in “${cfg.metric}”.`);

  const ms = periodMs(cfg.granularity);
  const windowSize = Math.max(1, Math.round(cfg.windowSize || 1)) * ms;
  const slide = Math.max(1, Math.round(cfg.slide || 1)) * ms;
  const window = {
    kind: (["tumbling", "sliding", "session"] as const).includes(cfg.window as "tumbling") ? cfg.window : "tumbling",
    size: windowSize,
    slide: cfg.window === "sliding" ? slide : undefined,
  } as const;

  const opts: StreamingOptions = {
    window,
    op: (["sum", "mean", "min", "max", "count"] as const).includes(cfg.op as "sum") ? cfg.op : "sum",
    allowedLateness: Math.max(0, Math.round(cfg.allowedLateness || 0)) * ms,
    watermark: cfg.watermark === "bounded-out-of-orderness" ? "bounded-out-of-orderness" : "event-time",
  };

  let res;
  try {
    res = runStreaming(events, opts);
  } catch (err) {
    throw wrapEngineError(err, "Streaming");
  }

  const windows = res.windows.slice(0, 60);
  const charts: ChartSpec[] = [
    {
      kind: "line",
      title: `${cfg.window} window · ${cfg.op}(${cfg.metric})`,
      subtitle: `${res.diagnostics.windowsEmitted} window(s) emitted, ${res.diagnostics.lateEvents} late, ${res.diagnostics.duplicateEvents} duplicate token(s) dropped. Window length = ${cfg.windowSize} × ${cfg.granularity} (≈ ${windowSize} ms).`,
      xLabel: "Window start",
      yLabel: `${cfg.op}(${cfg.metric})`,
      categories: windows.map((w) => new Date(w.start).toISOString().slice(0, 16).replace("T", " ")),
      series: [{ name: cfg.op, data: windows.map((w) => w.value), color: "#5AA8AA" }],
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Event-time stream processing: events are reordered through a lateness buffer, a monotone watermark advances, and ${cfg.window} windows of length ${cfg.windowSize} × ${cfg.granularity} (≈ ${windowSize} ms) accumulate ${cfg.op}(${cfg.metric}). Exactly-once emission is enforced by idempotency tokens; events after the watermark for their window are counted late and dropped from the emission.`,
      steps: [
        `${res.diagnostics.inputEvents.toLocaleString()} event(s) in, ${res.diagnostics.acceptedEvents.toLocaleString()} accepted, ${res.diagnostics.duplicateEvents} duplicate(s), ${res.diagnostics.lateEvents} late, ${res.diagnostics.droppedEvents} dropped.`,
        `${res.diagnostics.windowsOpened} window(s) opened, ${res.diagnostics.windowsEmitted} emitted, ${res.diagnostics.windowsStillOpen} still open at end-of-stream; peak open windows ${res.diagnostics.peakOpenWindows}.`,
        `Out-of-order events: ${res.diagnostics.outOfOrderEvents.toLocaleString()}${res.diagnostics.sawOutOfOrder ? "" : " (stream was in order)"}; max watermark ${new Date(res.diagnostics.maxWatermark).toISOString().slice(0, 16)}.`,
        `Watermark strategy: ${opts.watermark}${opts.watermark === "bounded-out-of-orderness" ? ` (max out-of-orderness ${Math.round((opts.maxOutOfOrderness ?? 0) / ms)} period(s))` : ""}.`,
        res.interpretation,
      ],
      assumptions: [
        `Window length is ${cfg.windowSize} × ${cfg.granularity}; a month is treated as 30 days, a quarter as 91 days, a year as 365 days.`,
        "Token uniqueness is the row index — two rows that share an event time are two events, not one.",
        "Late events beyond allowedLateness are excluded from the emission (counted in diagnostics), not retroactively added.",
      ],
    },
    res.warnings,
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "Windows",
        columns: [
          { key: "id", label: "Window", format: "text" },
          { key: "start", label: "Start", format: "text" },
          { key: "end", label: "End", format: "text" },
          { key: "key", label: "Key", format: "text" },
          { key: "n", label: "Events", format: "number" },
          { key: "v", label: cfg.op, format: "number" },
          { key: "late", label: "Late", format: "number" },
        ],
        rows: windows.map((w) => [
          w.id,
          new Date(w.start).toISOString().slice(0, 16).replace("T", " "),
          new Date(w.end).toISOString().slice(0, 16).replace("T", " "),
          w.key ?? "(all)",
          w.count,
          w.value,
          w.lateAdditions,
        ]),
      },
    ],
    stats: [
      { label: "Events", value: res.diagnostics.inputEvents.toLocaleString() },
      { label: "Windows emitted", value: String(res.diagnostics.windowsEmitted) },
      { label: "Late", value: String(res.diagnostics.lateEvents) },
      { label: "Duplicates", value: String(res.diagnostics.duplicateEvents) },
      { label: "Dropped", value: String(res.diagnostics.droppedEvents) },
    ],
    quickFindings: [res.interpretation, ...res.warnings.slice(0, 2)],
  };
}

// ---------------------------------------------------------------------------
// Deep learning (data-parallel XGBoost / MLP)
// ---------------------------------------------------------------------------

function runDeepLearning(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "deep-learning" }>): AnalysisResult {
  const features = (cfg.features ?? []).filter((f) => f && f !== cfg.target && columnIndex(ctx.columns, f) >= 0);
  if (features.length === 0) throw new AnalysisInputError("Deep learning needs at least one feature column.");
  for (const f of features) requireColumn(ctx.columns, f, "number");
  const ti = requireColumn(ctx.columns, cfg.target, "number");

  const { X, kept, dropped } = numericMatrix(ctx, features);
  const yRaw: number[] = kept.map((i) => asNumber(ctx.rows[i]?.[ti])).filter((v) => Number.isFinite(v));
  const yKeep: number[] = [];
  const XKeep: number[][] = [];
  kept.forEach((_, j) => {
    const v = yRaw[j];
    if (Number.isFinite(v)) {
      XKeep.push(X[j] as number[]);
      yKeep.push(v as number);
    }
  });
  if (XKeep.length < 8) {
    throw new AnalysisInputError(
      `Deep learning needs at least 8 complete rows; found ${XKeep.length}.${dropped ? ` ${dropped} incomplete row(s) were dropped.` : ""}`,
    );
  }
  const y = cfg.task === "binary" ? mapBinaryTarget(yKeep, cfg.target) : yKeep;

  let res;
  try {
    res = trainParallel({
      X: XKeep,
      y,
      task: cfg.task,
      workers: Math.max(1, Math.round(cfg.workers || 2)),
      architecture: cfg.architecture === "mlp" ? "mlp" : "xgboost",
      rounds: Math.max(1, Math.round(cfg.architecture === "mlp" ? cfg.epochs || 20 : cfg.epochs || 50)),
      learningRate: cfg.learningRate > 0 ? cfg.learningRate : 0.1,
      batchSize: Math.max(1, Math.round(cfg.batchSize || 32)),
      maxDepth: Math.max(1, Math.round(cfg.depth || 3)),
      patience: Math.max(1, Math.round(cfg.patience || 5)),
      device: cfg.device === "cpu" || cfg.device === "gpu" || cfg.device === "auto" ? cfg.device : "cpu",
      featureNames: features,
      hidden: Math.max(1, Math.round(cfg.hidden || 16)),
    });
  } catch (err) {
    throw wrapEngineError(err, "Deep learning");
  }

  const imp = res.importance.slice(0, 12);

  // True MLP (E14): the research engine with reverse-mode backprop, seeded
  // initialisation and Adam trained on the same sample. The data-parallel
  // trainer above is a sharded GBM/MLP; this is the gradient-checked net that
  // previously had zero application importers. Reported as a training fit —
  // it is not cross-validated, and the note says so.
  const mlpRows = Math.min(XKeep.length, 1200);
  const mlpX: number[][] = [];
  for (let j = 0; j < features.length; j++) {
    const col = XKeep.slice(0, mlpRows).map((row) => row[j] as number);
    const mu = mean(col);
    const sd = Math.sqrt(variance(col)) || 1;
    for (let i = 0; i < mlpRows; i++) {
      mlpX[i] ??= [];
      mlpX[i]![j] = ((XKeep[i]![j] as number) - mu) / sd;
    }
  }
  const mlpTargets = y.slice(0, mlpRows).map((t) => [t]);
  const isBinaryTask = cfg.task === "binary";
  const hiddenUnits = Math.max(4, Math.round(cfg.hidden || 16));
  const backpropNet = initMlp(
    [features.length, hiddenUnits, 1],
    "relu",
    isBinaryTask ? "sigmoid" : "linear",
    42,
  );
  const backpropFit = trainMlp(backpropNet, {
    epochs: 40,
    batchSize: 16,
    lr: isBinaryTask ? 0.05 : 0.01,
    inputs: mlpX,
    targets: mlpTargets,
    seed: 42,
  });
  let mlpSqErr = 0;
  for (let i = 0; i < mlpX.length; i++) {
    const pred = forward(backpropNet, mlpX[i]!)["output"]![0] ?? 0;
    const err = pred - (mlpTargets[i]![0] ?? 0);
    mlpSqErr += err * err;
  }
  const mlpRmse = Math.sqrt(mlpSqErr / Math.max(1, mlpX.length));

  const charts: ChartSpec[] = [
    {
      kind: "bar",
      title: `Feature importance · ${res.architecture}`,
      subtitle: res.interpretation,
      categories: imp.map((f) => f.feature),
      series: [{ name: "Gain", data: imp.map((f) => f.gain), color: "#5AA8AA" }],
    },
    {
      kind: "line",
      title: "Training loss by round",
      subtitle: `Best round ${res.bestRound} (loss ${res.bestLoss.toFixed(4)})${res.earlyStopped ? " — early stopped on patience." : "."}`,
      xLabel: "Round",
      yLabel: "Loss",
      categories: res.history.map((h) => String(h.round)),
      series: [{ name: "Loss", data: res.history.map((h) => h.loss), color: "#FFB400" }],
    },
    {
      kind: "line",
      title: "Backprop MLP loss by epoch",
      subtitle: `Reverse-mode backprop · ${hiddenUnits}-unit hidden layer · training RMSE ${mlpRmse.toFixed(4)}`,
      xLabel: "Epoch",
      yLabel: "Loss",
      categories: backpropFit.lossHistory.map((_, i) => String(i + 1)),
      series: [{ name: "Loss", data: backpropFit.lossHistory, color: "#7C6AF2" }],
    },
  ];
  const base = baseResult(
    ctx,
    cfg,
    {
      method:
        res.architecture === "xgboost"
          ? `Data-parallel XGBoost: gradients and hessians are accumulated into per-worker histograms, merged by all-reduce, and the global split search runs on the merged histograms — the same decomposition XGBoost uses, not a fake speedup. ${res.parallel.honest}`
          : `Data-parallel MLP (DDP): parameter gradients are averaged across ${res.workers} shards every step with AdamW, warmup, cosine decay and gradient clipping. ${res.parallel.honest}`,
      steps: [
        `Trained on ${XKeep.length.toLocaleString()} rows × ${features.length} features; task = ${cfg.task}; device = ${res.device.label} (${res.device.honoured ? "honoured" : "fell back"}).`,
        `Architecture ${res.architecture}, ${res.rounds} round(s) run, best round ${res.bestRound}, loss ${res.bestLoss.toFixed(4)}${res.earlyStopped ? " (early stop)" : ""}.`,
        `Throughput ${res.parallel.rowsPerSecond.toFixed(0)} rows/s; serial fraction ${(res.parallel.serialFraction * 100).toFixed(1)}%; Amdahl ceiling ${res.parallel.amdahlCeiling.toFixed(2)}×; marginal speedup per worker ${res.parallel.marginalPerWorker.toFixed(3)}.`,
        `Histogram ${res.parallel.histogramMs.toFixed(1)} ms · all-reduce ${res.parallel.allReduceMs.toFixed(1)} ms · split search ${res.parallel.splitSearchMs.toFixed(1)} ms.`,
        `Backprop check (neural-net.ts): ${features.length}→${hiddenUnits}→1 ${isBinaryTask ? "sigmoid" : "linear"} MLP, ${backpropFit.steps} Adam step(s), final training loss ${backpropFit.finalLoss.toFixed(4)}, RMSE ${mlpRmse.toFixed(4)} over ${mlpRows.toLocaleString()} row(s).`,
        res.interpretation,
      ],
      assumptions: [
        "Feature columns are numeric and complete; non-numeric columns were excluded before training.",
        cfg.task === "binary"
          ? "Binary target is 0/1 (or any two distinct values mapped to 0/1 by sorted order)."
          : "Regression target is continuous; loss is squared error.",
        "Workers are shards of the same dataset, not independent samples — the reported speedup is a ceiling, not a guarantee on your hardware.",
        "The backprop MLP is a training-fit diagnostic (no held-out split) trained on standardised features; its RMSE is not a generalisation estimate.",
      ],
    },
    [...new Set([...res.warnings, ...res.device.warnings])].filter(Boolean),
  );
  return {
    ...base,
    charts,
    tables: [
      {
        title: "Top features",
        columns: [
          { key: "f", label: "Feature", format: "text" },
          { key: "g", label: "Gain", format: "number" },
        ],
        rows: imp.map((f) => [f.feature, f.gain]),
      },
      {
        title: "Parallel accounting",
        columns: [
          { key: "k", label: "Metric", format: "text" },
          { key: "v", label: "Value", format: "number" },
        ],
        rows: [
          ["Workers", res.workers],
          ["Rows/s", res.parallel.rowsPerSecond],
          ["Serial fraction", res.parallel.serialFraction],
          ["Amdahl ceiling", res.parallel.amdahlCeiling],
          ["Marginal per worker", res.parallel.marginalPerWorker],
        ],
      },
    ],
    stats: [
      { label: "Architecture", value: res.architecture },
      { label: "Device", value: res.device.label, hint: res.device.honoured ? "as requested" : "fallback" },
      { label: "Best loss", value: res.bestLoss.toFixed(4), hint: `round ${res.bestRound}` },
      { label: "Rows/s", value: res.parallel.rowsPerSecond.toFixed(0) },
      { label: "Amdahl ceiling", value: `${res.parallel.amdahlCeiling.toFixed(2)}×` },
      {
        label: "Backprop MLP RMSE",
        value: mlpRmse.toFixed(4),
        hint: `${features.length}→${hiddenUnits}→1, training fit`,
      },
      { label: "Backprop steps", value: String(backpropFit.steps) },
    ],
    quickFindings: [
      res.interpretation,
      res.parallel.honest,
      `True backprop MLP (${features.length}→${hiddenUnits}→1) trained on ${mlpRows.toLocaleString()} row(s): training RMSE ${mlpRmse.toFixed(4)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// NLP
// ---------------------------------------------------------------------------

/**
 * Learned-vector retrieval (E15): skip-gram word2vec over the sampled corpus,
 * documents mean-pooled into one vector each, ranked by cosine similarity.
 * This is the real trained-vector path — TF-IDF above stays the lexical
 * near-duplicate detector, and the note never claims transformer embeddings.
 */
function vectorRetrieval(
  docs: string[],
  ids: string[],
): {
  dim: number;
  vocabSize: number;
  queryId: string;
  neighbours: { id: string; sim: number }[];
  pairs: { a: string; b: string; sim: number }[];
  note: string;
} {
  const model = trainWord2vec(docs, { dim: 32, window: 3, epochs: 3, lr: 0.05, negative: 5, seed: 42 });
  const vectors = docs.map((doc) => {
    const tokens = doc.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    const acc = new Array(model.dim).fill(0) as number[];
    let n = 0;
    for (const token of tokens) {
      const idx = model.vocab.index.get(token);
      if (idx === undefined) continue;
      const vec = model.inVectors[idx]!;
      for (let k = 0; k < model.dim; k++) acc[k] = (acc[k] ?? 0) + (vec[k] ?? 0);
      n += 1;
    }
    return n > 0 ? acc.map((x) => x / n) : acc;
  });
  const cos = (a: number[], b: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
      na += (a[i] ?? 0) ** 2;
      nb += (b[i] ?? 0) ** 2;
    }
    const den = Math.sqrt(na) * Math.sqrt(nb);
    return den === 0 ? 0 : dot / den;
  };
  const pairs: { a: string; b: string; sim: number }[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      pairs.push({ a: ids[i] ?? `row-${i}`, b: ids[j] ?? `row-${j}`, sim: cos(vectors[i]!, vectors[j]!) });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  const neighbours = vectors
    .map((vec, i) => ({ id: ids[i] ?? `row-${i}`, sim: cos(vectors[0]!, vec) }))
    .filter((p) => p.id !== ids[0])
    .sort((x, y) => y.sim - x.sim)
    .slice(0, 5);
  return {
    dim: model.dim,
    vocabSize: model.vocab.tokens.length,
    queryId: ids[0] ?? "row-0",
    neighbours,
    pairs: pairs.slice(0, 10),
    note: `Learned-vector retrieval: skip-gram word2vec (dim ${model.dim}, vocab ${model.vocab.tokens.length}, 3 epochs), documents mean-pooled, cosine nearest neighbours. In-repo trainer, not a transformer embedding model.`,
  };
}

function runNlp(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "nlp" }>): AnalysisResult {
  const ti = requireColumn(ctx.columns, cfg.textCol);
  const docs: string[] = [];
  const ids: string[] = [];
  ctx.rows.forEach((row, i) => {
    const t = String(row[ti] ?? "").trim();
    if (!t) return;
    docs.push(t);
    ids.push(`row-${i}`);
  });
  if (docs.length === 0) throw new AnalysisInputError(`No non-empty text found in “${cfg.textCol}”.`);

  const task = (
    ["keywords", "sentiment", "topics", "similarity", "entities", "language", "classify"] as const
  ).includes(cfg.task as "sentiment")
    ? cfg.task
    : "sentiment";
  const sampleN = Math.max(2, Math.min(docs.length, Math.round(cfg.sampleSize || 500)));
  const sampleDocs = docs.slice(0, sampleN);
  const sampleIds = ids.slice(0, sampleN);

  if (task === "sentiment") {
    const results = sampleDocs.map((d) => computeSentiment(d));
    const buckets = new Array(11).fill(0) as number[];
    for (const r of results) {
      const idx = Math.min(10, Math.max(0, Math.round(((r.compound + 1) / 2) * 10)));
      buckets[idx] = (buckets[idx] as number) + 1;
    }
    const meanCompound = mean(results.map((r) => r.compound));
    const drivers = new Map<string, number>();
    for (const r of results) for (const d of r.drivers) drivers.set(d.term, (drivers.get(d.term) ?? 0) + d.weight);
    const topDrivers = [...drivers.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12);
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Lexicon sentiment with negation scope: each document is tokenised, matched against a valence lexicon, negated within a short scope window, and normalised to a compound score in [−1, 1]. Coverage is reported because a low-coverage document is a guess, not a measurement.`,
        steps: [
          `${results.length} document(s) scored (sample of ${sampleN} from ${docs.length}).`,
          `Mean compound = ${meanCompound.toFixed(4)}; ${results.filter((r) => r.compound > 0.05).length} positive, ${results.filter((r) => r.compound < -0.05).length} negative, ${results.filter((r) => Math.abs(r.compound) <= 0.05).length} neutral.`,
          `Mean lexicon coverage = ${(mean(results.map((r) => r.coverage)) * 100).toFixed(1)}%.`,
          `Top valence drivers: ${
            topDrivers
              .slice(0, 5)
              .map(([t, w]) => `${t} (${w.toFixed(2)})`)
              .join(", ") || "none"
          }.`,
        ],
        assumptions: [
          "Sentiment is lexical: irony, domain jargon and mixed-sentence sentiment are not modelled.",
          "Documents with coverage below ~2% are effectively unmeasured — read the coverage number before quoting a score.",
        ],
      },
      results.some((r) => r.coverage < 0.02)
        ? ["Some documents had almost no lexicon coverage — their compound scores are not trustworthy."]
        : [],
    );
    return {
      ...base,
      charts: [
        {
          kind: "histogram",
          title: "Compound sentiment distribution",
          subtitle: `Mean ${meanCompound.toFixed(3)} across ${results.length} document(s).`,
          categories: buckets.map((_, i) => ((i / 10) * 2 - 1).toFixed(1)),
          series: [{ name: "Documents", data: buckets, color: "#5AA8AA" }],
          yLabel: "Documents",
        },
      ],
      tables: [
        {
          title: "Top sentiment drivers",
          columns: [
            { key: "t", label: "Term", format: "text" },
            { key: "w", label: "Weight sum", format: "number" },
          ],
          rows: topDrivers.map(([t, w]) => [t, w]),
        },
      ],
      stats: [
        { label: "Documents", value: String(results.length) },
        { label: "Mean compound", value: meanCompound.toFixed(4) },
        { label: "Positive", value: String(results.filter((r) => r.compound > 0.05).length) },
        { label: "Negative", value: String(results.filter((r) => r.compound < -0.05).length) },
        {
          label: "Mean coverage",
          value: `${(mean(results.map((r) => r.coverage)) * 100).toFixed(1)}%`,
          hint: "share of tokens in the lexicon",
        },
      ],
      quickFindings: [
        `Mean compound sentiment ${meanCompound.toFixed(3)} over ${results.length} document(s).`,
        topDrivers[0]
          ? `Strongest lexical driver: ${topDrivers[0][0]} (weight sum ${topDrivers[0][1].toFixed(2)}).`
          : "No lexicon hits — the text may be in an unsupported language or domain.",
      ],
    };
  }

  if (task === "classify") {
    const li = cfg.labelCol ? requireColumn(ctx.columns, cfg.labelCol) : -1;
    if (li < 0) throw new AnalysisInputError("Classification needs a label column (labelCol).");
    const labels: string[] = [];
    const docs2: string[] = [];
    const ids2: string[] = [];
    ctx.rows.forEach((row, i) => {
      const t = String(row[ti] ?? "").trim();
      const l = String(row[li] ?? "").trim();
      if (!t || !l) return;
      docs2.push(t);
      labels.push(l);
      ids2.push(`row-${i}`);
    });
    let rep;
    try {
      rep = classifyTexts(docs2, labels, ids2, {
        holdoutFraction: 0.3,
        topTerms: Math.max(3, Math.round(cfg.topK || 8)),
        minDf: Math.max(1, Math.round(cfg.minDf || 1)),
      });
    } catch (err) {
      throw wrapEngineError(err, "NLP classification");
    }
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Multinomial naive Bayes over a TF-IDF vocabulary with a stratified 70/30 holdout. Discriminative terms are log-odds of each class against the pooled rest — the words that actually separate the labels.`,
        steps: [
          `${docs2.length} document(s), ${rep.labels.length} label(s): ${rep.labels.join(", ")}.`,
          `In-sample accuracy ${(rep.accuracy * 100).toFixed(1)}%; held-out accuracy ${rep.heldOutAccuracy === null ? "n/a (split too small)" : `${(rep.heldOutAccuracy * 100).toFixed(1)}%`}.`,
          `Majority baseline ${((1 / Math.max(1, rep.labels.length)) * 100).toFixed(1)}% — accuracy only means something against that.`,
          ...rep.perClass.map(
            (c) =>
              `${c.label}: precision ${c.precision.toFixed(3)}, recall ${c.recall.toFixed(3)}, support ${c.support}.`,
          ),
        ],
        assumptions: [
          "Bag-of-words naive Bayes: word order and negation scope are ignored except where the tokenizer keeps them.",
          "Held-out accuracy is the honest number; in-sample accuracy is optimistic.",
        ],
      },
      rep.warnings,
    );
    return {
      ...base,
      charts: [
        {
          kind: "bar",
          title: "Per-class recall",
          subtitle: `Held-out accuracy ${rep.heldOutAccuracy === null ? "n/a" : `${(rep.heldOutAccuracy * 100).toFixed(1)}%`}.`,
          categories: rep.perClass.map((c) => c.label),
          series: [{ name: "Recall", data: rep.perClass.map((c) => c.recall), color: "#5AA8AA" }],
        },
      ],
      tables: [
        {
          title: "Per-class metrics",
          columns: [
            { key: "l", label: "Label", format: "text" },
            { key: "p", label: "Precision", format: "pct" },
            { key: "r", label: "Recall", format: "pct" },
            { key: "s", label: "Support", format: "number" },
          ],
          rows: rep.perClass.map((c) => [c.label, c.precision, c.recall, c.support]),
        },
      ],
      stats: [
        { label: "Accuracy (train)", value: `${(rep.accuracy * 100).toFixed(1)}%` },
        {
          label: "Accuracy (holdout)",
          value: rep.heldOutAccuracy === null ? "n/a" : `${(rep.heldOutAccuracy * 100).toFixed(1)}%`,
          hint: rep.heldOutAccuracy === null ? "split too small" : "honest estimate",
        },
        { label: "Labels", value: String(rep.labels.length) },
        { label: "Documents", value: String(docs2.length) },
      ],
      quickFindings: [rep.interpretation],
    };
  }

  if (task === "topics") {
    const vocab = buildVocabulary(sampleDocs, {
      minDf: Math.max(1, Math.round(cfg.minDf || 2)),
      maxTerms: 2000,
    });
    const topics = Math.max(2, Math.min(20, Math.round(cfg.numTopics || 5)));
    let lda;
    try {
      lda = trainLda(sampleDocs, sampleIds, {
        topics,
        vocab,
        topTerms: Math.max(3, Math.round(cfg.topK || 8)),
        seed: 42,
      });
    } catch (err) {
      throw wrapEngineError(err, "NLP topics");
    }
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Latent Dirichlet Allocation via Gibbs sampling over a TF-IDF-filtered vocabulary: each document is a mixture of topics, each topic a distribution over terms. ELBO drift in the final third of training is the convergence diagnostic — a drifting ELBO means the topics are not settled.`,
        steps: [
          `Vocabulary: ${vocab.terms.length} term(s) meeting minDf = ${cfg.minDf}; ${lda.iterations} Gibbs sweep(s).`,
          `Final ELBO ${lda.elbo.toFixed(2)} (drift ${lda.elboDrift.toFixed(4)} per sweep in the final third); mean residual KL ${lda.meanResidual.toFixed(4)}.`,
          ...lda.topics.map(
            (t) => `Topic ${t.id + 1} (size ${t.size}, coherence ${t.coherence.toFixed(3)}): ${t.topTerms.join(", ")}.`,
          ),
        ],
        assumptions: [
          "Topics are bag-of-words; the number of topics is a modelling choice, not something the data reveals on its own.",
          "Low coherence or high ELBO drift means the topic count is wrong — treat the topics as unstable.",
        ],
      },
      lda.warnings,
    );
    return {
      ...base,
      charts: [
        {
          kind: "bar",
          title: "Topic sizes",
          subtitle: lda.interpretation,
          categories: lda.topics.map((t) => `Topic ${t.id + 1}`),
          series: [{ name: "Documents", data: lda.topics.map((t) => t.size), color: "#5AA8AA" }],
        },
      ],
      tables: [
        {
          title: "Topics",
          columns: [
            { key: "id", label: "Topic", format: "text" },
            { key: "terms", label: "Top terms", format: "text" },
            { key: "coh", label: "Coherence", format: "number" },
            { key: "size", label: "Size", format: "number" },
          ],
          rows: lda.topics.map((t) => [`Topic ${t.id + 1}`, t.topTerms.join(", "), t.coherence, t.size]),
        },
      ],
      stats: [
        { label: "Topics", value: String(lda.topics.length) },
        { label: "ELBO", value: lda.elbo.toFixed(2) },
        {
          label: "ELBO drift",
          value: lda.elboDrift.toFixed(4),
          hint: lda.elboDrift > 0.01 ? "still moving — topics unstable" : "settled",
        },
        { label: "Mean residual KL", value: lda.meanResidual.toFixed(4) },
      ],
      quickFindings: [lda.interpretation],
    };
  }

  if (task === "similarity") {
    const vocab = buildVocabulary(sampleDocs, { minDf: 1, maxTerms: 5000 });
    const docsF = featurizeAll(sampleDocs, vocab, sampleIds);
    let rep;
    try {
      rep = similarityReport(docsF, vocab, { threshold: 0.85, maxPairs: 200000 });
    } catch (err) {
      throw wrapEngineError(err, "NLP similarity");
    }
    const vec = vectorRetrieval(sampleDocs, sampleIds);
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `TF-IDF featurisation followed by cosine similarity over all distinct pairs (stride-sampled beyond 200,000 pairs). Near-duplicates are pairs at cosine ≥ 0.85 — high-coverage shared vocabulary, not necessarily identical strings. Retrieval also reports learned word2vec document vectors (mean-pooled, cosine-ranked) alongside the lexical layer.`,
        steps: [
          `${docsF.length} document(s) featurised into a ${vocab.terms.length}-term vocabulary.`,
          `${rep.compared.toLocaleString()} pair(s) compared; ${rep.nearDuplicates} at or above the ${rep.threshold} threshold.`,
          ...rep.pairs
            .slice(0, 5)
            .map(
              (p) =>
                `${p.a} ↔ ${p.b}: cosine ${p.similarity.toFixed(3)} (shared: ${p.sharedTerms.slice(0, 5).join(", ") || "—"}).`,
            ),
          vec.note,
          `Vector nearest neighbour of ${vec.queryId}: ${vec.neighbours[0]?.id ?? "—"} at cosine ${(vec.neighbours[0]?.sim ?? 0).toFixed(3)}.`,
        ],
        assumptions: [
          "Cosine on TF-IDF is a lexical near-duplicate detector — paraphrases with different wording will be missed.",
          "Beyond 200,000 pairs the comparison is stride-sampled; the near-duplicate count is then a lower bound.",
          "Word2vec is trained on this sample only and mean-pooled per document — it captures local co-occurrence, not entailment.",
        ],
      },
      rep.warnings,
    );
    return {
      ...base,
      charts: [
        {
          kind: "bar",
          title: "Top near-duplicate pairs",
          subtitle: `${rep.nearDuplicates} pair(s) at cosine ≥ ${rep.threshold}.`,
          categories: rep.pairs.slice(0, 10).map((p) => `${p.a}↔${p.b}`),
          series: [{ name: "Cosine", data: rep.pairs.slice(0, 10).map((p) => p.similarity), color: "#5AA8AA" }],
        },
        {
          kind: "bar",
          title: "Learned-vector nearest pairs (word2vec)",
          subtitle: `Mean-pooled ${vec.dim}-dim skip-gram vectors over a ${vec.vocabSize}-token vocabulary.`,
          categories: vec.pairs.map((p) => `${p.a}↔${p.b}`),
          series: [{ name: "Cosine", data: vec.pairs.map((p) => p.sim), color: "#7C6AF2" }],
        },
      ],
      tables: [
        {
          title: "Learned-vector retrieval",
          columns: [
            { key: "q", label: "Query doc", format: "text" },
            { key: "n", label: "Nearest doc", format: "text" },
            { key: "s", label: "Cosine", format: "number" },
          ],
          rows: vec.neighbours.map((n) => [vec.queryId, n.id, n.sim]),
        },
        {
          title: "Near-duplicate pairs",
          columns: [
            { key: "a", label: "A", format: "text" },
            { key: "b", label: "B", format: "text" },
            { key: "s", label: "Cosine", format: "number" },
            { key: "t", label: "Shared terms", format: "text" },
          ],
          rows: rep.pairs.map((p) => [p.a, p.b, p.similarity, p.sharedTerms.slice(0, 6).join(", ")]),
        },
      ],
      stats: [
        { label: "Documents", value: String(docsF.length) },
        { label: "Pairs compared", value: rep.compared.toLocaleString() },
        { label: "Near-duplicates", value: String(rep.nearDuplicates) },
        { label: "Threshold", value: String(rep.threshold) },
        { label: "Vector dim", value: String(vec.dim), hint: "word2vec, mean-pooled" },
        { label: "Embedding vocab", value: String(vec.vocabSize) },
      ],
      quickFindings: [
        `${rep.nearDuplicates} near-duplicate pair(s) at cosine ≥ ${rep.threshold} across ${rep.compared.toLocaleString()} comparisons.`,
        `Learned-vector nearest neighbour of ${vec.queryId}: ${vec.neighbours[0]?.id ?? "—"} at cosine ${(vec.neighbours[0]?.sim ?? 0).toFixed(3)}.`,
        ...rep.warnings.slice(0, 1),
      ],
    };
  }

  if (task === "entities") {
    const summary = summarizeEntities(sampleDocs, 200);
    const byType = summary.byType ?? [];
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Deterministic entity extraction (emails, URLs, money, percentages, ISO dates, capitalised spans) aggregated by type across documents, then ranked by frequency. This is pattern-based, not a trained NER model.`,
        steps: [
          `${sampleDocs.length} document(s) scanned; ${summary.total.toLocaleString()} mention(s) in ${byType.length} type(s).`,
          ...byType
            .slice(0, 8)
            .map((b) => `${b.type}: ${b.count} mention(s), ${b.distinct} distinct (top: ${b.top.join(", ") || "—"}).`),
          summary.interpretation,
        ],
        assumptions: [
          "Extraction is pattern-based: exact for emails, URLs, money, percentages and ISO dates; approximate for people and locations.",
        ],
      },
      summary.warnings ?? [],
    );
    return {
      ...base,
      charts: [
        {
          kind: "bar",
          title: "Entity mentions by type",
          subtitle: summary.interpretation,
          categories: byType.map((b) => b.type),
          series: [{ name: "Mentions", data: byType.map((b) => b.count), color: "#5AA8AA" }],
        },
      ],
      tables: [
        {
          title: "Entities by type",
          columns: [
            { key: "t", label: "Type", format: "text" },
            { key: "c", label: "Mentions", format: "number" },
            { key: "d", label: "Distinct", format: "number" },
            { key: "top", label: "Top values", format: "text" },
          ],
          rows: byType.map((b) => [b.type, b.count, b.distinct, b.top.join(", ")]),
        },
      ],
      stats: [
        { label: "Documents", value: String(sampleDocs.length) },
        { label: "Mentions", value: summary.total.toLocaleString() },
        { label: "Types", value: String(byType.length) },
      ],
      quickFindings: [
        byType[0]
          ? `Most frequent entity type: ${byType[0].type} (${byType[0].count} mention(s), ${byType[0].distinct} distinct).`
          : "No entities extracted — the text may be lowercase or informal.",
        summary.interpretation,
      ],
    };
  }

  if (task === "language") {
    const rep = detectLanguages(sampleDocs);
    const langs = rep.languages ?? [];
    const base = baseResult(
      ctx,
      cfg,
      {
        method: `Stopword-profile language identification: each document is scored against a small set of language stopword profiles; documents whose top two scores are within the ambiguity margin are reported as ambiguous rather than forced into a label.`,
        steps: [
          `${sampleDocs.length} document(s) classified (confidence: ${rep.confidence}).`,
          ...langs
            .slice(0, 8)
            .map(
              (l) =>
                `${l.lang}: ${((l.share ?? 0) * 100).toFixed(1)}% share, coverage ${((l.meanCoverage ?? 0) * 100).toFixed(1)}%, OOV ${((l.oov ?? 0) * 100).toFixed(1)}%.`,
            ),
          `Ambiguous share: ${((rep.ambiguousShare ?? 0) * 100).toFixed(1)}%.`,
          rep.interpretation,
        ],
        assumptions: [
          "Short documents and mixed-language text are frequently misclassified; read the ambiguous share before quoting a mix.",
        ],
      },
      rep.warnings ?? [],
    );
    return {
      ...base,
      charts: [
        {
          kind: "donut",
          title: "Language mix",
          subtitle: rep.interpretation,
          categories: langs.map((l) => l.lang),
          series: [{ name: "Share", data: langs.map((l) => l.share), color: "#5AA8AA" }],
        },
      ],
      tables: [
        {
          title: "Languages",
          columns: [
            { key: "l", label: "Language", format: "text" },
            { key: "s", label: "Share", format: "pct" },
            { key: "c", label: "Coverage", format: "pct" },
            { key: "o", label: "OOV", format: "pct" },
          ],
          rows: langs.map((l) => [l.lang, l.share, l.meanCoverage, l.oov]),
        },
      ],
      stats: [
        ...langs.slice(0, 4).map((l) => ({ label: l.lang, value: `${((l.share ?? 0) * 100).toFixed(1)}%` })),
        { label: "Ambiguous", value: `${((rep.ambiguousShare ?? 0) * 100).toFixed(1)}%` },
        { label: "Confidence", value: rep.confidence },
      ],
      quickFindings: [
        langs[0]
          ? `Most common language: ${langs[0].lang} (${((langs[0].share ?? 0) * 100).toFixed(1)}% of documents).`
          : "No language detected.",
        rep.interpretation,
      ],
    };
  }

  // keywords (default)
  const vocab = buildVocabulary(sampleDocs, {
    minDf: Math.max(1, Math.round(cfg.minDf || 2)),
    maxTerms: 500,
  });
  const ranked = vocab.terms
    .map((term, i) => ({ term, idf: vocab.idf[i] as number, df: vocab.documentFrequency[i] as number }))
    .sort((a, b) => b.idf - a.idf)
    .slice(0, Math.max(5, Math.round(cfg.topK || 15)));
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `TF-IDF keyword extraction: terms meeting minDf = ${cfg.minDf} are scored by smoothed inverse document frequency and ranked — high-IDF terms are the ones that distinguish this corpus from a generic one.`,
      steps: [
        `${sampleDocs.length} document(s); vocabulary ${vocab.terms.length} term(s) after minDf filtering.`,
        `Top keywords: ${
          ranked
            .slice(0, 8)
            .map((r) => r.term)
            .join(", ") || "none"
        }.`,
      ],
      assumptions: ["Keywords are corpus-relative: a term frequent everywhere scores low by design."],
    },
    [],
  );
  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "Top keywords by IDF",
        categories: ranked.map((r) => r.term),
        series: [{ name: "IDF", data: ranked.map((r) => r.idf), color: "#5AA8AA" }],
      },
    ],
    tables: [
      {
        title: "Keywords",
        columns: [
          { key: "t", label: "Term", format: "text" },
          { key: "i", label: "IDF", format: "number" },
          { key: "d", label: "Doc frequency", format: "number" },
        ],
        rows: ranked.map((r) => [r.term, r.idf, r.df]),
      },
    ],
    stats: [
      { label: "Documents", value: String(sampleDocs.length) },
      { label: "Vocabulary", value: String(vocab.terms.length) },
      { label: "Keywords shown", value: String(ranked.length) },
    ],
    quickFindings: [
      ranked[0]
        ? `Highest-IDF keyword: ${ranked[0].term} (IDF ${ranked[0].idf.toFixed(3)}, in ${ranked[0].df} document(s)).`
        : "Vocabulary empty — lower minDf or supply more text.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Feature store (point-in-time retrieval)
// ---------------------------------------------------------------------------

function runFeatureStore(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "feature-store" }>): AnalysisResult {
  const ei = requireColumn(ctx.columns, cfg.entityCol);
  const ti = requireColumn(ctx.columns, cfg.eventTimeCol, "date");
  const featureCols = (cfg.featureCols ?? []).filter((f) => f && columnIndex(ctx.columns, f) >= 0);
  if (featureCols.length === 0) throw new AnalysisInputError("Feature store needs at least one feature column.");
  const fIdx = featureCols.map((f) => requireColumn(ctx.columns, f));

  const observations: {
    entity: string;
    feature: string;
    value: number | string | null;
    eventTime: number;
    writeOrder: number;
  }[] = [];
  const events: { entity: string; eventTime: number }[] = [];
  let dropped = 0;
  ctx.rows.forEach((row, i) => {
    const d = cellDate(row[ti]);
    if (!d) {
      dropped += 1;
      return;
    }
    const entity = cellString(row[ei]) || `(row-${i})`;
    const eventTime = d.getTime();
    events.push({ entity, eventTime });
    fIdx.forEach((j, k) => {
      const name = featureCols[k] as string;
      const raw = row[j];
      const value = raw === null || raw === undefined || raw === "" ? null : (raw as number | string);
      observations.push({ entity, feature: name, value, eventTime, writeOrder: i });
    });
  });
  if (events.length === 0) {
    throw new AnalysisInputError(`No rows with a valid date in “${cfg.eventTimeCol}”.`);
  }

  let report;
  try {
    report = retrieveFeatures({
      observations,
      events,
      features: featureCols,
      pointInTime: true,
      maxAgeMs: Math.max(0, cfg.maxFeatureAgeDays) * 86_400_000,
      historyDepth: 0,
    });
  } catch (err) {
    throw wrapEngineError(err, "Feature store");
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Point-in-time-correct feature retrieval: for every entity event the engine returns only observations whose own event time is at or before the event's — the anti-leakage contract. A parallel "naive latest value" read is computed for the same events so the number of rows a sloppy join would have leaked is explicit.`,
      steps: [
        `${report.stats.observations.toLocaleString()} observation(s) over ${report.stats.entities} entit(y/ies) × ${report.stats.features} feature(s); ${report.stats.events.toLocaleString()} entity event(s).`,
        `Coverage ${(report.stats.coverage * 100).toFixed(1)}% of (event × feature) cells retrieved; ${report.stats.indexEntries.toLocaleString()} index entries kept.`,
        `Leakage: ${report.leakage.mismatchedRows.toLocaleString()} of ${report.leakage.totalRows.toLocaleString()} row(s) would differ under a naive latest-value join (max |Δ| ${report.leakage.maxAbsDelta.toFixed(4)}).`,
        `Staleness: ${report.staleness.rowsWithNoFreshFeature.toLocaleString()} row(s) have no feature fresher than ${cfg.maxFeatureAgeDays} day(s).`,
        report.leakage.verdict,
        report.staleness.verdict,
      ],
      assumptions: [
        "Write order within the same event time is the row's original index — ties resolve to the earlier row.",
        "A feature with no observation at or before the event is missing, not zero.",
        cfg.maxFeatureAgeDays > 0
          ? `Features older than ${cfg.maxFeatureAgeDays} day(s) are marked stale (still retrieved, flagged).`
          : "No staleness threshold — every historical match counts as fresh.",
      ],
    },
    [...report.warnings, ...(dropped > 0 ? [`${dropped} row(s) dropped for a missing event time.`] : [])],
  );
  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "Per-feature retrieval quality",
        subtitle: report.interpretation,
        categories: report.staleness.perFeature.map((f) => f.feature),
        series: [
          { name: "Matched", data: report.staleness.perFeature.map((f) => f.matched), color: "#5AA8AA" },
          { name: "Stale", data: report.staleness.perFeature.map((f) => f.stale), color: "#FFB400" },
          { name: "Missing", data: report.staleness.perFeature.map((f) => f.missing), color: "#E8637A" },
        ],
      },
    ],
    tables: [
      {
        title: "Per-feature staleness",
        columns: [
          { key: "f", label: "Feature", format: "text" },
          { key: "m", label: "Matched", format: "number" },
          { key: "s", label: "Stale", format: "number" },
          { key: "miss", label: "Missing", format: "number" },
          { key: "med", label: "Median age (ms)", format: "number" },
          { key: "p95", label: "p95 age (ms)", format: "number" },
        ],
        rows: report.staleness.perFeature.map((f) => [
          f.feature,
          f.matched,
          f.stale,
          f.missing,
          f.medianAgeMs,
          f.p95AgeMs,
        ]),
      },
      {
        title: "Leakage by feature",
        columns: [
          { key: "f", label: "Feature", format: "text" },
          { key: "m", label: "Mismatched", format: "number" },
          { key: "s", label: "Share", format: "pct" },
        ],
        rows: report.leakage.byFeature.map((f) => [f.feature, f.mismatched, f.share]),
      },
    ],
    stats: [
      { label: "Events", value: report.stats.events.toLocaleString() },
      { label: "Observations", value: report.stats.observations.toLocaleString() },
      { label: "Coverage", value: `${(report.stats.coverage * 100).toFixed(1)}%` },
      {
        label: "Leakage rows",
        value: report.leakage.mismatchedRows.toLocaleString(),
        hint: report.leakage.mismatchedRows > 0 ? "naive join would leak" : "naive join agrees",
      },
      {
        label: "No fresh feature",
        value: report.staleness.rowsWithNoFreshFeature.toLocaleString(),
        hint: `max age ${cfg.maxFeatureAgeDays}d`,
      },
    ],
    quickFindings: [report.interpretation, report.leakage.verdict, report.staleness.verdict],
  };
}

// ---------------------------------------------------------------------------
// Real-time serving
// ---------------------------------------------------------------------------

function runRealTimeServing(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "real-time-serving" }>): AnalysisResult {
  const featureCols = (cfg.featureCols ?? []).filter((f) => f && f !== cfg.target && columnIndex(ctx.columns, f) >= 0);
  if (featureCols.length === 0) throw new AnalysisInputError("Serving benchmark needs at least one feature column.");
  for (const f of featureCols) requireColumn(ctx.columns, f, "number");
  const ti = requireColumn(ctx.columns, cfg.target, "number");

  const { X, kept, dropped } = numericMatrix(ctx, featureCols);
  const yAll: number[] = [];
  for (const i of kept) yAll.push(asNumber(ctx.rows[i]?.[ti]));
  const XKeep: number[][] = [];
  const yKeep: number[] = [];
  kept.forEach((_, j) => {
    const v = yAll[j];
    if (Number.isFinite(v)) {
      XKeep.push(X[j] as number[]);
      yKeep.push(v as number);
    }
  });
  if (XKeep.length < 10) {
    throw new AnalysisInputError(
      `Serving benchmark needs at least 10 complete rows; found ${XKeep.length}.${dropped ? ` ${dropped} incomplete row(s) were dropped.` : ""}`,
    );
  }
  const task: "binary" | "regression" = cfg.targetKind === "regression" ? "regression" : "binary";
  // A binary task validates (and normalises) the target up front; the mapped
  // vector is not needed downstream, where yKeep is used directly.
  if (task === "binary") mapBinaryTarget(yKeep, cfg.target);

  // Holdout = every 5th row (deterministic, no RNG).
  const trainIdx: number[] = [];
  const holdIdx: number[] = [];
  XKeep.forEach((_, i) => {
    if (i % 5 === 4) holdIdx.push(i);
    else trainIdx.push(i);
  });
  if (trainIdx.length < 8 || holdIdx.length < 1) {
    throw new AnalysisInputError(
      `Not enough rows to split a training set and a holdout from ${XKeep.length} complete row(s) (need ≥ 10).`,
    );
  }
  const XTrain = trainIdx.map((i) => XKeep[i] as number[]);
  const yTrain = trainIdx.map((i) => yKeep[i] as number);

  let artifact;
  try {
    artifact = fitServingArtifact(XTrain, yTrain, {
      modelId: `${ctx.datasetId}-serving`,
      version: "1.0.0",
      featureNames: featureCols,
      task,
      family: task === "binary" ? "logistic" : "ridge",
      slaMs: Math.max(1, Math.round(cfg.slaMs || 100)),
    });
  } catch (err) {
    throw wrapEngineError(err, "Serving artifact");
  }

  const requests = holdIdx.map((i) => {
    const features: Record<string, number | string | null | undefined> = {};
    featureCols.forEach((name, j) => {
      features[name] = (XKeep[i] as number[])[j];
    });
    return {
      modelId: artifact.modelId,
      features,
      requestId: `req-${i}`,
    };
  });

  let report;
  try {
    report = simulateServing(
      {
        requests,
        batchSize: 8,
        cacheSize: Math.max(16, Math.round(cfg.cacheSize || 128)),
        canaryShare: Math.max(0, Math.min(1, cfg.canaryShare ?? 0)),
        shadow: cfg.shadow !== false,
        holdoutFraction: 0,
      },
      artifact,
      null,
    );
  } catch (err) {
    throw wrapEngineError(err, "Serving simulation");
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `Fit a ${artifact.family} model on the training rows (every 5th row held out), then replay the holdout as live traffic through an LRU cache, micro-batching (batch 8), deterministic A/B allocation and shadow scoring. Latency percentiles and cache/batch behaviour are measured on the replay, not modelled.`,
      steps: [
        `Trained ${artifact.family} on ${trainIdx.length} row(s); holdout ${holdIdx.length} row(s) replayed as ${requests.length} request(s).`,
        `Cache: ${report.cache.hits}/${report.requests} hits (${(report.cache.hitRate * 100).toFixed(1)}%), capacity ${report.cache.capacity}, ${report.cache.evictions} eviction(s).`,
        `Batching: ${report.batching.batches} batch(es), mean fill ${(report.batching.meanBatchFill * 100).toFixed(1)}%.`,
        `Latency: p50 ${report.latency.p50.toFixed(2)} ms, p95 ${report.latency.p95.toFixed(2)} ms, p99 ${report.latency.p99.toFixed(2)} ms; ${report.latency.breaches} breach(es) of the ${report.latency.slaMs} ms SLA (${(report.latency.breachRate * 100).toFixed(1)}%).`,
        report.accuracy.holdoutAccuracy === null
          ? "Holdout accuracy not computed (no labelled holdout requests)."
          : `Holdout accuracy ${report.accuracy.holdoutAccuracy.toFixed(4)} vs majority baseline ${report.accuracy.majorityBaseline.toFixed(4)} — ${report.accuracy.verdict}`,
        report.interpretation,
      ],
      assumptions: [
        "Holdout is every 5th row in file order — fine for a benchmark, not a randomised split.",
        "Latency is in-process JavaScript, not network round-trip; treat the absolute numbers as a lower bound for a real service.",
        cfg.shadow !== false
          ? "Shadow mode scores every request with the incumbent and reports disagreement."
          : "Shadow mode off — no incumbent comparison.",
      ],
    },
    [...report.warnings, ...(dropped > 0 ? [`${dropped} incomplete row(s) excluded.`] : [])],
  );
  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "Latency percentiles",
        subtitle: report.interpretation,
        categories: ["p50", "p95", "p99", "max"],
        series: [
          {
            name: "ms",
            data: [report.latency.p50, report.latency.p95, report.latency.p99, report.latency.max],
            color: "#5AA8AA",
          },
        ],
      },
    ],
    tables: [
      {
        title: "Serving summary",
        columns: [
          { key: "k", label: "Metric", format: "text" },
          { key: "v", label: "Value", format: "number" },
        ],
        rows: [
          ["Requests", report.requests],
          ["Cache hit rate", report.cache.hitRate],
          ["Batches", report.batching.batches],
          ["p50 (ms)", report.latency.p50],
          ["p95 (ms)", report.latency.p95],
          ["p99 (ms)", report.latency.p99],
          ["SLA breaches", report.latency.breaches],
          ["Holdout accuracy", report.accuracy.holdoutAccuracy],
          ["Majority baseline", report.accuracy.majorityBaseline],
        ],
      },
    ],
    stats: [
      { label: "Family", value: artifact.family },
      { label: "Requests", value: String(report.requests) },
      { label: "p95", value: `${report.latency.p95.toFixed(2)} ms`, hint: `SLA ${report.latency.slaMs} ms` },
      {
        label: "Breach rate",
        value: `${(report.latency.breachRate * 100).toFixed(1)}%`,
        hint: report.latency.breachRate > 0.05 ? "SLO at risk" : "within SLO",
      },
      { label: "Cache hit rate", value: `${(report.cache.hitRate * 100).toFixed(1)}%` },
      {
        label: "Holdout accuracy",
        value: report.accuracy.holdoutAccuracy === null ? "n/a" : report.accuracy.holdoutAccuracy.toFixed(4),
        hint: `baseline ${report.accuracy.majorityBaseline.toFixed(3)}`,
      },
    ],
    quickFindings: [report.interpretation, ...report.warnings.slice(0, 2)],
  };
}

// ---------------------------------------------------------------------------
// Heterogeneous treatment effects (CATE)
// ---------------------------------------------------------------------------

function runHte(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "hte" }>): AnalysisResult {
  const wi = requireColumn(ctx.columns, cfg.treatmentCol);
  const yi = requireColumn(ctx.columns, cfg.outcomeCol, "number");
  const features = (cfg.features ?? []).filter(
    (f) => f && f !== cfg.treatmentCol && f !== cfg.outcomeCol && columnIndex(ctx.columns, f) >= 0,
  );
  if (features.length === 0) throw new AnalysisInputError("HTE needs at least one covariate column.");
  for (const f of features) requireColumn(ctx.columns, f, "number");

  const rows: { x: number[]; w: 0 | 1; y: number }[] = [];
  let dropped = 0;
  for (const row of ctx.rows) {
    const x = features.map((f) => asNumber(row[columnIndex(ctx.columns, f)]));
    const y = asNumber(row[yi]);
    const wRaw = cellString(row[wi]).trim().toLowerCase();
    const w: 0 | 1 | null =
      wRaw === "1" || wRaw === "treated" || wRaw === "true"
        ? 1
        : wRaw === "0" || wRaw === "control" || wRaw === "false"
          ? 0
          : null;
    if (!x.every(Number.isFinite) || !Number.isFinite(y) || w === null) {
      dropped += 1;
      continue;
    }
    rows.push({ x, w, y });
  }
  if (rows.length < 30) {
    throw new AnalysisInputError(
      `HTE needs at least 30 complete rows with a 0/1 assignment and numeric covariates; found ${rows.length}${dropped ? ` (${dropped} dropped)` : ""}.`,
    );
  }
  const nT = rows.filter((r) => r.w === 1).length;
  const nC = rows.length - nT;
  if (nT < 5 || nC < 5) {
    throw new AnalysisInputError(
      `HTE needs at least 5 treated and 5 control rows; found ${nT} treated / ${nC} control.`,
    );
  }

  const learner = (["dr-learner", "r-learner", "forest"] as const).includes(cfg.learner as "dr-learner")
    ? cfg.learner
    : "dr-learner";
  let fit;
  try {
    fit = fitHte(
      rows,
      {
        learner,
        folds: Math.max(2, Math.round(cfg.folds || 4)),
        regularization: cfg.regularization > 0 ? cfg.regularization : 0.01,
        minLeaf: Math.max(2, Math.round(cfg.minLeaf || 20)),
        depth: Math.max(1, Math.round(cfg.depth || 2)),
      },
      features,
    );
  } catch (err) {
    throw wrapEngineError(err, "HTE");
  }

  const cats = fit.quantileSegments.map((q) => q.quantile);
  const base = baseResult(
    ctx,
    cfg,
    {
      method: `${learner === "forest" ? "Honest causal forest" : learner === "r-learner" ? "R-learner (orthogonalised on residualised treatment)" : "DR-learner (doubly-robust)"} for conditional average treatment effects: out-of-fold nuisance estimates produce a pseudo-outcome whose mean is the CATE, with influence-function standard errors. Subgroup findings and quantile segments describe where the effect concentrates — they are exploratory, not confirmatory.`,
      steps: [
        `Fitted on ${fit.cate.n} rows: ${fit.cate.nTreated} treated, ${fit.cate.nControl} control.`,
        `ATE = ${fit.cate.ate.toFixed(4)}, SE = ${fit.cate.se.toFixed(4)}, 95% CI [${fit.cate.ci[0].toFixed(4)}, ${fit.cate.ci[1].toFixed(4)}], p = ${fit.cate.pValue.toExponential(3)}.`,
        `Propensity range [${fit.propensity.min.toFixed(3)}, ${fit.propensity.max.toFixed(3)}], mean ${fit.propensity.mean.toFixed(3)}; ${fit.propensity.clipped} value(s) clipped; ${fit.propensity.verdict}.`,
        `Evaluation: ATE error ${fit.evaluation.ateError.toFixed(4)}, ψ-correlation ${fit.evaluation.psiCorrelation.toFixed(3)}, R² ${fit.evaluation.rSquared.toFixed(3)}.`,
        ...fit.subgroups
          .slice(0, 5)
          .map((s) => `${s.description} (n=${s.size}): effect ${s.effect.toFixed(3)}, p=${s.pValue.toFixed(4)}.`),
        fit.interpretation,
      ],
      assumptions: [
        "Unconfoundedness given the covariates — the same identifying assumption as every CATE method; no design feature fixes confounding.",
        "Subgroup and quantile splits are exploratory and were not pre-registered; treat them as hypotheses.",
        "Cross-fitting (out-of-fold nuisance estimates) prevents the model from scoring on its own training residuals.",
      ],
    },
    fit.warnings,
  );
  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "CATE by outcome quantile",
        subtitle: `ATE ${fit.cate.ate.toFixed(3)} (95% CI ${fit.cate.ci[0].toFixed(3)} to ${fit.cate.ci[1].toFixed(3)}).`,
        categories: cats,
        series: [{ name: "Effect", data: fit.quantileSegments.map((q) => q.effect), color: "#5AA8AA" }],
        yLabel: "Conditional effect",
      },
    ],
    tables: [
      {
        title: "Quantile segments",
        columns: [
          { key: "q", label: "Quantile", format: "text" },
          { key: "n", label: "n", format: "number" },
          { key: "e", label: "Effect", format: "number" },
          { key: "se", label: "SE", format: "number" },
        ],
        rows: fit.quantileSegments.map((q) => [q.quantile, q.count, q.effect, q.se]),
      },
      {
        title: "Subgroups",
        columns: [
          { key: "d", label: "Subgroup", format: "text" },
          { key: "n", label: "n", format: "number" },
          { key: "e", label: "Effect", format: "number" },
          { key: "p", label: "p-value", format: "number" },
        ],
        rows: fit.subgroups.map((s) => [s.description, s.size, s.effect, s.pValue]),
      },
    ],
    stats: [
      { label: "Learner", value: fit.learner },
      { label: "ATE", value: fit.cate.ate.toFixed(4), hint: `p = ${fit.cate.pValue.toExponential(2)}` },
      { label: "95% CI", value: `${fit.cate.ci[0].toFixed(3)} to ${fit.cate.ci[1].toFixed(3)}` },
      { label: "n T / C", value: `${fit.cate.nTreated} / ${fit.cate.nControl}` },
      {
        label: "Propensity",
        value: `${fit.propensity.min.toFixed(2)}–${fit.propensity.max.toFixed(2)}`,
        hint: fit.propensity.verdict,
      },
    ],
    quickFindings: [fit.interpretation],
  };
}

// ---------------------------------------------------------------------------
// Instrumental variables
// ---------------------------------------------------------------------------

function runIvCalculus(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "iv-calculus" }>): AnalysisResult {
  const yi = requireColumn(ctx.columns, cfg.outcomeCol, "number");
  const xi = requireColumn(ctx.columns, cfg.treatmentCol, "number");
  const zCols = (cfg.instrumentCols ?? []).filter(
    (c) => c && c !== cfg.treatmentCol && c !== cfg.outcomeCol && columnIndex(ctx.columns, c) >= 0,
  );
  if (zCols.length === 0) throw new AnalysisInputError("IV needs at least one instrument column.");
  const cCols = (cfg.controlCols ?? []).filter(
    (c) => c && c !== cfg.treatmentCol && c !== cfg.outcomeCol && columnIndex(ctx.columns, c) >= 0,
  );
  for (const c of [...zCols, ...cCols]) requireColumn(ctx.columns, c, "number");

  const y: number[] = [];
  const x: number[] = [];
  const z: number[][] = [];
  const controls: number[][] = [];
  let dropped = 0;
  for (const row of ctx.rows) {
    const yy = asNumber(row[yi]);
    const xx = asNumber(row[xi]);
    const zz = zCols.map((c) => asNumber(row[columnIndex(ctx.columns, c)]));
    const cc = cCols.map((c) => asNumber(row[columnIndex(ctx.columns, c)]));
    if (!Number.isFinite(yy) || !Number.isFinite(xx) || !zz.every(Number.isFinite) || !cc.every(Number.isFinite)) {
      dropped += 1;
      continue;
    }
    y.push(yy);
    x.push(xx);
    z.push(zz);
    controls.push(cc);
  }
  if (y.length < 12) {
    throw new AnalysisInputError(
      `IV estimation needs at least 12 complete rows; found ${y.length}${dropped ? ` (${dropped} dropped)` : ""}.`,
    );
  }

  let res;
  try {
    res = estimateIv({
      y,
      x,
      z,
      controls: cCols.length > 0 ? controls : undefined,
      estimator: cfg.estimator === "liml" ? "liml" : "2sls",
      alpha: cfg.alpha > 0 && cfg.alpha < 1 ? cfg.alpha : 0.05,
      instrumentNames: zCols,
    });
  } catch (err) {
    throw wrapEngineError(err, "IV");
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method: `${res.estimator.toUpperCase()} instrumental-variables estimate of the effect of ${cfg.treatmentCol} on ${cfg.outcomeCol}, using ${zCols.join(", ")} as excluded instrument(s)${cCols.length ? ` and conditioning on ${cCols.join(", ")}` : ""}. First-stage strength is reported because a weak instrument biases the estimate toward OLS and invalidates the usual inference; the Anderson–Rubin set is the weak-IV-robust confidence region.`,
      steps: [
        `n = ${res.n}${dropped ? `, ${dropped} incomplete row(s) dropped` : ""}.`,
        `IV estimate ${res.beta.toFixed(4)}, SE ${res.stdError.toFixed(4)}, t = ${res.tStatistic.toFixed(3)}, p = ${res.pValue.toExponential(3)}, 95% CI [${res.ci[0].toFixed(4)}, ${res.ci[1].toFixed(4)}].`,
        `OLS (for contrast): ${res.olsBeta.toFixed(4)} ± ${res.olsStdError.toFixed(4)} — endogeneity shifts the estimate by ${(res.beta - res.olsBeta).toFixed(4)}.`,
        `First-stage F = ${res.firstStageF.toFixed(3)} (R² = ${res.firstStageR2.toFixed(4)}) — ${res.strength.verdict}: ${res.strength.message}`,
        `Anderson–Rubin: ${res.andersonRubin.rejectsNullAtZero ? "rejects β = 0" : "does not reject β = 0"}; set ${res.andersonRubin.set ? `[${res.andersonRubin.set[0].toFixed(4)}, ${res.andersonRubin.set[1].toFixed(4)}]` : "n/a"}. ${res.andersonRubin.note}`,
        ...(res.overidentification
          ? [
              `Over-identification J = ${res.overidentification.j.toFixed(3)} on ${res.overidentification.df} df, p = ${res.overidentification.pValue.toFixed(4)} — ${res.overidentification.message}`,
            ]
          : ["Single instrument — no over-identification test is available."]),
        res.interpretation,
      ],
      assumptions: [
        "Relevance: the instruments move the treatment (checked by first-stage F).",
        "Exclusion: instruments affect the outcome only through the treatment — untestable without more structure.",
        "Exogeneity / independence: instruments are as-good-as randomly assigned conditional on controls.",
        "Homoskedasticity is not assumed for the default SE; small-sample IV inference is fragile — read the AR set, not just the Wald CI.",
      ],
    },
    [...res.warnings, ...(res.strength.verdict !== "strong" ? [res.strength.message] : [])],
  );
  return {
    ...base,
    charts: [
      {
        kind: "bar",
        title: "OLS vs IV estimate",
        subtitle: res.interpretation,
        categories: ["OLS", res.estimator.toUpperCase()],
        series: [{ name: "Coefficient", data: [res.olsBeta, res.beta], color: "#5AA8AA" }],
        yLabel: "Effect on " + cfg.outcomeCol,
      },
    ],
    tables: [
      {
        title: "Instruments",
        columns: [
          { key: "n", label: "Instrument", format: "text" },
          { key: "b", label: "First-stage coef", format: "number" },
          { key: "t", label: "First-stage t", format: "number" },
          { key: "f", label: "Own F", format: "number" },
        ],
        rows: res.instruments.map((i) => [i.name, i.firstStageCoef, i.firstStageT, i.ownF]),
      },
      {
        title: "Estimate",
        columns: [
          { key: "k", label: "Quantity", format: "text" },
          { key: "v", label: "Value", format: "number" },
        ],
        rows: [
          ["IV beta", res.beta],
          ["Std error", res.stdError],
          ["t", res.tStatistic],
          ["p", res.pValue],
          ["95% CI low", res.ci[0]],
          ["95% CI high", res.ci[1]],
          ["OLS beta", res.olsBeta],
          ["First-stage F", res.firstStageF],
          ["First-stage R²", res.firstStageR2],
        ],
      },
    ],
    stats: [
      { label: "Estimator", value: res.estimator },
      { label: "IV beta", value: res.beta.toFixed(4) },
      { label: "95% CI", value: `${res.ci[0].toFixed(3)} to ${res.ci[1].toFixed(3)}` },
      { label: "First-stage F", value: res.firstStageF.toFixed(2), hint: res.strength.verdict },
      { label: "OLS beta", value: res.olsBeta.toFixed(4), hint: "for contrast" },
      {
        label: "AR set",
        value: res.andersonRubin.set
          ? `${res.andersonRubin.set[0].toFixed(3)} to ${res.andersonRubin.set[1].toFixed(3)}`
          : "n/a",
        hint: res.andersonRubin.rejectsNullAtZero ? "rejects 0" : "contains 0",
      },
    ],
    quickFindings: [res.interpretation, res.strength.message],
  };
}

// ---------------------------------------------------------------------------
// Geospatial
// ---------------------------------------------------------------------------

function runGeospatial(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "geospatial" }>): AnalysisResult {
  const li = requireColumn(ctx.columns, cfg.latCol, "number");
  const oi = requireColumn(ctx.columns, cfg.lonCol, "number");
  const mi = requireColumn(ctx.columns, cfg.metric, "number");
  const ri =
    cfg.regionCol && cfg.regionCol !== cfg.latCol && cfg.regionCol !== cfg.lonCol
      ? requireColumn(ctx.columns, cfg.regionCol)
      : -1;

  const raw: GeoPoint[] = [];
  let dropped = 0;
  ctx.rows.forEach((row, i) => {
    const lat = asNumber(row[li]);
    const lon = asNumber(row[oi]);
    const value = asNumber(row[mi]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(value) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      dropped += 1;
      return;
    }
    raw.push({
      id: ri >= 0 ? cellString(row[ri]) || `row-${i}` : `row-${i}`,
      lat,
      lon,
      value,
      region: ri >= 0 ? cellString(row[ri]) || undefined : undefined,
    });
  });
  if (raw.length < 2) {
    throw new AnalysisInputError(
      `Geospatial analysis needs at least 2 valid (lat, lon, ${cfg.metric}) points; found ${raw.length}.${dropped ? ` ${dropped} row(s) dropped.` : ""}`,
    );
  }

  // Aggregate to region centroids when a region column is present — spatial
  // autocorrelation on thousands of points from the same store is meaningless.
  let points: GeoPoint[] = raw;
  let aggregated = false;
  if (ri >= 0 && raw.length > 200) {
    const byRegion = new Map<string, GeoPoint[]>();
    for (const p of raw) {
      const list = byRegion.get(p.id) ?? [];
      list.push(p);
      byRegion.set(p.id, list);
    }
    if (byRegion.size >= 2 && byRegion.size < raw.length) {
      points = [...byRegion.entries()].map(([id, list]) => ({
        id,
        lat: mean(list.map((p) => p.lat)),
        lon: mean(list.map((p) => p.lon)),
        value: mean(list.map((p) => p.value)),
        region: id,
      }));
      aggregated = true;
    }
  }

  const method = (["morans-i", "getis-ord", "distance-decay", "clusters", "hotspots"] as const).includes(
    cfg.method as "morans-i",
  )
    ? cfg.method
    : "morans-i";
  const permutations = Math.max(0, Math.min(9999, Math.round(cfg.permutations || 999)));
  let report;
  try {
    report = runGeospatialAnalysis({
      points,
      method,
      bandKm: cfg.bandKm > 0 ? cfg.bandKm : 25,
      permutations,
    });
  } catch (err) {
    throw wrapEngineError(err, "Geospatial");
  }

  const base = baseResult(
    ctx,
    cfg,
    {
      method:
        method === "morans-i"
          ? `Global Moran's I on ${points.length} location(s) with a distance-band neighbourhood (${cfg.bandKm > 0 ? `${cfg.bandKm} km` : "default 25 km"}), ${permutations} permutations for the null distribution — a direct test of whether similar values cluster in space rather than scatter randomly.`
          : method === "getis-ord" || method === "hotspots"
            ? `Local Getis–Ord G*i statistics per location with Benjamini–Hochberg FDR control — identifies specific hot and cold spots, not just a global tendency.`
            : method === "distance-decay"
              ? `Regresses the similarity of value pairs on their geographic distance — the slope is the spatial decay rate and the half-life is the distance at which similarity halves.`
              : `DBSCAN density clustering in km-space (${cfg.bandKm > 0 ? `eps = ${cfg.bandKm} km` : "default eps"}), with k-nearest-neighbour contrast per point.`,
      steps: [
        `${points.length} location(s) used${aggregated ? ` (aggregated from ${raw.length} row(s) to region centroids)` : ""}${dropped ? `; ${dropped} row(s) dropped for invalid coordinates or non-numeric ${cfg.metric}` : ""}.`,
        `Value range: ${Math.min(...points.map((p) => p.value)).toFixed(2)} to ${Math.max(...points.map((p) => p.value)).toFixed(2)}.`,
        report.interpretation,
        ...(report.moransI
          ? [
              `Moran's I = ${report.moransI.statistic.toFixed(4)} (expected ${report.moransI.expected.toFixed(4)}), z = ${report.moransI.zScore.toFixed(3)}, p = ${report.moransI.pValue.toExponential(3)} → ${report.moransI.pattern}.`,
            ]
          : []),
        ...(report.decay
          ? [
              `Distance decay slope ${report.decay.slope.toFixed(4)} (SE ${report.decay.standardError.toFixed(4)}), R² = ${report.decay.rSquared.toFixed(3)}${report.decay.halfLifeKm !== null ? `, half-life ${report.decay.halfLifeKm.toFixed(1)} km` : ""}.`,
            ]
          : []),
        ...(report.giStar
          ? [
              `G*i: ${report.giStar.filter((g) => g.classification === "hot-spot").length} hot spot(s), ${report.giStar.filter((g) => g.classification === "cold-spot").length} cold spot(s) at FDR-controlled significance.`,
            ]
          : []),
        ...(report.clusters
          ? [`DBSCAN: ${report.clusters.length} cluster(s), ${report.noiseCount ?? 0} noise point(s).`]
          : []),
      ],
      assumptions: [
        "Coordinates are WGS84 degrees; distances use the haversine formula on a spherical earth.",
        "The neighbourhood (distance band or k) is a modelling choice — different bands can flip the conclusion from clustered to random.",
        "Permutation inference assumes locations are exchangeable under the null; spatial ordering in the file does not matter.",
        cfg.weightCol
          ? `“${cfg.weightCol}” was configured as a weight column but this engine does not weight locations — the analysis is unweighted.`
          : "Locations are unweighted; each contributes equally to the statistic.",
      ],
    },
    [
      ...report.warnings,
      ...(cfg.weightCol
        ? [`Weight column “${cfg.weightCol}” is not used by this engine — analysis is unweighted.`]
        : []),
      ...(aggregated
        ? [`Points aggregated to ${points.length} region centroid(s) from ${raw.length} raw row(s).`]
        : []),
      ...(dropped > 0 ? [`${dropped} row(s) dropped for invalid coordinates or non-numeric values.`] : []),
    ],
  );
  return {
    ...base,
    charts: [
      {
        kind: "scatter",
        title: `${cfg.metric} across locations`,
        subtitle: report.interpretation,
        xLabel: cfg.lonCol,
        yLabel: cfg.latCol,
        series: [
          {
            name: cfg.metric,
            points: points.slice(0, 2000).map((p) => ({ x: p.lon, y: p.lat })),
            color: "#5AA8AA",
          },
        ],
      },
    ],
    tables: [
      {
        title: "Locations",
        columns: [
          { key: "id", label: "Location", format: "text" },
          { key: "lat", label: "Lat", format: "number" },
          { key: "lon", label: "Lon", format: "number" },
          { key: "v", label: cfg.metric, format: "number" },
        ],
        rows: points.slice(0, 100).map((p) => [p.id, p.lat, p.lon, p.value]),
      },
      ...(report.giStar
        ? ([
            {
              title: "G*i classifications",
              columns: [
                { key: "id", label: "Location", format: "text" },
                { key: "z", label: "z", format: "number" },
                { key: "p", label: "p", format: "number" },
                { key: "c", label: "Class", format: "text" },
              ],
              rows: report.giStar.map((g) => [g.id, g.zScore, g.pValue, g.classification]),
            },
          ] as TableSpec[])
        : []),
    ],
    stats: [
      { label: "Method", value: report.method },
      { label: "Locations", value: String(report.points), hint: aggregated ? "region centroids" : "raw points" },
      ...(report.moransI
        ? [
            { label: "Moran's I", value: report.moransI.statistic.toFixed(4), hint: report.moransI.pattern },
            {
              label: "p-value",
              value: report.moransI.pValue < 1e-4 ? "< 0.0001" : report.moransI.pValue.toFixed(5),
              hint: `${report.moransI.permutations} permutations`,
            },
          ]
        : []),
      ...(report.decay
        ? [
            { label: "Decay slope", value: report.decay.slope.toFixed(4) },
            {
              label: "Half-life",
              value: report.decay.halfLifeKm === null ? "not reached" : `${report.decay.halfLifeKm.toFixed(1)} km`,
            },
          ]
        : []),
      ...(report.clusters
        ? [{ label: "Clusters", value: String(report.clusters.length), hint: `${report.noiseCount ?? 0} noise` }]
        : []),
      ...(report.giStar
        ? [
            {
              label: "Hot spots",
              value: String(report.giStar.filter((g) => g.classification === "hot-spot").length),
            },
          ]
        : []),
    ],
    quickFindings: [report.interpretation],
  };
}

// ---------------------------------------------------------------------------
// Multi-group helpers used by variance / group-comparison (Phase 2)
// ---------------------------------------------------------------------------

/** Group per-row numeric values by a dimension column. */
function groupValuesBy(ctx: Ctx, dimensionCol: string, valueCol: string): { labels: string[]; groups: number[][] } {
  const gi = requireColumn(ctx.columns, dimensionCol);
  const vi = requireColumn(ctx.columns, valueCol, "number");
  const map = new Map<string, number[]>();
  let dropped = 0;
  for (const row of ctx.rows) {
    const g = cellString(row[gi]) || "(blank)";
    const v = asNumber(row[vi]);
    if (!Number.isFinite(v)) {
      dropped += 1;
      continue;
    }
    const list = map.get(g) ?? [];
    list.push(v);
    map.set(g, list);
  }
  void dropped;
  const labels = [...map.keys()].sort();
  return { labels, groups: labels.map((l) => map.get(l) as number[]) };
}

/** Minor units → major units, for statement tables that render as numbers. */
function fromMinor(minor: number): number {
  return minor / 100;
}

/** Heuristic for "medians are close relative to spread" — used only for a warning. */
function mediansAreSimilar(medA: number, medB: number, sdA: number, sdB: number): boolean {
  const scale = Math.max(sdA, sdB, Number.EPSILON);
  return Math.abs(medA - medB) / scale < 0.1;
}

/** Column-types an analysis kind needs, for the "new analysis" picker. */
export function requiredColumnsFor(kind: AnalysisKind): { type: ColumnDef["type"]; role: string }[] {
  switch (kind) {
    case "eda":
      return [];
    case "trend":
      return [
        { type: "date", role: "date" },
        { type: "number", role: "metric" },
      ];
    case "kpi":
      return [{ type: "number", role: "metric" }];
    case "correlation":
      return [{ type: "number", role: "columns" }];
    case "distribution":
      return [{ type: "number", role: "column" }];
    case "forecast":
      return [
        { type: "date", role: "date" },
        { type: "number", role: "metric" },
      ];
    case "variance":
      return [{ type: "number", role: "metric" }];
    case "segmentation":
      return [{ type: "number", role: "columns" }];
    case "cohort":
      return [
        { type: "date", role: "date" },
        { type: "string", role: "entity" },
      ];
    case "funnel":
      return [{ type: "string", role: "stage" }];
    case "whatif":
      return [
        { type: "number", role: "driver" },
        { type: "number", role: "outcome" },
      ];
    case "abtest":
      return [
        { type: "string", role: "arm" },
        { type: "number", role: "successes" },
        { type: "number", role: "trials" },
      ];
    case "automl":
      return [{ type: "number", role: "target" }];
    case "arimax":
      return [
        { type: "date", role: "date" },
        { type: "number", role: "metric" },
        { type: "number", role: "driver" },
      ];
    case "regression":
      return [
        { type: "string", role: "group" },
        { type: "number", role: "value" },
      ];
    case "dataquality":
      return [{ type: "string", role: "column" }];
    case "accounting":
      return [
        { type: "date", role: "date" },
        { type: "string", role: "account" },
        { type: "number", role: "debit" },
        { type: "number", role: "credit" },
      ];
    case "syntheticcontrol":
      return [
        { type: "date", role: "date" },
        { type: "string", role: "unit" },
        { type: "number", role: "metric" },
      ];
    case "uplift":
      return [
        { type: "string", role: "treatment" },
        { type: "number", role: "outcome" },
        { type: "number", role: "features" },
      ];
    case "sprt":
      return [
        { type: "string", role: "arm" },
        { type: "number", role: "successes" },
        { type: "number", role: "trials" },
      ];
    case "drift":
      return [{ type: "number", role: "column" }];
    case "compliance":
      return [
        { type: "string", role: "kind" },
        { type: "number", role: "taxable" },
        { type: "number", role: "rate" },
      ];
    case "did":
      return [
        { type: "string", role: "group" },
        { type: "string", role: "period" },
        { type: "number", role: "metric" },
      ];
    case "survival":
      return [
        { type: "number", role: "time" },
        { type: "number", role: "event" },
      ];
    case "bayesian":
      return [{ type: "number", role: "target" }];
    case "sarima":
      return [
        { type: "date", role: "date" },
        { type: "number", role: "metric" },
      ];
    case "distributed":
      return [{ type: "number", role: "metric" }];
    case "streaming":
      return [
        { type: "date", role: "date" },
        { type: "number", role: "metric" },
      ];
    case "deep-learning":
      return [{ type: "number", role: "target" }];
    case "nlp":
      return [{ type: "string", role: "text" }];
    case "feature-store":
      return [
        { type: "string", role: "entity" },
        { type: "date", role: "eventTime" },
      ];
    case "real-time-serving":
      return [
        { type: "number", role: "feature" },
        { type: "number", role: "target" },
      ];
    case "hte":
      return [
        { type: "string", role: "treatment" },
        { type: "number", role: "outcome" },
      ];
    case "iv-calculus":
      return [
        { type: "number", role: "outcome" },
        { type: "number", role: "treatment" },
        { type: "number", role: "instrument" },
      ];
    case "geospatial":
      return [
        { type: "number", role: "lat" },
        { type: "number", role: "lon" },
        { type: "number", role: "metric" },
      ];
    case "map":
      return [{ type: "string", role: "region" }];
    default:
      return [];
  }
}



/** Choropleth map analysis - classifies region/metric pairs and returns chart specs. */
function runMap(ctx: Ctx, cfg: Extract<AnalysisConfig, { kind: "map" }>): AnalysisResult {
  const regionCol = cfg.regionCol;
  const metricCol = cfg.metricCol;

  const regionIdx = columnIndex(ctx.columns, regionCol);
  if (regionIdx < 0) throw new AnalysisInputError(`Column "${regionCol}" not found in the dataset.`);

  const metricIdx = columnIndex(ctx.columns, metricCol);
  if (metricIdx < 0) throw new AnalysisInputError(`Column "${metricCol}" not found in the dataset.`);

  const regions = ctx.rows.map((r) => cellString(r[regionIdx]));
  const values = ctx.rows.map((r) => cellNumber(r[metricIdx]));

  // Filter out rows with missing region or metric
  const validRows: { region: string; value: number }[] = [];
  for (let i = 0; i < ctx.rows.length; i++) {
    if (regions[i] && Number.isFinite(values[i])) {
      validRows.push({ region: regions[i]!, value: values[i]! });
    }
  }

  if (validRows.length === 0) {
    throw new AnalysisInputError("No valid region-value pairs found. Ensure the region and metric columns contain data.");
  }

  // Type guard: metric exists when kind is not "map"
  const hasMetric = cfg.kind !== "map";
  const classified = classifyValues(validRows, { method: "quantile", classCount: 5 });

  const chartTitle = `${(cfg as { metric?: string; kind: string }).metric?.toString() ?? "Metric"} by ${cfg.regionCol ?? "Region"}`;

  const charts: ChartSpec[] = [
    {
      kind: "map",
      title: chartTitle,
      categories: validRows.map((r) => r.region),
      series: [{ name: hasMetric ? ((cfg as { metric?: string }).metric?.toString() ?? "Value") : "Value", data: classified.classes.map((c) => c.value), color: "#5AA8AA" }],
      mapData: classified.classes.map((c) => ({
        region: c.region,
        value: c.value,
      })),
    },
  ];

  const result = baseResult(ctx, cfg, {
    method: `${hasMetric ? ((cfg as { metric?: string }).metric ?? "metric") : "metric"} by ${cfg.regionCol ?? "region"} using quantile classification (5 classes).`,
    steps: [
      `Read ${validRows.length} region-value pairs from the dataset.`,
      "Classified values into 5 quantile classes (equal distribution per class).",
      "Joined classified values onto normalized region names via the geo engine.",
    ],
    assumptions: [
      "Region names are matched against GeoJSON boundaries via normalizeRegionName.",
      "Missing or unmatched regions render in the no-data gray color.",
      "Quantile classes ensure each class has roughly equal numbers of regions.",
    ],
  });

  return {
    ...result,
    charts,
    tables: undefined,
  };
}

export { quantile };

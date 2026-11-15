import type { Cell } from "@/lib/engine/dataset";
import { bucketByDate, cellString, columnIndex, numericColumn, valueCounts } from "@/lib/engine/dataset";
import { max, min, outlierCount, pearson, stddev, sum } from "@/lib/engine/stats";
import type { AnalysisResult, ColumnDef, InsightInput } from "@/lib/types";

export interface ScanContext {
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
  datasetId: string;
  datasetName: string;
  datasetWarnings: string[];
  sampled: boolean;
}

const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${Math.round(v * 10) / 10}%` : "—");

/**
 * Scan an uploaded dataset and derive deterministic, evidence-backed insight
 * cards. Nothing here is random or synthetic — every card cites the exact
 * columns, periods and numbers it was computed from.
 */
export function scanDatasetForInsights(ctx: ScanContext): InsightInput[] {
  const insights: InsightInput[] = [];
  const { columns, rows } = ctx;

  const dateCol = columns.find((c) => c.type === "date")?.name ?? null;
  const numericCols = columns.filter((c) => c.type === "number").map((c) => c.name);
  const candidateDim = columns.find((c) => c.type === "string")?.name ?? null;

  // --- 1. Month-over-month movement of the largest-sum numeric column -------
  if (dateCol && numericCols.length) {
    const totals = numericCols.map((name) => ({ name, total: sum(numericColumn(rows, columns, name)) }));
    totals.sort((a, b) => b.total - a.total);
    const primary = totals[0];
    if (primary) {
      const buckets = bucketByDate(rows, columns, dateCol, primary.name, "month");
      if (buckets.length >= 2) {
        const last = buckets[buckets.length - 1] as (typeof buckets)[number];
        const prev = buckets[buckets.length - 2] as (typeof buckets)[number];
        const change = prev.value !== 0 ? ((last.value - prev.value) / Math.abs(prev.value)) * 100 : null;
        if (change !== null && Math.abs(change) >= 3) {
          const metricName = primary.name;
          const rising = change > 0;
          const title = rising
            ? `${metricName} up ${Math.abs(change).toFixed(1)}% month over month`
            : `${metricName} down ${Math.abs(change).toFixed(1)}% month over month`;
          const cause = rising
            ? "Look for seasonality, promotions or new accounts behind the jump (inferred — check underlying rows in “View evidence”)."
            : "Possible drivers include churn, seasonal dips or pricing changes (inferred — verify against the evidence rows).";
          insights.push({
            title,
            severity: rising ? "info" : Math.abs(change) >= 15 ? "critical" : "warning",
            metric: `sum(${metricName})`,
            observedChange: `${pct(change)} (${prev.label}: ${round2(prev.value)} → ${last.label}: ${round2(last.value)})`,
            evidence: [
              `${metricName} by month: ${prev.label} ${round2(prev.value)} → ${last.label} ${round2(last.value)}`,
              `Change: ${pct(change)} · periods compared: ${prev.label} vs ${last.label}`,
              `Aggregation: SUM over ${ctx.totalRows.toLocaleString()} rows${ctx.sampled ? " (sampled)" : ""}`,
            ],
            possibleCause: cause,
            businessImplication: rising
              ? "The improvement compounds if sustained — protect the drivers behind it."
              : "A sustained decline directly reduces the headline metric; quantify at risk before planning.",
            recommendedNextStep: `Run a ${rising ? "segmentation" : "variance"} analysis on ${metricName} to find which groups moved the most.`,
            confidence: "calculated",
          });
        }
      }
    }
  }

  // --- 2. Concentration risk in a categorical dimension ---------------------
  if (candidateDim && numericCols.length) {
    const metric = numericCols[0] as string;
    const counts = valueCounts(
      rows.map((r) => cellString(r[columnIndex(columns, candidateDim!)])),
      500,
    );
    if (counts.length >= 5 && counts.length <= 200) {
      const top3 = counts.slice(0, 3);
      const total = sum(counts.map((c) => c.count)) || 1;
      const topShare = ((counts[0]?.count ?? 0) / total) * 100;
      if (topShare >= 40) {
        insights.push({
          title: `${topShare.toFixed(0)}% of rows sit in one ${candidateDim} value`,
          severity: topShare >= 65 ? "warning" : "info",
          metric: `count(${candidateDim})`,
          observedChange: `Top value share: ${topShare.toFixed(1)}%`,
          evidence: top3.map(
            (t) => `${candidateDim} = ${t.value}: ${t.count} rows (${((t.count / total) * 100).toFixed(1)}%)`,
          ),
          possibleCause: "A single dominant segment may skew every downstream average and correlation (inferred).",
          businessImplication: "Decisions built on averages may really describe the dominant segment only.",
          recommendedNextStep: `Break ${metric} down by ${candidateDim} before drawing conclusions.`,
          confidence: "calculated",
        });
      }
    }
  }

  // --- 3. Missing-value hotspots ---------------------------------------------
  for (const col of columns) {
    const idx = columnIndex(columns, col.name);
    let missing = 0;
    for (const row of rows) if (row[idx] === null || row[idx] === undefined || row[idx] === "") missing++;
    if (rows.length && missing / rows.length >= 0.05) {
      const rate = (missing / rows.length) * 100;
      insights.push({
        title: `${col.name} is missing in ${rate.toFixed(1)}% of rows`,
        severity: rate >= 25 ? "warning" : "info",
        metric: `missing(${col.name})`,
        observedChange: `${missing.toLocaleString()} of ${rows.length.toLocaleString()} rows missing`,
        evidence: [
          `Missing cells in ${col.name}: ${missing.toLocaleString()}`,
          `Fill rate: ${(100 - rate).toFixed(1)}%`,
        ],
        possibleCause: "Optional fields, partial exports or upstream capture gaps are the usual cause (inferred).",
        businessImplication:
          "Analyses using this column silently exclude those rows — totals can drift from other reports.",
        recommendedNextStep:
          "Decide an explicit fill strategy (drop, impute with a default, or keep as-is with the warning).",
        confidence: "calculated",
      });
    }
  }

  // --- 4. Strong correlations -------------------------------------------------
  if (numericCols.length >= 2) {
    const cols = numericCols.slice(0, 8);
    let best: { a: string; b: string; r: number } | null = null;
    const colValues = cols.map((name) => ({ name, vals: numericColumn(rows, columns, name) }));
    for (let i = 0; i < colValues.length; i++) {
      for (let j = i + 1; j < colValues.length; j++) {
        const x = colValues[i] as { name: string; vals: number[] };
        const y = colValues[j] as { name: string; vals: number[] };
        const pairs: { x: number; y: number }[] = [];
        const len = Math.min(x.vals.length, y.vals.length);
        for (let k = 0; k < len; k++) {
          const a = x.vals[k] as number;
          const b = y.vals[k] as number;
          if (Number.isFinite(a) && Number.isFinite(b)) pairs.push({ x: a, y: b });
        }
        if (pairs.length < 10) continue;
        const { r } = pearson(
          pairs.map((p) => p.x),
          pairs.map((p) => p.y),
        );
        if (Number.isFinite(r) && (!best || Math.abs(r) > Math.abs(best.r))) best = { a: x.name, b: y.name, r };
      }
    }
    if (best && Math.abs(best.r) >= 0.65) {
      const pos = best.r >= 0;
      insights.push({
        title: `Strong ${pos ? "positive" : "negative"} link: ${best.a} ↔ ${best.b}`,
        severity: "info",
        metric: `pearson(${best.a}, ${best.b})`,
        observedChange: `r = ${best.r.toFixed(2)}`,
        evidence: [
          `Correlation coefficient r = ${best.r.toFixed(3)} on pairwise-complete rows`,
          `${best.a} and ${best.b} move ${pos ? "together" : "in opposite directions"} in the data`,
        ],
        possibleCause: "Correlation is not causation — a shared driver (seasonality, scale) may explain it (inferred).",
        businessImplication: pos
          ? "The pair can be used as leading indicators of each other when forecasting."
          : "Improving one metric may coincide with declines in the other.",
        recommendedNextStep: "Open the correlation analysis to inspect the full matrix and row-level evidence.",
        confidence: "calculated",
      });
    }
  }

  // --- 5. Outlier-heavy numeric columns ---------------------------------------
  for (const name of numericCols.slice(0, 6)) {
    const vals = numericColumn(rows, columns, name);
    if (vals.length < 50) continue;
    const out = outlierCount(vals);
    const rate = (out / vals.length) * 100;
    if (out >= 5 && rate >= 1) {
      const q = (p: number) => {
        const s = [...vals].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
      };
      insights.push({
        title: `${name} has ${out} outlier value${out === 1 ? "" : "s"} (${rate.toFixed(1)}%)`,
        severity: rate >= 5 ? "warning" : "info",
        metric: name,
        observedChange: `${out} values beyond 1.5×IQR`,
        evidence: [
          `Outliers: ${out} of ${vals.length} values`,
          `Median ${name}: ${round2(medianSorted(vals))} · Max: ${round2(max(vals))}`,
          `Range of typical values: ${round2(q(0.25))}–${round2(q(0.75))} (interquartile)`,
        ],
        possibleCause:
          "Data entry errors, genuine extremes (large deals, one-off events) or mixed populations (inferred).",
        businessImplication: "Averages are inflated by extremes — use the median for central-tendency reads.",
        recommendedNextStep: "Review the top values in “View evidence” and decide whether to cap, flag or keep them.",
        confidence: "calculated",
      });
    }
  }

  // --- 6. Near-constant numeric columns ---------------------------------------
  for (const name of numericCols) {
    const vals = numericColumn(rows, columns, name);
    if (vals.length < 30) continue;
    if (stddev(vals) === 0 && min(vals) !== 0) {
      insights.push({
        title: `${name} never changes (all values equal)`,
        severity: "info",
        metric: name,
        observedChange: `stddev = 0 over ${vals.length} values`,
        evidence: [`Every observed value of ${name} is ${round2(vals[0] ?? 0)}`],
        possibleCause: "The column may be a constant/flag that adds no analytical signal (inferred).",
        businessImplication: "Constant columns should be excluded from correlation and clustering inputs.",
        recommendedNextStep: "Drop or ignore this column for numeric analyses.",
        confidence: "calculated",
      });
    }
  }

  // --- 7. Data-quality warnings surfaced as insights ---------------------------
  for (const warning of ctx.datasetWarnings) {
    insights.push({
      title: "Data-quality notice",
      severity: "warning",
      metric: undefined,
      observedChange: undefined,
      evidence: [warning],
      possibleCause: undefined,
      businessImplication: "Results referencing this data inherit the caveat above.",
      recommendedNextStep: "Re-upload a cleaned version, or review the column with the issue.",
      confidence: "calculated",
    });
  }

  return insights.slice(0, 12);
}

/** Derive insight cards straight from a just-run analysis result. */
export function insightsFromAnalysis(result: AnalysisResult, datasetName: string): InsightInput[] {
  const cards: InsightInput[] = [];
  const findings = result.quickFindings ?? [];
  for (const f of findings.slice(0, 3)) {
    cards.push({
      title: f,
      severity: f.includes("down") || f.includes("drop") || f.includes("Low") ? "warning" : "info",
      metric: result.dataset.columns.slice(0, 5).join(", "),
      observedChange: undefined,
      evidence: [
        f,
        ...result.configHuman.slice(0, 2),
        `Scope: ${result.scope.rowsUsed.toLocaleString()} of ${result.scope.totalRows.toLocaleString()} rows${result.scope.sampled ? " (sampled)" : ""}`,
      ],
      possibleCause: "Automatic finding from the analysis output — verify against the evidence rows.",
      businessImplication: "Included for executive visibility; severity is auto-assigned.",
      recommendedNextStep: `Open the ${result.kind} analysis to explore interactively.`,
      confidence: "calculated",
      extra: { analysisKind: result.kind, datasetName },
    });
  }
  return cards;
}

function medianSorted(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

import {
  compareTopSegments,
  concentrationDiagnosis,
  decomposeByDimension,
  diagnoseTrend,
  outlierExposure,
  resolveDateColumn,
  resolveDimension,
  resolvePrimaryMetric,
  type AdvisorDataset,
} from "@/lib/engine/advisor-analysis";
import type { Cell } from "@/lib/engine/dataset";
import { columnIndex } from "@/lib/engine/dataset";
import { pearson } from "@/lib/engine/stats";
import type { AdvisorResult, ColumnDef } from "@/lib/types";

export interface AdvisorInput {
  question: string;
  columns: ColumnDef[];
  rows: Cell[][];
  totalRows: number;
  sampled: boolean;
  datasetName: string;
  datasetId: string;
}

type Intent = "performance" | "trend" | "forecast" | "drivers" | "segments" | "quality" | "recommendation" | "overview";

function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/\b(forecast|predict|project|next month|next quarter|future)\b/.test(s)) return "forecast";
  if (/\b(trend|growing|declining|increase|decrease|over time|progress)\b/.test(s)) return "trend";
  if (/\b(driver|why (is|are|did)|what drives|explain)\b/.test(s)) return "drivers";
  if (/\b(segment|customer|cluster|group|cohort|who are)\b/.test(s)) return "segments";
  if (/\b(quality|missing|clean|duplicate|accurate|reliable)\b/.test(s)) return "quality";
  if (/\b(recommend|should we|what next|improve|action|invest)\b/.test(s)) return "recommendation";
  if (/\b(revenue|sales|performance|how are we doing|business (health|status))\b/.test(s)) return "performance";
  return "overview";
}

const fmt = (v: number) =>
  !Number.isFinite(v)
    ? "—"
    : Math.abs(v) >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : Math.abs(v) >= 1e3
        ? `${(v / 1e3).toFixed(1)}K`
        : v.toFixed(2);

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/**
 * Deterministic elite advisor.
 *
 * Flow: resolve the metric/dimension/date columns from the data → run every
 * diagnostic that the columns allow → route the question's intent → compose
 * the executive answer ONLY from computed facts. Sections that need data the
 * file does not carry (e.g. no date column → no trend test) are named in
 * `diagnostics.unavailable` and framed as such in the answer — never guessed.
 */
export function answerAdvisorQuestion(input: AdvisorInput): AdvisorResult {
  const ds: AdvisorDataset = {
    columns: input.columns,
    rows: input.rows,
    totalRows: input.totalRows,
    datasetName: input.datasetName,
    datasetId: input.datasetId,
  };
  const intent = detectIntent(input.question);
  const confidenceFlags: AdvisorResult["confidenceFlags"] = [];
  const flag = (section: string, confidence: AdvisorResult["confidenceFlags"][number]["confidence"]) =>
    confidenceFlags.push({ section, confidence });

  // ---------------- 1. Resolve subjects from the data ----------------
  const metricProfile = resolvePrimaryMetric(ds);
  const metric = metricProfile?.metric ?? null;
  const dimension = metric ? resolveDimension(ds) : null;
  const dateCol = metric ? resolveDateColumn(ds, metric) : null;

  // ---------------- 2. Run all diagnostics the columns allow ----------------
  const unavailable: string[] = [];
  if (!metric)
    unavailable.push(
      "No usable numeric metric column (≥ 5 non-binary values) — headline metrics, trends and segment tests need one.",
    );
  if (metric && !dateCol)
    unavailable.push(
      `No date column with ≥ 2 monthly periods — trend tests and projections are skipped (nothing was guessed).`,
    );
  if (metric && !dimension)
    unavailable.push(
      "No categorical dimension with 2–50 levels — contribution decomposition and segment tests are skipped.",
    );

  const decomposition =
    metric && dimension
      ? (() => {
          try {
            const r = decomposeByDimension(ds, metric, dimension, dateCol);
            return { dateCol, ...r };
          } catch {
            return null;
          }
        })()
      : null;
  const trend = metric && dateCol ? diagnoseTrend(ds, metric, dateCol, "month") : null;
  const concentration = decomposition ? concentrationDiagnosis(decomposition, decomposition.dimension) : null;
  const segmentTest = metric && dimension ? compareTopSegments(ds, metric, dimension) : null;
  const outliers = metric ? outlierExposure(ds, metric) : null;

  // Secondary signal: strongest correlation between the metric and another numeric column.
  let topCorr: { a: string; b: string; r: number; p: number; n: number } | null = null;
  if (metric) {
    const numeric = input.columns
      .filter((c) => c.type === "number" && c.name !== metric)
      .map((c) => c.name)
      .slice(0, 8);
    const mIdx = columnIndex(input.columns, metric);
    for (const other of numeric) {
      const oIdx = columnIndex(input.columns, other);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const row of input.rows) {
        const x = Number(row[oIdx]);
        const y = Number(row[mIdx]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          xs.push(x);
          ys.push(y);
        }
      }
      if (xs.length < 10) continue;
      const res = pearson(xs, ys);
      if (Number.isFinite(res.r) && (!topCorr || Math.abs(res.r) > Math.abs(topCorr.r))) {
        topCorr = { a: other, b: metric, r: res.r, p: res.p, n: res.n };
      }
    }
  }

  // Missing-data risk across the columns the analysis depends on.
  const dependentCols = [metric, dimension, dateCol].filter((c): c is string => Boolean(c));
  const missingFacts: { col: string; rate: number }[] = [];
  for (const col of dependentCols) {
    const idx = columnIndex(input.columns, col);
    let missing = 0;
    for (const row of input.rows) if (row[idx] === null || row[idx] === undefined || row[idx] === "") missing++;
    const rate = input.rows.length ? (missing / input.rows.length) * 100 : 0;
    if (rate >= 5) missingFacts.push({ col, rate });
  }
  const worstMissing = missingFacts.sort((a, b) => b.rate - a.rate)[0] ?? null;

  // ---------------- 3. Evidence (all calculated) ----------------
  const evidence: AdvisorResult["evidence"] = [];
  const addEvidence = (label: string, detail: string, confidence: "calculated" | "inferred" = "calculated") =>
    evidence.push({ label, detail, confidence });

  addEvidence(
    "Dataset analysed",
    `${input.datasetName} — ${input.rows.length.toLocaleString()} of ${input.totalRows.toLocaleString()} row${input.rows.length === 1 ? "" : "s"}${input.sampled ? " (first-rows sample)" : ""}`,
  );
  if (metricProfile && metric) {
    addEvidence(
      "Headline metric",
      `${metric}: total ${fmt(metricProfile.total)} · mean ${fmt(metricProfile.mean)} · median ${fmt(metricProfile.median)} over ${metricProfile.nonEmpty.toLocaleString()} values`,
    );
  }
  if (trend) {
    addEvidence(
      "Latest movement",
      `${metric} went ${fmt(trend.previous ?? 0)} → ${fmt(trend.latest ?? 0)} (${trend.periods[trend.periods.length - 1]?.label ?? "latest"}), ${pct(trend.changePct)} period over period`,
    );
    addEvidence(
      "Trend significance",
      `Mann–Kendall test on ${trend.nPeriods} ${trend.granularity}ly buckets: S-statistic p = ${trend.mannKendall.p.toFixed(4)} → ${trend.mannKendall.direction}`,
    );
    if (trend.projection) {
      addEvidence(
        "Backtested projection",
        `${trend.projection.method} next-period estimate ${fmt(trend.projection.nextPeriod)} — one-step-ahead backtest on your history: MAE ${fmt(trend.projection.mae)} (~${trend.projection.mape.toFixed(0)}% mean error) over ${trend.projection.folds} rolling origins`,
      );
    }
  }
  if (decomposition && decomposition.groups.length > 0) {
    const top = decomposition.groups[0]!;
    addEvidence(
      "Contribution breakdown",
      `${top.group} contributes ${top.sharePct.toFixed(1)}% of ${metric} (${fmt(top.total)} of ${fmt(decomposition.grandTotal)}) across ${top.rows.toLocaleString()} rows`,
    );
    const mover = [...decomposition.groups]
      .filter((g) => g.latestChange !== null)
      .sort((a, b) => Math.abs(b.latestChange ?? 0) - Math.abs(a.latestChange ?? 0))[0];
    if (mover && mover.latestChange !== null && Math.abs(mover.latestChange) > 0) {
      addEvidence(
        "What moved the latest period",
        `${mover.group} moved ${mover.latestChange >= 0 ? "+" : ""}${fmt(mover.latestChange)} (${pct(mover.latestChangePct)}) between ${decomposition.prevPeriodLabel ?? "previous"} and ${decomposition.latestPeriodLabel ?? "latest"}`,
      );
    }
  }
  if (concentration) {
    addEvidence(
      "Concentration (HHI)",
      `Herfindahl–Hirschman Index on ${concentration.dimension} = ${concentration.hhi} of 10,000 (${concentration.interpretation}); top 3 of ${concentration.levels} hold ${concentration.top3SharePct.toFixed(1)}%`,
    );
  }
  if (segmentTest) {
    addEvidence(
      "Segment contrast",
      `Mean ${metric}: “${segmentTest.segmentA}” ${fmt(segmentTest.meanA)} vs “${segmentTest.segmentB}” ${fmt(segmentTest.meanB)} (${pct(segmentTest.diffPct)}) — Welch t-test p = ${segmentTest.pValue.toFixed(4)} (n = ${segmentTest.nA} vs ${segmentTest.nB}) → ${segmentTest.significant ? "statistically significant" : "NOT statistically significant"}`,
    );
  }
  if (topCorr && Math.abs(topCorr.r) >= 0.4) {
    addEvidence(
      "Strongest co-movement",
      `${topCorr.a} correlates with ${topCorr.b} at r = ${topCorr.r.toFixed(2)} (p = ${topCorr.p.toFixed(4)}, n = ${topCorr.n}) — association, not causation`,
    );
  }
  if (outliers && outliers.outlierRows > 0) {
    addEvidence(
      "Outlier exposure",
      `${outliers.outlierRows} row${outliers.outlierRows === 1 ? "" : "s"} beyond the 1.5×IQR fences (> ${fmt(outliers.outlierThresholdHigh)}) carry ${outliers.totalSharePct !== null ? `${outliers.totalSharePct.toFixed(1)}% of the ${metric} total` : "an outsized share"} — check these before trusting averages`,
    );
  }
  if (worstMissing) {
    addEvidence(
      "Data quality risk",
      `${worstMissing.col} is missing in ${worstMissing.rate.toFixed(1)}% of rows — totals that depend on it silently exclude those rows`,
    );
  }
  if (unavailable.length > 0) {
    addEvidence("Not computable here", unavailable.join(" "), "inferred");
  }

  // ---------------- 4. Risks / opportunities / drivers ----------------
  const risks: string[] = [];
  const opportunities: string[] = [];
  const keyDrivers: string[] = [];

  if (trend && metric) {
    if (trend.mannKendall.p < 0.05 && trend.mannKendall.direction === "decreasing") {
      risks.push(
        `${metric} shows a statistically significant monotonic DECLINE over ${trend.nPeriods} ${trend.granularity}s (Mann–Kendall p = ${trend.mannKendall.p.toFixed(4)}) — quantify exposure before committing to flat-baseline plans.`,
      );
    } else if (trend.mannKendall.p < 0.05 && trend.mannKendall.direction === "increasing") {
      keyDrivers.push(
        `${metric} is on a statistically significant upward path (Mann–Kendall p = ${trend.mannKendall.p.toFixed(4)}, OLS slope ${fmt(trend.olsSlope)}/period, R² = ${trend.olsR2.toFixed(2)}).`,
      );
      opportunities.push(
        `The verified ${trend.granularity}ly uptrend in ${metric} supports capacity/inventory plans built on continued growth — protect the drivers listed below.`,
      );
    } else {
      keyDrivers.push(
        `${metric} is essentially flat across ${trend.nPeriods} periods (Mann–Kendall p = ${trend.mannKendall.p.toFixed(2)}) — growth must come from mix or new segments, not the base trend.`,
      );
    }
  }
  if (decomposition) {
    const top = decomposition.groups[0];
    if (top && top.sharePct >= 40) {
      keyDrivers.push(
        `${top.group} alone contributes ${top.sharePct.toFixed(1)}% of ${metric} — its trajectory effectively IS the business trajectory.`,
      );
      risks.push(
        `Single-group dependency: “${top.group}” holds ${top.sharePct.toFixed(1)}% of ${metric}; a 10% slip there removes ${(top.sharePct * 0.1).toFixed(1)}% of the total.`,
      );
    }
    const decliner = decomposition.groups
      .filter((g) => (g.latestChangePct ?? 0) < -10)
      .sort((a, b) => (a.latestChangePct ?? 0) - (b.latestChangePct ?? 0))[0];
    if (decliner) {
      risks.push(
        `“${decliner.group}” fell ${pct(decliner.latestChangePct)} in the latest period (${fmt(decliner.latestChange ?? 0)}) — the largest single drag on ${metric}.`,
      );
    }
    const riser = decomposition.groups
      .filter((g) => (g.latestChangePct ?? 0) > 10 && (g.sharePct ?? 0) >= 3)
      .sort((a, b) => (b.latestChangePct ?? 0) - (a.latestChangePct ?? 0))[0];
    if (riser) {
      opportunities.push(
        `“${riser.group}” grew ${pct(riser.latestChangePct)} last period while holding ${riser.sharePct.toFixed(1)}% share — the clearest candidate for reinvestment.`,
      );
    }
  }
  if (concentration?.interpretation === "highly concentrated") {
    risks.push(
      `Concentration risk is HIGH (HHI ${concentration.hhi}): the top player in ${concentration.dimension} controls ${concentration.topSharePct.toFixed(0)}% of volume — diversification or retention investment warranted.`,
    );
  }
  if (segmentTest) {
    if (segmentTest.significant) {
      keyDrivers.push(
        `Segment behaviour differs for real: “${segmentTest.segmentA}” averages ${fmt(segmentTest.meanA)} per row vs “${segmentTest.segmentB}” at ${fmt(segmentTest.meanB)} (p = ${segmentTest.pValue.toFixed(4)}) — tailor playbooks per segment instead of one average policy.`,
      );
    } else {
      risks.push(
        `The apparent gap between “${segmentTest.segmentA}” and “${segmentTest.segmentB}” (${pct(segmentTest.diffPct)}) is NOT statistically significant (p = ${segmentTest.pValue.toFixed(2)}) — do not budget on it without more data.`,
      );
    }
  }
  if (topCorr && Math.abs(topCorr.r) >= 0.5 && topCorr.p < 0.05) {
    keyDrivers.push(
      `${topCorr.a} co-moves with ${metric} (r = ${topCorr.r.toFixed(2)}, p = ${topCorr.p.toFixed(4)}) — strongest measurable lever in the file, though association ≠ causation.`,
    );
  }
  if (outliers && outliers.totalSharePct !== null && outliers.totalSharePct >= 20) {
    risks.push(
      `${outliers.totalSharePct.toFixed(0)}% of the ${metric} total sits in ${outliers.outlierRows} outlier rows — a few accounts dominate; plan for their churn explicitly.`,
    );
  }
  if (worstMissing && worstMissing.rate >= 15) {
    risks.push(
      `${worstMissing.col} is blank in ${worstMissing.rate.toFixed(0)}% of rows — fix capture upstream before treating dependent analyses as exhaustive.`,
    );
  }
  if (risks.length === 0)
    risks.push("No concentration, trend, quality or significance risk surfaced by the diagnostics on this dataset.");
  if (opportunities.length === 0)
    opportunities.push(
      "Add more periods or categorical dimensions to expose opportunity levers the current file cannot show.",
    );

  // ---------------- 5. Options ----------------
  const options: AdvisorResult["options"] = [];
  if (trend?.projection) {
    options.push({
      title: `Plan against the backtested path (${trend.projection.method})`,
      detail: `Next ${trend.granularity} projects to ${fmt(trend.projection.nextPeriod)} with backtested one-step error ~${trend.projection.mape.toFixed(0)}% (${trend.projection.folds} origins). ${trend.projection.reliable ? "Error is within a plannable band." : "Error exceeds 25% — treat as directional only."}`,
      confidence: "calculated",
    });
  }
  if (decomposition && decomposition.groups.length > 1) {
    const top = decomposition.groups[0]!;
    options.push({
      title: `Defend and study “${top.group}”`,
      detail: `${top.sharePct.toFixed(1)}% of ${metric} sits in one ${decomposition.dimension}. Retention here has the highest measurable leverage; a 10% slip costs ${fmt(top.total * 0.1)}.`,
      confidence: "calculated",
    });
    const tail = decomposition.groups.slice(3).reduce((acc, g) => acc + g.total, 0);
    if (tail > 0 && top.total > 0 && tail / top.total < 0.5) {
      options.push({
        title: "Diversify the tail",
        detail: `Groups outside the top 3 contribute only ${((tail / decomposition.grandTotal) * 100).toFixed(1)}% of ${metric} — targeted growth experiments there reduce single-group dependency.`,
        confidence: "recommendation",
      });
    }
  }
  if (segmentTest) {
    options.push({
      title: segmentTest.significant ? "Split strategy by segment" : "Grow data before splitting strategy",
      detail: segmentTest.significant
        ? `“${segmentTest.segmentA}” vs “${segmentTest.segmentB}” differ by ${pct(segmentTest.diffPct)} per row with p = ${segmentTest.pValue.toFixed(4)} — per-segment pricing/targeting is justified by the data.`
        : `The segment gap is within noise (p = ${segmentTest.pValue.toFixed(2)}). Collect more rows before paying for differentiated playbooks.`,
      confidence: "calculated",
    });
  }
  options.push({
    title: "Stabilise measurement",
    detail: `Track ${metric ?? "the headline metric"}${dimension ? ` by ${dimension}` : ""} weekly${dateCol ? ` on ${dateCol}` : ""}; alert when the period change exceeds the backtested error band (MAE ${trend?.projection ? fmt(trend.projection.mae) : "—"}).`,
    confidence: "recommendation",
  });

  // ---------------- 6. Intent-specific executive answer ----------------
  const metricLabel = metric ?? "your data";
  const trendPhrase = trend
    ? `${metric} moved ${pct(trend.changePct)} in the latest ${trend.granularity} (${trend.periods[trend.periods.length - 1]?.label ?? "latest"}: ${fmt(trend.latest ?? 0)}) and the Mann–Kendall test reads the ${trend.nPeriods}-period path as ${trend.mannKendall.direction} (p = ${trend.mannKendall.p.toFixed(3)}).`
    : metric
      ? `${metric} totals ${fmt(metricProfile?.total ?? 0)} across ${metricProfile?.nonEmpty.toLocaleString() ?? "0"} values; no date column with ≥ 2 periods exists, so no trend statement is made.`
      : "This dataset has no usable numeric metric, so no headline statement can be made — cast a column to Number and re-ask.";
  const concPhrase = concentration
    ? `${concentration.dimension} is ${concentration.interpretation} (HHI ${concentration.hhi}); “${decomposition?.groups[0]?.group ?? "—"}” leads with ${concentration.topSharePct.toFixed(1)}%.`
    : "";
  const segPhrase = segmentTest
    ? segmentTest.significant
      ? ` Segment means differ for real (${pct(segmentTest.diffPct)}, p = ${segmentTest.pValue.toFixed(3)}).`
      : ` The visible segment gap is not statistically significant (p = ${segmentTest.pValue.toFixed(2)}) — don't budget on it.`
    : "";
  const projPhrase = trend?.projection
    ? ` Next period projects to ${fmt(trend.projection.nextPeriod)} (${trend.projection.method}, backtested MAE ${fmt(trend.projection.mae)}${trend.projection.reliable ? "" : " — beyond the plannable 25% band"}).`
    : "";

  let body: string;
  switch (intent) {
    case "performance":
      body = `Performance read: ${trendPhrase}${concPhrase}${segPhrase}`;
      break;
    case "trend":
      body = `Trend read: ${trendPhrase}${projPhrase}`;
      break;
    case "forecast":
      body = trend?.projection
        ? `Forecast basis: the ${trend.projection.method} model won a rolling-origin backtest on your own history (MAE ${fmt(trend.projection.mae)}, ~${trend.projection.mape.toFixed(0)}% mean one-step error over ${trend.projection.folds} origins). Next ${trend.granularity} point estimate: ${fmt(trend.projection.nextPeriod)}. This is a univariate projection — no external drivers are modelled.${trend.projection.reliable ? "" : " Its error exceeds the 25% plannability band; treat it as directional only."}`
        : "Forecast unavailable: a projection needs a date column with ≥ 3 monthly periods and ≥ 6 rows per period. Nothing was invented in its place.";
      break;
    case "drivers":
      body = decomposition
        ? `Driver read: ${decomposition.groups
            .slice(0, 3)
            .map((g) => `${g.group} (${g.sharePct.toFixed(0)}%)`)
            .join(", ")} together explain ${decomposition.groups
            .slice(0, 3)
            .reduce((a, g) => a + g.sharePct, 0)
            .toFixed(0)}% of ${metric}.${moverSentence(decomposition, metric ?? "the metric")}${segPhrase}`
        : `Driver analysis needs a categorical dimension to decompose ${metricLabel} by. None qualified (2–50 levels) — no driver story was invented.`;
      break;
    case "segments":
      body = segmentTest
        ? `Segment read: “${segmentTest.segmentA}” averages ${fmt(segmentTest.meanA)} per row vs “${segmentTest.segmentB}” at ${fmt(segmentTest.meanB)} (${pct(segmentTest.diffPct)}), Welch t-test p = ${segmentTest.pValue.toFixed(4)} on n = ${segmentTest.nA}/${segmentTest.nB} → ${segmentTest.significant ? "the difference is real, act on it" : "the difference is within noise, do not act on it yet"}.`
        : "Segment analysis needs a categorical dimension with two usable groups (≥ 5 rows each). None qualified — no segment story was invented.";
      break;
    case "quality":
      body = worstMissing
        ? `Data quality: ${missingFacts.map((m) => `${m.col} (${m.rate.toFixed(1)}% missing)`).join(", ")}. Analyses depending on these columns exclude those rows silently.${outliers && outliers.outlierRows > 0 ? ` Additionally, ${outliers.outlierRows} outlier rows carry ${outliers.totalSharePct !== null ? `${outliers.totalSharePct.toFixed(0)}% of the ${metric} total` : "an outsized share"}.` : ""}`
        : `Data quality: the columns this analysis depends on (${dependentCols.join(", ") || "none required"}) show no missing-rate above 5% — a solid basis for the numbers in this answer.`;
      break;
    case "recommendation":
      body = `Recommendation: ${metric ? `anchor on ${metric}` : "first establish a usable numeric metric"}.${trend ? (trend.mannKendall.direction === "decreasing" && trend.mannKendall.p < 0.05 ? ` The verified decline (p = ${trend.mannKendall.p.toFixed(3)}) means stabilization beats growth spending until the leak is found.` : trend.mannKendall.direction === "increasing" && trend.mannKendall.p < 0.05 ? ` The verified uptrend (p = ${trend.mannKendall.p.toFixed(3)}) argues for defending the drivers behind it before new bets.` : ` With no significant trend (p = ${trend.mannKendall.p.toFixed(2)}), gains must come from mix shifts, not the base trajectory.`) : ""}${decomposition?.groups[0] ? ` Concentration in “${decomposition.groups[0].group}” (${decomposition.groups[0].sharePct.toFixed(1)}%) is the highest-leverage place to act.` : ""}`;
      break;
    default:
      body = `Overview: ${trendPhrase}${concPhrase}${segPhrase}${projPhrase}`;
  }

  // ---------------- 7. Recommendation + impact ----------------
  const recommendation = metric
    ? `Focus on ${metric}${dimension ? ` decomposed by ${dimension}` : ""}: ${
        trend?.projection
          ? `plan next period at ${fmt(trend.projection.nextPeriod)} ± ${fmt(trend.projection.mae)} (backtested),`
          : "establish a date column to enable projections,"
      } ${decomposition?.groups[0] ? `protect “${decomposition.groups[0].group}” (${decomposition.groups[0].sharePct.toFixed(1)}% of total),` : ""} and ${segmentTest?.significant ? "differentiate strategy across the statistically-validated segments" : "validate segment differences with more data before funding them"}.`
    : "Cast at least one column to Number and re-ask — every advisory number must come from your data.";

  const expectedImpact = trend?.projection
    ? `If the backtested one-step accuracy holds (${trend.projection.mape.toFixed(0)}% mean error), next period lands near ${fmt(trend.projection.nextPeriod)} ± ${fmt(trend.projection.mae)}. This is a measured historical error rate, not a guarantee.`
    : "Impact quantification needs a date column with ≥ 3 periods — add one and re-ask.";

  const nextActions: string[] = [];
  if (trend) {
    nextActions.push(
      `Open the ${metric} trend analysis on ${trend.dateCol} to verify the ${trend.mannKendall.direction} reading period by period.`,
    );
  }
  if (decomposition) {
    nextActions.push(
      `Run a variance analysis on ${metric} by ${decomposition.dimension} to see the full contribution table behind this answer.`,
    );
  }
  if (segmentTest) {
    nextActions.push(
      segmentTest.significant
        ? `Split targets/pricing for “${segmentTest.segmentA}” and “${segmentTest.segmentB}” — the gap is statistically real.`
        : `Collect more rows per segment before differentiating strategy (current gap is within noise).`,
    );
  }
  if (outliers && outliers.outlierRows > 0) {
    nextActions.push(
      `Review the ${outliers.outlierRows} outlier rows (beyond ${fmt(outliers.outlierThresholdHigh)}) and decide cap/keep policy before the next board cut.`,
    );
  }
  if (unavailable.length > 0) {
    nextActions.push(`Close these data gaps to unlock more advisor diagnostics: ${unavailable.join(" ")}`);
  }
  nextActions.push("Re-ask after the next data refresh — every number here recomputes from the new rows.");

  // ---------------- 8. Confidence flags ----------------
  flag("Executive answer", trend ? "calculated" : metric ? "inferred" : "inferred");
  flag("Evidence", "calculated");
  flag("Key drivers", keyDrivers.length > 0 && (decomposition || trend || segmentTest) ? "calculated" : "inferred");
  flag("Risks & opportunities", "inferred");
  flag("Options & recommendation", "recommendation");
  flag("Expected impact", trend?.projection ? "calculated" : "inferred");

  return {
    businessQuestion: input.question,
    executiveAnswer: body,
    evidence,
    keyDrivers,
    risks,
    opportunities,
    options,
    recommendation,
    expectedImpact,
    nextActions,
    confidenceFlags,
    used: {
      datasetName: input.datasetName,
      datasetId: input.datasetId,
      rowsUsed: input.rows.length,
      totalRows: input.totalRows,
      sampled: input.sampled,
    },
    methodologyNote:
      "Elite deterministic advisor: primary metric, dimension and date resolved from your columns; contribution decomposition, Mann–Kendall trend test, backtested rolling-origin projection, HHI concentration, Welch t-test between segments and 1.5×IQR outlier exposure are all computed from the uploaded rows. No external model, no invented numbers; sections that need missing data are listed as unavailable.",
    diagnostics: {
      metric: metricProfile
        ? {
            name: metricProfile.metric,
            total: metricProfile.total,
            mean: metricProfile.mean,
            median: metricProfile.median,
            stddev: metricProfile.stddev,
            nonEmpty: metricProfile.nonEmpty,
          }
        : { name: "", total: 0, mean: 0, median: 0, stddev: 0, nonEmpty: 0 },
      decomposition: decomposition
        ? {
            dimension: decomposition.dimension,
            dateCol: decomposition.dateCol,
            latestPeriodLabel: decomposition.latestPeriodLabel,
            prevPeriodLabel: decomposition.prevPeriodLabel,
            grandTotal: decomposition.grandTotal,
            groups: decomposition.groups.slice(0, 12).map((g) => ({
              group: g.group,
              total: g.total,
              sharePct: g.sharePct,
              rows: g.rows,
              meanPerRow: g.meanPerRow,
              latestChange: g.latestChange,
              latestChangePct: g.latestChangePct,
            })),
          }
        : null,
      trend: trend
        ? {
            dateCol: trend.dateCol,
            granularity: trend.granularity,
            nPeriods: trend.nPeriods,
            latest: trend.latest,
            previous: trend.previous,
            changePct: trend.changePct,
            mannKendallP: trend.mannKendall.p,
            mannKendallDirection: trend.mannKendall.direction,
            projection: trend.projection
              ? {
                  nextPeriod: trend.projection.nextPeriod,
                  method: trend.projection.method,
                  mae: trend.projection.mae,
                  mape: trend.projection.mape,
                  folds: trend.projection.folds,
                  reliable: trend.projection.reliable,
                }
              : null,
          }
        : null,
      concentration,
      segmentTest: segmentTest
        ? {
            segmentA: segmentTest.segmentA,
            segmentB: segmentTest.segmentB,
            meanA: segmentTest.meanA,
            meanB: segmentTest.meanB,
            diffPct: segmentTest.diffPct,
            pValue: segmentTest.pValue,
            significant: segmentTest.significant,
            nA: segmentTest.nA,
            nB: segmentTest.nB,
          }
        : null,
      outlierExposure: outliers
        ? {
            outlierRows: outliers.outlierRows,
            totalSharePct: outliers.totalSharePct,
            outlierThresholdHigh: outliers.outlierThresholdHigh,
          }
        : null,
      unavailable,
    },
  };
}

function moverSentence(
  decomposition: NonNullable<ReturnType<typeof decomposeByDimension>> & { dateCol: string | null },
  metricName: string,
): string {
  const mover = [...decomposition.groups]
    .filter((g) => g.latestChange !== null && Math.abs(g.latestChange ?? 0) > 0)
    .sort((a, b) => Math.abs(b.latestChange ?? 0) - Math.abs(a.latestChange ?? 0))[0];
  if (!mover)
    return ` No group moved in the latest period — the ${metricName} change came from many small contributions.`;
  return ` The single biggest mover last period was “${mover.group}” at ${mover.latestChange! >= 0 ? "+" : ""}${fmt(mover.latestChange ?? 0)} (${pct(mover.latestChangePct)}).`;
}

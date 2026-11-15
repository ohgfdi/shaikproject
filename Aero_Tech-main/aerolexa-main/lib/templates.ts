import { parseJson } from "@/lib/json";
import type {
  AnalysisResult,
  ChartSpec,
  DashboardWidget,
  DatasetProfile,
  InsightCard,
  PresentationSlide,
  ReportSection,
  ReportSectionSource,
  TableSpec,
} from "@/lib/types";

/** Build a provenance tag for a section, or null when the evidence is missing. */
function evidenceSource(kind: ReportSectionSource["kind"], label?: string, id?: string): ReportSectionSource {
  return { kind, ...(label ? { label } : {}), ...(id ? { id } : {}) };
}

const REPORT_HEADINGS = [
  "Executive Summary",
  "Business Context",
  "Data Overview",
  "Data Quality Notes",
  "Methodology",
  "Key Findings",
  "Drivers",
  "Risks",
  "Opportunities",
  "Recommendations",
  "Expected Impact",
  "Next Steps",
  "Appendix: Column Profile",
];

export const REPORT_SECTION_PRESETS: { heading: string; content: string }[] = REPORT_HEADINGS.map((heading) => ({
  heading,
  content: "",
}));

/**
 * Build default report sections from the project context.
 *
 * Every number and every claim is computed from the uploaded dataset's real
 * profile, the Insight Engine output, or the saved analyses. When evidence
 * does not exist for a section, the section says exactly that instead of
 * inventing content — a professional report never fabricates.
 */
export function buildReportTemplate(args: {
  dataset?: {
    id: string;
    name: string;
    rowCount: number;
    columnCount: number;
    columns: { name: string; type: string }[];
    profile?: DatasetProfile | null;
  } | null;
  insights: InsightCard[];
  analyses: { id: string; title: string; kind: string; result: AnalysisResult | null }[];
  userName: string;
  projectName: string;
}): ReportSection[] {
  const { dataset, insights } = args;
  const numericCols = (dataset?.columns ?? []).filter((c) => c.type === "number");
  const profile = dataset?.profile ?? null;
  const stats = profile?.stats ?? {};
  const fmt = (v: number | null | undefined, digits = 2): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return v.toLocaleString("en-US", { maximumFractionDigits: digits });
  };

  // ---- Executive summary: real headline numbers from the profile ----------
  const summaryLine = dataset
    ? `This report is based on “${dataset.name}”, which contains ${dataset.rowCount.toLocaleString()} rows across ${dataset.columnCount} columns${
        numericCols.length ? ` (numeric measures: ${numericCols.map((c) => c.name).join(", ")})` : ""
      }.`
    : "This report is based on data uploaded to the workspace. Add a dataset to populate it with real numbers.";
  const headlineStats: string[] = [];
  if (dataset && profile) {
    for (const col of numericCols.slice(0, 3)) {
      const s = stats[col.name];
      if (s?.sum !== undefined)
        headlineStats.push(
          `**${col.name}** totals ${fmt(s.sum)} across ${dataset.rowCount.toLocaleString()} rows (mean ${fmt(s.mean)}).`,
        );
    }
  }
  const topInsight = insights[0];

  const insightEvidence = insights
    .slice(0, 4)
    .map((i, idx) =>
      `${idx + 1}. **${i.title}** — ${i.observedChange ?? ""} ${
        Array.isArray(i.evidence) && i.evidence.length ? `Evidence: ${i.evidence.slice(0, 1).join(" ")}` : ""
      } ${i.recommendedNextStep ? `Recommended next step: ${i.recommendedNextStep}` : ""}`
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join("\n\n");

  // ---- Data quality: computed from the real profile ------------------------
  const qualityLines: string[] = [];
  if (profile) {
    if (profile.duplicateRows > 0) {
      qualityLines.push(
        `• ${profile.duplicateRows.toLocaleString()} exact duplicate row(s) were found within the analysed rows. Duplicates inflate totals and averages — deduplicate if they are not intentional.`,
      );
    }
    if (profile.sampled) {
      qualityLines.push(
        `• The file is large, so profiling inspected a labelled sample of ${profile.analyzedRows.toLocaleString()} of ${profile.rowCount.toLocaleString()} rows. Counts are exact for the sample; totals may differ from the full file.`,
      );
    }
    for (const col of dataset?.columns ?? []) {
      const s = stats[col.name];
      if (!s || !dataset) continue;
      const missingPct = dataset.rowCount > 0 ? (s.missing / dataset.rowCount) * 100 : 0;
      if (missingPct >= 20) {
        qualityLines.push(
          `• “${col.name}” is missing in ${fmt(missingPct, 1)}% of rows (${s.missing.toLocaleString()} cells) — analyses using it exclude those rows.`,
        );
      }
      if (s.nearConstant) {
        qualityLines.push(
          `• “${col.name}” is near-constant (≥99.5% of values identical) — it carries almost no analytical signal.`,
        );
      }
      if (s.outlierCount !== undefined && s.outlierCount > 0) {
        qualityLines.push(
          `• “${col.name}” has ${s.outlierCount.toLocaleString()} value(s) beyond the 1.5×IQR fence — check whether they are data errors or genuine extremes before relying on averages.`,
        );
      }
    }
    for (const w of profile.qualityWarnings.slice(0, 6)) qualityLines.push(`• ${w}`);
  }
  const qualityBody = qualityLines.length
    ? `The following issues were found by profiling the uploaded data. None are hidden:

${qualityLines.join("\n")}`
    : dataset
      ? "Profiling found no duplicates, no columns with ≥20% missing values, no near-constant columns and no IQR outliers — the dataset passed every automated quality check."
      : "Upload a dataset to run automated quality checks.";

  // ---- Column profile table: real statistics -------------------------------
  const profileTable =
    dataset && profile
      ? {
          title: `Column profile — ${dataset.name}`,
          columns: [
            { key: "col", label: "Column" },
            { key: "type", label: "Type" },
            { key: "missing", label: "Missing" },
            { key: "distinct", label: "Distinct" },
            { key: "mean", label: "Mean" },
            { key: "median", label: "Median" },
            { key: "min", label: "Min" },
            { key: "max", label: "Max" },
          ] as TableSpec["columns"],
          rows: (dataset.columns ?? []).slice(0, 30).map((col) => {
            const s = stats[col.name];
            return [
              col.name,
              col.type,
              s ? String(s.missing) : "—",
              s ? (s.distinct === -1 ? "10,000+" : String(s.distinct)) : "—",
              s?.mean !== undefined ? fmt(s.mean) : "—",
              s?.median !== undefined ? fmt(s.median) : "—",
              s?.min !== undefined ? fmt(s.min) : "—",
              s?.max !== undefined ? fmt(s.max) : "—",
            ] as (string | number | null)[];
          }),
        }
      : null;

  // ---- Risk & opportunity sections derived from real insight severities ----
  const risks = insights.filter((i) => i.severity === "critical" || i.severity === "warning");
  const opportunities = insights.filter((i) => i.severity === "info");
  const riskBody = risks.length
    ? risks
        .slice(0, 5)
        .map((i) =>
          `• **${i.title}** (${i.severity}) — ${i.observedChange ?? i.businessImplication ?? ""}`
            .replace(/\s+/g, " ")
            .trim(),
        )
        .join("\n")
    : insights.length
      ? "None of the generated insights are flagged as risks (no warning- or critical-severity findings)."
      : "No insights have been generated for this dataset yet — run the Insight Engine; this section fills with evidence-backed risks only.";
  const opportunityBody = opportunities.length
    ? opportunities
        .slice(0, 5)
        .map((i) => `• **${i.title}** — ${i.observedChange ?? i.businessImplication ?? ""}`.replace(/\s+/g, " ").trim())
        .join("\n")
    : insights.length
      ? "All generated findings are risk-flagged; no info-severity opportunities were detected."
      : "No insights yet — opportunities are derived from info-severity findings once the Insight Engine has run.";

  // ---- Drivers: real decomposition from saved variance analyses ------------
  const variance = args.analyses.find((a) => a.kind === "variance" && a.result?.tables?.[0]);
  const driverTable = variance?.result?.tables?.[0] ?? null;
  const driverBody = driverTable
    ? `Contribution of each ${driverTable.title.includes("vs") ? "group" : "dimension"} to the analysed metric, computed by the variance decomposition analysis. Percentages sum to 100%.`
    : "No variance decomposition has been run yet. Run a variance analysis on the dataset and this section embeds the real contribution table.";

  // ---- Expected impact: real forecast or honest absence --------------------
  const forecast = args.analyses.find((a) => a.kind === "forecast" && a.result?.charts[0]);
  const impactBody = forecast?.result
    ? `The projection below comes from the backtested forecast analysis “${forecast.title}” (${forecast.result.methodology?.method ?? "backtested model selection"}). Holdout accuracy and the confidence band are part of the analysis — this report does not present the projection as a promise.`
    : "No forecast has been run yet. The projection will be a backtested, holdout-validated estimate from the forecast analysis — never a guess.";

  const firstChartAnalysis = args.analyses.find((a) => a.result?.charts[0]) ?? null;
  const firstRecommendation = insights.find((i) => i.recommendedNextStep?.trim()) ?? null;

  // ---- Section provenance ------------------------------------------------
  // Every section cites the exact artifact it was computed from, or says it is
  // awaiting evidence. This is what prevents a report from ever inventing content.
  const src = {
    dataset: dataset ? evidenceSource("dataset", dataset.name, dataset.id) : null,
    profile: dataset && profile ? evidenceSource("profile", dataset.name, dataset.id) : null,
    topInsight: insights[0] ? evidenceSource("insight", insights[0].title, insights[0].id) : null,
    riskInsight: risks[0] ? evidenceSource("insight", risks[0].title, risks[0].id) : null,
    oppInsight: opportunities[0] ? evidenceSource("insight", opportunities[0].title, opportunities[0].id) : null,
    recInsight: firstRecommendation
      ? evidenceSource("insight", firstRecommendation.title, firstRecommendation.id)
      : null,
    insightEngine: insights.length ? evidenceSource("insight", "Insight Engine output") : null,
    variance: variance ? evidenceSource("analysis", variance.title, variance.id) : null,
    forecast: forecast ? evidenceSource("analysis", forecast.title, forecast.id) : null,
    keyChart: firstChartAnalysis ? evidenceSource("analysis", firstChartAnalysis.title, firstChartAnalysis.id) : null,
  };
  const awaiting = (label: string): ReportSection["source"] => ({ kind: "awaiting", label });
  const manual: ReportSection["source"] = { kind: "manual" };

  // ---- Next Steps strictly from evidence-backed recommendations -------------
  const nextStepsBody = firstRecommendation
    ? `${insights
        .filter((i) => i.recommendedNextStep?.trim())
        .slice(0, 5)
        .map((i, idx) => `${idx + 1}. ${i.recommendedNextStep!.replace(/\s+/g, " ").trim()}`)
        .join(
          "\n",
        )}\n\nEach action above is taken from the Insight Engine's evidence-backed recommendations. Validate against operational data before acting.`
    : "No evidence-backed next steps are available yet — run the Insight Engine on the dataset; this section lists only actions derived from your findings, never invented.";

  const sections: ReportSection[] = [];
  const mk = (
    heading: string,
    body: string,
    kind: ReportSection["kind"] = "text",
    source?: ReportSection["source"],
  ): ReportSection => ({
    id: `sec-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    heading,
    kind,
    content: body,
    source,
  });

  sections.push(
    mk(
      "Executive Summary",
      `${summaryLine}${headlineStats.length ? `\n\n${headlineStats.join(" ")}` : ""}${
        topInsight
          ? `\n\nHeadline finding: **${topInsight.title}** — ${topInsight.observedChange ?? ""} (confidence: ${topInsight.confidence}).`.replace(
              /\s+\(/g,
              " (",
            )
          : ""
      }`,
      "text",
      src.dataset ?? awaiting("Upload a dataset to compute the headline numbers"),
    ),
    mk(
      "Business Context",
      `Project: **${args.projectName}** · Prepared by ${args.userName} · ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.\n\nContext to add: the business question this analysis answers and the decisions it informs.`,
      "text",
      manual,
    ),
    mk(
      "Data Overview",
      dataset
        ? `${dataset.name} — ${dataset.rowCount.toLocaleString()} rows, ${dataset.columnCount} columns.${
            profile?.sampled
              ? ` Profile is based on a labelled sample of ${profile.analyzedRows.toLocaleString()} rows.`
              : ""
          }\n\nColumns:\n${(dataset.columns ?? [])
            .slice(0, 20)
            .map((c) => `- ${c.name} (${c.type})`)
            .join("\n")}`
        : "Upload a dataset to populate this section.",
      "text",
      src.dataset ?? awaiting("Upload a dataset to populate this section"),
    ),
    mk(
      "Data Quality Notes",
      qualityBody,
      "text",
      src.profile ?? awaiting("Upload a dataset to run automated quality checks"),
    ),
    mk(
      "Methodology",
      "All results in this report were computed from the uploaded dataset using transparent, deterministic logic. Every figure can be traced to exact columns, aggregations and filters via each analysis's methodology panel. Confidence labels distinguish calculated results from recommendations.",
      "text",
      manual,
    ),
    mk(
      "Key Findings",
      insightEvidence || "Run the Insight Engine on your dataset to surface evidence-backed findings.",
      firstChartAnalysis ? "chart" : "text",
      src.keyChart ?? src.topInsight ?? awaiting("Run the Insight Engine to surface evidence-backed findings"),
    ),
    mk(
      "Drivers",
      driverBody,
      driverTable ? "table" : "text",
      src.variance ?? awaiting("Run a variance analysis to reveal real contribution drivers"),
    ),
    mk(
      "Risks",
      riskBody,
      "text",
      src.riskInsight ??
        src.insightEngine ??
        awaiting("Run the Insight Engine; only evidence-backed risks are reported"),
    ),
    mk(
      "Opportunities",
      opportunityBody,
      "text",
      src.oppInsight ??
        src.insightEngine ??
        awaiting("Run the Insight Engine; only evidence-backed opportunities are reported"),
    ),
    mk(
      "Recommendations",
      insights.some((i) => i.recommendedNextStep)
        ? insights
            .filter((i) => i.recommendedNextStep)
            .slice(0, 5)
            .map((i) => `• ${i.recommendedNextStep} _(from "${i.title}")_`)
            .join("\n")
        : "No recommended next steps have been generated yet — recommendations here always come from the Insight Engine, never invented.",
      "text",
      src.recInsight ?? awaiting("Recommendations are derived from the Insight Engine, never invented"),
    ),
    mk(
      "Expected Impact",
      impactBody,
      forecast?.result?.charts[0] ? "chart" : "text",
      src.forecast ?? awaiting("Run a backtested forecast to project the headline metric"),
    ),
    mk(
      "Next Steps",
      nextStepsBody,
      "text",
      src.recInsight ?? awaiting("Next steps are derived from evidence-backed recommendations"),
    ),
    mk(
      "Appendix: Column Profile",
      "Full column statistics computed from the uploaded data — see the table below.",
      "table",
      src.profile ?? awaiting("Upload a dataset to compute column statistics"),
    ),
  );

  // Attach real content where it exists — never a textual stand-in.
  const keyFindingsIdx = sections.findIndex((s) => s.heading === "Key Findings");
  if (firstChartAnalysis && keyFindingsIdx >= 0) {
    const kf = sections[keyFindingsIdx];
    const firstChart = firstChartAnalysis.result?.charts[0];
    if (kf && firstChart) sections[keyFindingsIdx] = { ...kf, chart: firstChart, chartTitle: firstChart.title };
  }
  if (driverTable) {
    const idx = sections.findIndex((s) => s.heading === "Drivers");
    const drv = idx >= 0 ? sections[idx] : undefined;
    if (idx >= 0 && drv) sections[idx] = { ...drv, table: driverTable, kind: "table" };
  }
  if (profileTable) {
    const idx = sections.findIndex((s) => s.heading === "Appendix: Column Profile");
    const app = idx >= 0 ? sections[idx] : undefined;
    if (idx >= 0 && app) sections[idx] = { ...app, table: profileTable, kind: "table" };
  }
  if (forecast?.result?.charts[0]) {
    const idx = sections.findIndex((s) => s.heading === "Expected Impact");
    const imp = idx >= 0 ? sections[idx] : undefined;
    const fc = forecast.result.charts[0];
    if (idx >= 0 && imp && fc) sections[idx] = { ...imp, chart: fc, chartTitle: fc.title, kind: "chart" };
  }

  return sections;
}

const SLIDE_DEFAULTS: { title: string; layout: PresentationSlide["layout"]; bullets: string[] }[] = [
  {
    title: "Executive Summary",
    layout: "title",
    bullets: ["Headline performance of {dataset}", "Top insight in one sentence", "Recommended decision"],
  },
  {
    title: "Business Performance",
    layout: "bullets",
    bullets: ["Revenue & volume over time", "Latest period vs previous period", "What moved and why"],
  },
  {
    title: "Key Drivers",
    layout: "bullets",
    bullets: ["Metric vs metric relationships", "Strongest correlations from your data", "Drivers worth monitoring"],
  },
  {
    title: "Regional Analysis",
    layout: "split",
    bullets: ["Top regions by total", "Growth by region", "Concentration risks"],
  },
  {
    title: "Product Analysis",
    layout: "chart",
    bullets: ["Best & worst performers", "Mix shift over time", "Price / volume trade-offs"],
  },
  {
    title: "Risks & Opportunities",
    layout: "split",
    bullets: ["Top 3 risks from the insight engine", "Top 3 opportunities", "What to watch next period"],
  },
  {
    title: "Recommendations",
    layout: "bullets",
    bullets: ["Recommendation 1 — with expected impact", "Recommendation 2", "Recommendation 3"],
  },
  {
    title: "Expected Impact",
    layout: "chart",
    bullets: ["Forecast of the headline metric", "Range (95% band)", "Clear prototype-labelled projection"],
  },
  {
    title: "Next Steps",
    layout: "title",
    bullets: ["Immediate actions (this week)", "Validation tasks", "Owner & date for each action"],
  },
];

export function buildPresentationTemplate(args: {
  datasetName?: string;
  insights: InsightCard[];
  analyses: { id: string; title: string; result: AnalysisResult | null }[];
}): PresentationSlide[] {
  const name = args.datasetName ?? "the uploaded dataset";
  const insight = args.insights[0];
  const chart = args.analyses.find((a) => a.result?.charts[0])?.result?.charts[0] ?? null;
  const replace = (s: string) => s.replace(/\{dataset\}/g, name);
  const slides: PresentationSlide[] = SLIDE_DEFAULTS.map((s, i) => {
    let bullets = s.bullets.map(replace);
    if (i === 0 && insight) bullets = [bullets[0] ?? "", insight.title, bullets[2] ?? ""];
    return {
      id: `slide-${i + 1}`,
      title: s.title,
      layout: s.layout,
      bullets,
      chart: s.layout === "chart" && chart ? { ...chart } : undefined,
      insight: i === 1 && insight ? insight : undefined,
      notes: i === 0 ? `Speaker notes: keep to the top 3 numbers on this slide.` : "",
    };
  });
  void name;
  return slides;
}

/** Widget set for a freshly created dashboard. */
export function defaultDashboardWidgets(args: {
  dataset?: { id: string; name: string } | null;
  insights: InsightCard[];
  analyses: { id: string; title: string; result: AnalysisResult | null }[];
}): DashboardWidget[] {
  const widgets: DashboardWidget[] = [];
  const chartAnalysis = args.analyses.find((a) => a.result?.charts[0]);
  if (args.dataset && chartAnalysis?.result) {
    widgets.push({
      id: `w-chart-1`,
      type: "chart",
      title: chartAnalysis.title,
      datasetId: args.dataset.id,
      analysisId: chartAnalysis.id,
      chart: chartAnalysis.result.charts[0] as ChartSpec,
      sourceDatasetName: args.dataset.name,
      kpiKind: "sum",
      w: 6,
      h: 4,
    });
  }
  if (args.insights[0]) {
    widgets.push({
      id: "w-insight-1",
      type: "insight",
      title: args.insights[0].title,
      insight: args.insights[0],
      kpiKind: "sum",
      w: 6,
      h: 4,
    });
  }
  if (widgets.length === 0) {
    widgets.push({
      id: "w-text-1",
      type: "text",
      title: "Getting started",
      content:
        "Add KPIs, charts from your analyses, insight cards and notes. Every widget stores a live snapshot computed from your dataset.",
      kpiKind: "sum",
      w: 12,
      h: 2,
    });
  }
  return widgets;
}

export function insightFromJson(insight: unknown): InsightCard | null {
  const parsed = parseJson<InsightCard | null>(JSON.stringify(insight ?? ""), null);
  return parsed && typeof parsed === "object" && "title" in parsed ? parsed : null;
}

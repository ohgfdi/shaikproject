/**
 * Report module tests — honesty and professionalism guarantees.
 *
 * Every assertion verifies a fact about the produced artifact:
 *  - buildReportTemplate only states numbers that exist in the dataset profile
 *  - sections without evidence say so explicitly instead of inventing content
 *  - risks/opportunities derive strictly from insight severities
 *  - the export HTML contains the computed statistics and honest labels,
 *    and never claims PDF generation that does not happen
 */
import { htmlForText, inlineMarkdown } from "@/lib/export/html";
import { renderReportDocument } from "@/lib/export/report-doc";
import { buildReportTemplate, REPORT_SECTION_PRESETS } from "@/lib/templates";
import type { AnalysisResult, DatasetProfile, InsightCard, ReportSection } from "@/lib/types";

const profile: DatasetProfile = {
  analyzedRows: 120,
  sampled: false,
  rowCount: 120,
  columnCount: 4,
  columns: [
    { name: "region", type: "string" },
    { name: "month", type: "date" },
    { name: "orders", type: "number" },
    { name: "revenue", type: "number" },
  ],
  stats: {
    region: { name: "region", type: "string", missing: 0, distinct: 4, nearConstant: false },
    month: { name: "month", type: "date", missing: 0, distinct: 12, nearConstant: false },
    orders: {
      name: "orders",
      type: "number",
      missing: 4,
      distinct: 40,
      nearConstant: false,
      min: 5,
      max: 88,
      sum: 2400,
      mean: 20,
      median: 19,
      outlierCount: 3,
    },
    revenue: {
      name: "revenue",
      type: "number",
      missing: 0,
      distinct: 100,
      nearConstant: false,
      min: 500,
      max: 9000,
      sum: 120000,
      mean: 1000,
      median: 950,
    },
  },
  duplicateRows: 6,
  qualityWarnings: ["Column “region” has 4 distinct values."],
};

const insights: InsightCard[] = [
  {
    id: "i1",
    title: "East region drives 62% of revenue",
    severity: "info",
    observedChange: "East's revenue share rose from 54% to 62% over the last 3 months.",
    evidence: ["East revenue 74,400 of 120,000 total (62.0%)."],
    recommendedNextStep: "Review East pricing before the next quarter.",
    confidence: "calculated",
  },
  {
    id: "i2",
    title: "Revenue concentrated in 2 of 4 regions",
    severity: "warning",
    observedChange: "Top-2 regions hold 81% of total revenue.",
    evidence: ["HHI = 3,450 (highly concentrated)."],
    confidence: "calculated",
  },
];

const analysis = (
  kind: string,
  over: Partial<AnalysisResult>,
): { id: string; title: string; kind: string; result: AnalysisResult | null } => ({
  id: `a-${kind}`,
  title: `${kind} analysis`,
  kind,
  result: {
    kind: kind as AnalysisResult["kind"],
    title: `${kind} analysis`,
    dataset: { name: "sales", id: "d1", rowCount: 120, columns: ["region", "month", "orders", "revenue"] },
    scope: { rowsUsed: 120, rowsScanned: 120, filters: [], note: "All rows used." },
    configHuman: [],
    methodology: { method: "test", steps: [], assumptions: [] },
    qualityWarnings: [],
    charts: [],
    tables: [],
    ...over,
  } as AnalysisResult,
});

function dataset(over: Partial<NonNullable<Parameters<typeof buildReportTemplate>[0]["dataset"]>> = {}) {
  return {
    id: "d1",
    name: "sales.csv",
    rowCount: 120,
    columnCount: 4,
    columns: profile.columns.map((c) => ({ name: c.name, type: c.type as string })),
    profile,
    ...over,
  };
}

describe("buildReportTemplate — every number is real", () => {
  const sections = buildReportTemplate({
    dataset: dataset(),
    insights,
    analyses: [],
    userName: "Ada",
    projectName: "Northwind",
  });

  it("produces the standard professional structure", () => {
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual([
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
    ]);
  });

  it("states only the real headline totals from the profile", () => {
    const summary = sections[0]!.content;
    expect(summary).toContain("120 rows");
    expect(summary).toContain("4 columns");
    // Real sums from the profile — never invented.
    expect(summary).toContain("2,400"); // orders.sum
    expect(summary).toContain("120,000"); // revenue.sum
    expect(summary).not.toContain("1,000,000");
  });

  it("discloses the exact computed data-quality issues", () => {
    const quality = sections.find((s) => s.heading === "Data Quality Notes")!;
    expect(quality.content).toContain("6 exact duplicate row(s)");
    expect(quality.content).toContain("1.5×IQR"); // orders outlierCount = 3
    // revenue has 0 missing → no false missing claim
    expect(quality.content).not.toContain("“revenue” is missing");
  });

  it("derives risks and opportunities strictly from insight severities", () => {
    const risks = sections.find((s) => s.heading === "Risks")!;
    const opps = sections.find((s) => s.heading === "Opportunities")!;
    expect(risks.content).toContain("Revenue concentrated in 2 of 4 regions");
    expect(risks.content).toContain("warning");
    expect(opps.content).toContain("East region drives 62% of revenue");
    expect(opps.content).not.toContain("Revenue concentrated");
  });

  it("prefers a real variance table for Drivers and a real forecast chart for Expected Impact", () => {
    const withAnalysis = buildReportTemplate({
      dataset: dataset(),
      insights: [],
      analyses: [
        analysis("variance", {
          tables: [
            {
              title: "Revenue by region — contribution",
              columns: [
                { key: "r", label: "Region" },
                { key: "c", label: "Contribution" },
              ],
              rows: [
                ["East", 62],
                ["West", 38],
              ],
            },
          ],
        }),
        analysis("forecast", {
          charts: [
            {
              kind: "line",
              title: "Revenue projection (backtested)",
              categories: ["Q1", "Q2"],
              series: [{ name: "forecast", data: [100, 110], color: "#5AA8AA" }],
            },
          ],
          methodology: { method: "Backtested selection", steps: [], assumptions: [] },
        }),
      ],
      userName: "Ada",
      projectName: "Northwind",
    });
    const drivers = withAnalysis.find((s) => s.heading === "Drivers")!;
    expect(drivers.kind).toBe("table");
    expect(drivers.table?.rows).toHaveLength(2);

    const impact = withAnalysis.find((s) => s.heading === "Expected Impact")!;
    expect(impact.kind).toBe("chart");
    expect(impact.chart?.title).toBe("Revenue projection (backtested)");
    expect(impact.content).toContain("backtested");
  });

  it("never invents content when evidence is absent — it says what is missing", () => {
    const empty = buildReportTemplate({ dataset: null, insights: [], analyses: [], userName: "Ada", projectName: "N" });
    const quality = empty.find((s) => s.heading === "Data Quality Notes")!;
    expect(quality.content).toMatch(/Upload a dataset/i);
    const risks = empty.find((s) => s.heading === "Risks")!;
    expect(risks.content).toMatch(/No insights have been generated/i);
    const drivers = empty.find((s) => s.heading === "Drivers")!;
    expect(drivers.content).toMatch(/No variance decomposition/i);
    const impact = empty.find((s) => s.heading === "Expected Impact")!;
    expect(impact.content).toMatch(/No forecast has been run/i);
    // No fake appendix chart references.
    const appendix = empty.find((s) => s.heading === "Appendix: Column Profile")!;
    expect(appendix.content).not.toMatch(/Chart \d+:/);
  });

  it("offers the standard section list for manual addition", () => {
    expect(REPORT_SECTION_PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(REPORT_SECTION_PRESETS.map((p) => p.heading)).toContain("Executive Summary");
  });

  it("tags every section with the artifact it was computed from", () => {
    const summary = sections.find((s) => s.heading === "Executive Summary")!;
    expect(summary.source).toMatchObject({ kind: "dataset", label: "sales.csv" });
    const findings = sections.find((s) => s.heading === "Key Findings")!;
    expect(findings.source).toMatchObject({ kind: "insight", label: "East region drives 62% of revenue" });
    const risks = sections.find((s) => s.heading === "Risks")!;
    expect(risks.source).toMatchObject({ kind: "insight", label: "Revenue concentrated in 2 of 4 regions" });
    const opps = sections.find((s) => s.heading === "Opportunities")!;
    expect(opps.source).toMatchObject({ kind: "insight", label: "East region drives 62% of revenue" });
    const appendix = sections.find((s) => s.heading === "Appendix: Column Profile")!;
    expect(appendix.source).toMatchObject({ kind: "profile" });
  });

  it("marks sections awaiting evidence instead of fabricating them", () => {
    // No variance analysis or forecast exists in the fixture → those sections say so.
    const drivers = sections.find((s) => s.heading === "Drivers")!;
    const impact = sections.find((s) => s.heading === "Expected Impact")!;
    expect(drivers.source).toMatchObject({ kind: "awaiting" });
    expect(impact.source).toMatchObject({ kind: "awaiting" });
    expect(drivers.content).toMatch(/No variance decomposition/i);
    expect(impact.content).toMatch(/No forecast has been run/i);
  });

  it("derives Next Steps strictly from evidence-backed recommendations", () => {
    const next = sections.find((s) => s.heading === "Next Steps")!;
    expect(next.content).toContain("Review East pricing before the next quarter.");
    expect(next.content).not.toMatch(/Schedule a data refresh/);
    expect(next.source).toMatchObject({ kind: "insight" });
    // When no recommendation exists, it says exactly that instead of inventing steps.
    const bare = buildReportTemplate({
      dataset: dataset(),
      insights: [],
      analyses: [],
      userName: "Ada",
      projectName: "N",
    });
    const bareNext = bare.find((s) => s.heading === "Next Steps")!;
    expect(bareNext.content).toMatch(/No evidence-backed next steps/i);
    expect(bareNext.source).toMatchObject({ kind: "awaiting" });
  });

  it("records the analysis provenance on embedded tables and charts", () => {
    const withAnalysis = buildReportTemplate({
      dataset: dataset(),
      insights: [],
      analyses: [
        analysis("variance", {
          tables: [
            {
              title: "Revenue by region — contribution",
              columns: [
                { key: "r", label: "Region" },
                { key: "c", label: "Contribution" },
              ],
              rows: [
                ["East", 62],
                ["West", 38],
              ],
            },
          ],
        }),
        analysis("forecast", {
          charts: [
            {
              kind: "line",
              title: "Revenue projection (backtested)",
              categories: ["Q1", "Q2"],
              series: [{ name: "forecast", data: [100, 110], color: "#5AA8AA" }],
            },
          ],
          methodology: { method: "Backtested selection", steps: [], assumptions: [] },
        }),
      ],
      userName: "Ada",
      projectName: "Northwind",
    });
    const drivers = withAnalysis.find((s) => s.heading === "Drivers")!;
    expect(drivers.source).toMatchObject({ kind: "analysis", label: "variance analysis" });
    const impact = withAnalysis.find((s) => s.heading === "Expected Impact")!;
    expect(impact.source).toMatchObject({ kind: "analysis", label: "forecast analysis" });
  });

  it("keeps every section honest when there is no dataset at all", () => {
    const empty = buildReportTemplate({ dataset: null, insights: [], analyses: [], userName: "Ada", projectName: "N" });
    const dataSections = empty.filter((s) => !["Business Context", "Methodology"].includes(s.heading));
    expect(dataSections.length).toBeGreaterThan(0);
    for (const s of dataSections) expect(s.source?.kind).toBe("awaiting");
  });
});

describe("renderReportDocument — professional, honest export", () => {
  const sections: ReportSection[] = buildReportTemplate({
    dataset: dataset(),
    insights,
    analyses: [],
    userName: "Ada Lovelace",
    projectName: "Northwind",
  });

  const html = renderReportDocument(sections, {
    title: "Q2 Board Summary",
    projectName: "Northwind",
    authorName: "Ada Lovelace",
    version: 3,
    generatedAt: new Date("2026-09-14T12:00:00Z"),
    datasetName: "sales.csv",
    datasetRowCount: 120,
    datasetColumnCount: 4,
    productionNote: "Exported from the Ledgerly workspace (manual export)",
  });

  it("renders provenance metadata with real values", () => {
    expect(html).toContain("Q2 Board Summary");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("v3");
    expect(html).toContain("sales.csv");
    expect(html).toContain("120"); // rows analysed
  });

  it("includes a table of contents linking every section", () => {
    expect(html).toContain('aria-label="Table of contents"');
    for (const s of sections) expect(html).toContain(escapeHtml(s.heading));
  });

  it("renders the computed column profile table", () => {
    expect(html).toContain("Column profile — sales.csv");
    expect(html).toContain("2,400"); // orders mean/sum values flow through
  });

  it("labels the export honestly — no fake PDF or prototype claims", () => {
    expect(html).toContain("Print / Save as PDF"); // the real print path
    expect(html).not.toMatch(/Generated by Ledgerly \(prototype\)/i);
    expect(html).not.toMatch(/prototype export/i);
  });

  it("adds a Sources & verification block that maps every figure to an artifact", () => {
    expect(html).toContain("Sources &amp; verification");
    expect(html).toContain("does not project, extrapolate or invent");
    expect(html).toContain("sales.csv");
    // Per-section provenance tags appear next to the section headings.
    expect(html).toContain("Dataset: sales.csv");
  });

  it("announces awaiting-evidence sections in the export instead of hiding them", () => {
    const emptySections: ReportSection[] = buildReportTemplate({
      dataset: null,
      insights: [],
      analyses: [],
      userName: "Ada",
      projectName: "N",
    });
    const emptyHtml = renderReportDocument(emptySections, {
      title: "Draft",
      projectName: "N",
      authorName: "Ada",
      version: 1,
      generatedAt: new Date("2026-09-14T12:00:00Z"),
      datasetName: null,
      productionNote: "Exported from the Ledgerly workspace (manual export)",
    });
    expect(emptyHtml).toMatch(/awaiting evidence/i);
    expect(emptyHtml).not.toMatch(/[0-9]+% growth projected/i);
  });
});

describe("report body markup — safe, honest formatting", () => {
  it("never executes raw HTML and formats bold/italic/code", () => {
    expect(inlineMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(inlineMarkdown("**bold** and *italic*")).toContain("<strong>bold</strong>");
    expect(inlineMarkdown("**bold** and *italic*")).toContain("<em>italic</em>");
    expect(inlineMarkdown("run `code`")).toMatch(/<code[^>]*>code<\/code>/);
  });

  it("renders bullet lists from the template's dash-prefixed lines", () => {
    const htmlBody = htmlForText("- East 74,400 of 120,000 (62%)\n- West 28,800 (24%)\n\nNext paragraph.");
    expect(htmlBody).toMatch(/<ul[^>]*>/);
    expect(htmlBody).toMatch(/<li[^>]*>East 74,400 of 120,000 \(62%\)<\/li>/);
    expect(htmlBody).toContain("Next paragraph.");
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

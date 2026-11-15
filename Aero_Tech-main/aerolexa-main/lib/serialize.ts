import type { Analysis, Dashboard, Dataset, Insight, Presentation, Report } from "@/generated/prisma/browser";
import { parseJson, parseJsonArray } from "@/lib/json";
import type {
  AnalysisResult,
  ChartSpec,
  ColumnDef,
  DashboardWidget,
  InsightCard,
  PresentationSlide,
  ReportBookmark,
  ReportPage,
  ReportSection,
  ReportTheme,
} from "@/lib/types";

export function datasetColumns(dataset: Pick<Dataset, "columns">): ColumnDef[] {
  return parseJsonArray<ColumnDef>(dataset.columns, []);
}

export function insightCard(insight: Insight): InsightCard {
  const severity = insight.severity === "critical" || insight.severity === "warning" ? insight.severity : "info";
  const confidence =
    insight.confidence === "calculated" || insight.confidence === "inferred" || insight.confidence === "recommendation"
      ? insight.confidence
      : "calculated";
  return {
    id: insight.id,
    title: insight.title,
    severity,
    metric: insight.metric ?? undefined,
    observedChange: insight.observedChange ?? undefined,
    evidence: parseJsonArray<string>(insight.evidence, []),
    possibleCause: insight.possibleCause ?? undefined,
    businessImplication: insight.businessImplication ?? undefined,
    recommendedNextStep: insight.recommendedNextStep ?? undefined,
    confidence,
    createdAt: insight.createdAt.toISOString(),
  };
}

export function analysisResult(analysis: Pick<Analysis, "result">): AnalysisResult | null {
  return parseJson<AnalysisResult | null>(analysis.result, null);
}

export function dashboardWidgets(dashboard: Pick<Dashboard, "widgets">): DashboardWidget[] {
  return parseJsonArray<DashboardWidget>(dashboard.widgets, []);
}

export function dashboardPages(dashboard: { title: string; widgets: string; pages?: string | null }): ReportPage[] {
  const pages = parseJsonArray<ReportPage>(dashboard.pages ?? "", []);
  if (pages.length > 0) return pages;
  // Legacy dashboard: the widgets array IS page 1.
  return [{ id: "page-1", name: dashboard.title || "Page 1", widgets: dashboardWidgets(dashboard) }];
}

export function dashboardBookmarks(dashboard: { bookmarks?: string | null }): ReportBookmark[] {
  return parseJsonArray<ReportBookmark>(dashboard.bookmarks ?? "", []);
}

export function dashboardTheme(dashboard: { theme?: string | null }): ReportTheme | null {
  return parseJson<ReportTheme | null>(dashboard.theme, null);
}

export function reportSections(report: Pick<Report, "sections">): ReportSection[] {
  return parseJsonArray<ReportSection>(report.sections, []);
}

export function presentationSlides(presentation: Pick<Presentation, "slides">): PresentationSlide[] {
  return parseJsonArray<PresentationSlide>(presentation.slides, []);
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  company: string | null;
  industry: string | null;
  status: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  counts: {
    datasets: number;
    analyses: number;
    insights: number;
    dashboards: number;
    reports: number;
    presentations: number;
    activity: number;
  };
  latestDataset?: { id: string; name: string; rowCount: number } | null;
  latestInsight?: InsightCard | null;
}

export function chartFromSpec(spec: ChartSpec): ChartSpec {
  return spec;
}

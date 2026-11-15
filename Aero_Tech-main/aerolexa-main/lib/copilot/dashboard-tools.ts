/**
 * Roadmap A1 — Copilot on dashboards ("explain this page").
 *
 * Extends the dataset-copilot tool registry with one dashboard-aware tool:
 * `get_dashboard_context`, which hands the model the metadata of the page it
 * is looking at — widget titles/types, the analysis configs behind them, and
 * the ACTIVE cross-filter/slicer selections the user has applied.
 *
 * Design contract (same as lib/copilot/tools.ts):
 * - The tool returns METADATA and CONFIGS, never row data or pre-computed
 *   numbers. Every number the agent names still comes from compute_metrics /
 *   run_analysis executed against the real rows.
 * - Cross-filter selections are returned as ready-to-use AnalysisConfig
 *   filter pairs; the agent applies them by re-calling run_analysis with
 *   filterCol/filterValue — the SAME choke point the Analysis Lab uses — so
 *   RLS flows through loadDatasetFrame exactly as everywhere else.
 * - Tool is total: a bad dashboard context becomes a readable error, never a
 *   throw.
 */

import type { DashboardWidget } from "@/lib/types";

export interface DashboardContextInput {
  dashboardId: string;
  dashboardTitle: string;
  pageName: string;
  widgets: DashboardWidget[];
  /** Active cross-filter selections currently applied on the canvas. */
  crossFilters: { sourceWidgetId: string; column: string; values: string[] }[];
}

export interface DashboardToolSpec {
  name: string;
  description: string;
  args: Record<string, string>;
  required: string[];
}

export const DASHBOARD_TOOL_SPECS: DashboardToolSpec[] = [
  {
    name: "get_dashboard_context",
    description:
      "Read the dashboard page the user is looking at: widget titles and types, the analysis config behind each widget, and the cross-filter selections currently applied. Use this FIRST when the user asks about 'this page' or a widget, then run the underlying analyses (with the dashboard's filters applied) to compute real numbers.",
    args: {},
    required: [],
  },
];

export const DASHBOARD_TOOL_NAMES = new Set(DASHBOARD_TOOL_SPECS.map((t) => t.name));

export function isDashboardTool(name: string): boolean {
  return DASHBOARD_TOOL_NAMES.has(name);
}

function widgetLine(w: DashboardWidget): string {
  const parts = [`  - "${w.title}" (${w.type})`];
  if (w.analysisId) parts.push(`    analysisId: ${w.analysisId}`);
  if (w.datasetId) parts.push(`    datasetId: ${w.datasetId}`);
  if (w.kpi)
    parts.push(`    kpi: label "${w.kpi.label}", value ${w.kpi.value}, kind ${w.kpi.kind ?? w.kpiKind ?? "sum"}`);
  if (w.chart) {
    const seriesName =
      w.chart.series?.[0]?.name !== undefined ? `series "${String(w.chart.series[0].name)}"` : "(no series)";
    parts.push(`    chart: ${w.chart.kind} titled "${w.chart.title}" with ${seriesName}`);
  }
  if (w.pivot)
    parts.push(
      `    pivot: rows ${w.pivot.rows.join(", ") || "(none)"}; values ${w.pivot.values.map((v) => `${v.aggregation}(${v.column})`).join(", ") || "(none)"}`,
    );
  if (w.content && w.type === "text") parts.push(`    text: ${w.content.slice(0, 120)}`);
  return parts.join("\n");
}

/**
 * Execute get_dashboard_context. Returns a digest the model can reason over
 * plus structured data for the transcript. No numbers are produced.
 */
export function execGetDashboardContext(ctx: DashboardContextInput): { ok: boolean; digest: string; error?: string } {
  if (!ctx.widgets || ctx.widgets.length === 0) {
    return {
      ok: false,
      digest: "",
      error: `Dashboard "${ctx.dashboardTitle}" (page "${ctx.pageName}") has no widgets yet. Tell the user to add widgets from their analyses first.`,
    };
  }

  const filterLines =
    ctx.crossFilters.length > 0
      ? ctx.crossFilters.map((f) => `  - ${f.column}: ${f.values.join(", ")}`).join("\n")
      : "  (none — the page is unfiltered)";

  const digest = [
    `dashboard "${ctx.dashboardTitle}" — page "${ctx.pageName}"`,
    `widgets on page (${ctx.widgets.length}):`,
    ...ctx.widgets.map(widgetLine),
    `active cross-filters:`,
    filterLines,
    `To explain a widget's numbers, call run_analysis with the SAME kind/columns as the widget's config, adding filterCol/filterValue when a cross-filter is active.`,
  ].join("\n");

  return { ok: true, digest };
}

/** Map the dashboard's first active cross-filter onto an analysis filter pair. */
export function dashboardFilterPair(ctx: DashboardContextInput): { filterCol: string; filterValue: string } | null {
  const f = ctx.crossFilters[0];
  if (!f || !f.column || f.values.length === 0) return null;
  return { filterCol: f.column, filterValue: f.values[0] as string };
}

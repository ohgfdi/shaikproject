import { SemanticLayerManager } from "@/lib/analytics/semantic-layer";
import { ApiError, requireAuth } from "@/lib/auth/guard";

/**
 * tenancy-audit: global-operator — dashboard copilot API provides
 * workspace-wide dashboard insights via the data copilot. This is a deployment-wide
 * aggregate rather than a per-tenant query.
 */
import { runCopilotAgent } from "@/lib/copilot/agent";
import { dashboardFilterPair, type DashboardContextInput } from "@/lib/copilot/dashboard-tools";
import { buildExplanation, detectSmallTalk, matchMetrics, schemaContext, suggestActions } from "@/lib/copilot/engine";
import type { CopilotAction, CopilotAgentInfo, CopilotAnswer, CopilotMode } from "@/lib/copilot/engine";
import type { AgentContext } from "@/lib/copilot/tools";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { parseJson, parseJsonArray, stringifyJson } from "@/lib/json";
import { getAvailableLLMProvider } from "@/lib/llm/providers";
import { datasetColumns, dashboardPages, dashboardWidgets } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";
import type { AnalysisConfig, DashboardWidget } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/dashboards/[id]/copilot  (Roadmap A1 — "explain this page")
 *
 * The dataset copilot, bound to a DASHBOARD context: the agent receives the
 * visible widgets' metadata plus the page's ACTIVE cross-filter/slicer state
 * via a `get_dashboard_context` tool, then computes every number it names
 * with the SAME governed engines as everywhere else (semantic-layer metrics +
 * runAnalysis over the real rows). A viewer's copilot answers respect
 * row-level security because they flow through loadDatasetFrame +
 * applyRowSecurity — the same choke points as every other route.
 *
 * Body: { request: string, pageId?: string, crossFilters?: { column, values }[] }
 *
 * The client sends the LIVE cross-filter state (what is selected on the
 * canvas right now); the route verifies it against the dashboard's widgets
 * and applies it as an AnalysisConfig filter for every run_analysis call.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "copilot", RATE_LIMITS.copilot);

    const dashboard = await withTenantDb(ctx, (db) =>
    db.dashboard.findUnique({ where: { id: params.id } }),
  );
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id)
      throw new ApiError(404, "NOT_FOUND", "Dashboard not found.");
    await requireRowRole(ctx, dashboard, "VIEWER");

    const body = await readJsonBody<{ request?: unknown; pageId?: unknown; crossFilters?: unknown }>(request);
    const userRequest = typeof body.request === "string" ? body.request.trim().slice(0, 500) : "";
    if (!userRequest) {
      throw new ApiError(
        400,
        "VALIDATION",
        "Describe what you want to know about this dashboard, e.g. “why is Q3 flat?”",
      );
    }

    // --- Dashboard context: pages fall back to the legacy widgets column ----
    const storedWidgets = dashboardWidgets(dashboard);
    const pages = dashboardPages(dashboard);
    const pageId = typeof body.pageId === "string" ? body.pageId : null;
    const page = pageId ? pages.find((p) => p.id === pageId) : pages[0];
    const widgets: DashboardWidget[] = page?.widgets ?? storedWidgets;

    // --- Cross-filter state from the live canvas (validated) ----------------
    const rawFilters = Array.isArray(body.crossFilters) ? body.crossFilters : [];
    const crossFilters = rawFilters
      .map((f) => {
        const rec = f as { column?: unknown; values?: unknown } | null;
        if (typeof rec?.column !== "string" || !Array.isArray(rec.values)) return null;
        const values = rec.values.filter((v): v is string => typeof v === "string").slice(0, 20);
        return values.length > 0 ? { sourceWidgetId: "(live)", column: rec.column.slice(0, 120), values } : null;
      })
      .filter((f): f is { sourceWidgetId: string; column: string; values: string[] } => f !== null)
      .slice(0, 5);

    // A filter column must appear on at least one widget of the page — the
    // copilot cannot be tricked into filtering on arbitrary columns.
    const knownColumns = new Set<string>();
    for (const w of widgets) {
      if (w.pivot) for (const r of w.pivot.rows) knownColumns.add(r);
      if (w.chart?.categories) for (const c of w.chart.categories.slice(0, 50)) knownColumns.add(String(c));
    }
    const safeFilters = crossFilters.filter((f) => knownColumns.size === 0 || knownColumns.has(f.column));

    const dashCtx: DashboardContextInput = {
      dashboardId: dashboard.id,
      dashboardTitle: dashboard.title,
      pageName: page?.name ?? dashboard.title,
      widgets,
      crossFilters: safeFilters,
    };

    // --- Resolve ONE dataset to ground computations on ----------------------
    // Widgets hold snapshots of analyses; the analysis rows carry datasetId.
    const analysisIds = [...new Set(widgets.map((w) => w.analysisId).filter((v): v is string => Boolean(v)))].slice(
      0,
      20,
    );const datasetId =
      analyses[0]?.datasetId ??
      widgets.find((w) => w.datasetId)?.datasetId ??
      widgets.find((w) => w.pivot?.datasetId)?.pivot?.datasetId ??
      null;
    if (!datasetId) {
      throw new ApiError(
        400,
        "DATA_MISSING",
        "No dataset is attached to this dashboard yet. What happened: none of the page's widgets reference a dataset-backed analysis. How to fix: add a chart, KPI or table widget from an analysis first.",
      );
    }
    const dataset = await withTenantDb(ctx, (db) =>
      prisma.dataset.findUnique({ where: { id: datasetId } }),
  );
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "The dashboard's dataset no longer exists.");
    await requireRowRole(ctx, dataset, "VIEWER");
    const columns = datasetColumns(dataset);

    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS: the copilot reasons over exactly the rows this user may see.
    const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
    const visibleRows = rls.rows;
    const layer = new SemanticLayerManager(dataset.id);
    await layer.initialize({ rows: visibleRows, totalRows: loaded.totalRows, columns });
    const metricValues = await layer.computeMetrics();
    const analyzedRows = layer.getAnalyzedRowCount();
    if (analyzedRows === 0) {
      throw new ApiError(
        400,
        "DATA_MISSING",
        "This dashboard's dataset has no rows available to analyse. Re-upload the dataset file.",
      );
    }

    const sctx = schemaContext(columns);
    const smallTalk = detectSmallTalk(userRequest);

    // Apply the dashboard's active cross-filter to every suggested analysis
    // so the copilot explains the page AS FILTERED, matching what is on screen.
    const filterPair = dashboardFilterPair(dashCtx);
    const withDashFilter = (cfg: AnalysisConfig | null): AnalysisConfig | null =>
      cfg && filterPair && !cfg.filterCol
        ? { ...cfg, filterCol: filterPair.filterCol, filterValue: filterPair.filterValue }
        : cfg;

    const detMatched = smallTalk ? [] : matchMetrics(userRequest, metricValues);
    const detActions = (smallTalk ? [] : suggestActions(userRequest, sctx)).map((a) => ({
      ...a,
      config: withDashFilter(a.config),
    }));
    const detExplanation = buildExplanation(userRequest, detMatched, detActions, sctx, {
      analyzedRows,
      totalRows: layer.getTotalRowCount(),
    });

    let mode: CopilotMode = "deterministic";
    let explanation = smallTalk ?? detExplanation;
    let matchedMetrics = detMatched;
    let suggestedActions: CopilotAction[] = detActions;
    let agentInfo: CopilotAgentInfo | undefined;

    const provider = await getAvailableLLMProvider();
    if (provider) {
      const agentCtx: AgentContext = {
        datasetId: dataset.id,
        datasetName: dataset.name,
        columns,
        rows: visibleRows,
        totalRows: loaded.totalRows,
        datasetWarnings: parseJsonArray<string>(dataset.qualityWarnings, []),
        metricValues,
        dashboard: {
          title: dashCtx.dashboardTitle,
          pageName: dashCtx.pageName,
          widgets: widgets.map((w) => ({ title: w.title, type: w.type, analysisId: w.analysisId ?? null })),
          crossFilters: safeFilters.map((f) => ({ column: f.column, values: f.values })),
        },
        analyses: analyses.map((a) => ({
          id: a.id,
          kind: a.kind,
          config: parseJson<AnalysisConfig>(a.config, { kind: "eda" } as AnalysisConfig),
        })),
      };
      const agent = await runCopilotAgent(provider, agentCtx, userRequest, { dashboardContext: dashCtx });
      if (agent) {
        mode = "agent";
        agentInfo = {
          provider: agent.provider,
          model: agent.model,
          latencyMs: agent.latencyMs,
          steps: agent.steps,
          summaryWithheld: agent.summaryWithheld,
          withheldReason: agent.withheldReason,
        };
        if (agent.summary) explanation = agent.summary;
        if (agent.matchedMetrics.length > 0) matchedMetrics = agent.matchedMetrics;
        if (agent.suggestedActions.length > 0)
          suggestedActions = agent.suggestedActions.map((a) => ({ ...a, config: withDashFilter(a.config) }));
      }
    }

    const answer: CopilotAnswer = {
      explanation,
      matchedMetrics,
      suggestedActions,
      grounded: true,
      mode,
      datasetId: dataset.id,
      ...(agentInfo ? { agent: agentInfo } : {}),
      grounding: {
        analyzedRows,
        totalRows: layer.getTotalRowCount(),
        sampled: layer.getTotalRowCount() > analyzedRows,
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        availableMetrics: metricValues.map((mv) => ({ id: mv.metricId, name: mv.metricName, formula: mv.formula })),
      },
    };

    await logActivity(
      ctx,
      "COPILOT",
      `Dashboard copilot (${mode}) answered for “${dashboard.title}”`,
      dashboard.projectId,
      {
        dashboardId: dashboard.id,
        datasetId: dataset.id,
        request: userRequest.slice(0, 200),
        mode,
        crossFilters: stringifyJson(safeFilters),
        tools: agentInfo?.steps.map((s) => s.tool) ?? [],
        summaryWithheld: agentInfo?.summaryWithheld ?? false,
      },
    );

    return ok(answer);
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { SemanticLayerManager } from "@/lib/analytics/semantic-layer";
import { ApiError, requireAuth } from "@/lib/auth/guard";

/**
 * tenancy-audit: global-operator — copilot API provides workspace-wide
 * data insights via the data copilot. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */
import { runCopilotAgent } from "@/lib/copilot/agent";
import { buildExplanation, detectSmallTalk, matchMetrics, schemaContext, suggestActions } from "@/lib/copilot/engine";
import type { CopilotAgentInfo, CopilotAnswer, CopilotMode } from "@/lib/copilot/engine";
import type { MeasureProposalResult } from "@/lib/copilot/measure-proposal";
import { buildDaxModelForAgent, type AgentContext } from "@/lib/copilot/tools";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import { parseJsonArray } from "@/lib/json";
import { getAvailableLLMProvider } from "@/lib/llm/providers";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/copilot
 *
 * App-wide data copilot. Every answer is grounded in real computation, in one
 * of two honestly labelled modes:
 *
 *   mode "agent" — the configured Claude model
 *     chooses which tools to call, but the TOOLS compute everything: governed
 *     semantic-layer metrics and the deterministic analysis engine, run over
 *     the dataset's real rows. The model's prose is verified by a numeric
 *     guard and withheld if it cites any number the tools did not produce.
 *
 *   mode "deterministic" — no reachable model, or the agent produced nothing
 *     usable: the original token-matched engine answers instead. Identical
 *     numbers, no model involved.
 *
 * Either way the response reports `mode` and never synthesizes a value. When
 * nothing matches, it says so.
 *
 * Body: { datasetId: string, request: string }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    // Authenticated principal rate limit: key by user id, not IP — behind a
    // corporate proxy every legitimate user shares one address.
    enforceUserRateLimit(ctx.user.id, "copilot", RATE_LIMITS.copilot);

    const body = await readJsonBody<{ datasetId?: string; request?: string }>(request);
    const datasetId = body.datasetId;
    const userRequest = (body.request ?? "").trim().slice(0, 500);

    if (!datasetId) throw new ApiError(400, "VALIDATION", "datasetId is required.");
    if (!userRequest) {
      throw new ApiError(400, "VALIDATION", "Describe what you need, e.g. “show revenue trends.”");
    }

    const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");

    const columns = datasetColumns(dataset);

    // Read the dataset once and share the rows with both the semantic layer and
    // the analysis engine — previously this file was streamed twice per request.
    const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    // RLS: the copilot must reason over exactly the rows the user may see —
    // otherwise its numbers and its prose disclose filtered-out rows.
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
        "This dataset has no rows available to analyse. What happened: the parsed data file is missing or empty. How to fix: re-upload the dataset file.",
      );
    }

    const sctx = schemaContext(columns);

    // ChatGPT-style small talk: greetings and identity questions get a warm,
    // human answer (naming only real dataset facts) in BOTH modes, so a bare
    // “hi” never meets “No governed metric matches”.
    const smallTalk = detectSmallTalk(userRequest);

    // Deterministic baseline — always computed. It is the answer when no model
    // is configured, and the fallback whenever the agent withholds its prose.
    const detMatched = smallTalk ? [] : matchMetrics(userRequest, metricValues);
    const detActions = smallTalk ? [] : suggestActions(userRequest, sctx);
    const detExplanation = buildExplanation(userRequest, detMatched, detActions, sctx, {
      analyzedRows,
      totalRows: layer.getTotalRowCount(),
    });

    let mode: CopilotMode = "deterministic";
    let explanation = smallTalk ?? detExplanation;
    let matchedMetrics = detMatched;
    let suggestedActions = detActions;
    let agentInfo: CopilotAgentInfo | undefined;
    // A3 — a verified DAX measure proposal to offer the user (never auto-saved).
    let measureProposal: MeasureProposalResult | undefined;

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
        // A3: proposals are verified against the RLS-filtered rows only.
        daxModel: buildDaxModelForAgent(columns, visibleRows),
      };
      // Never throws for provider/parse failures — returns null so we degrade.
      const agent = await runCopilotAgent(provider, agentCtx, userRequest);
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
        // The model's prose is used ONLY when the guard verified its numbers.
        if (agent.summary) explanation = agent.summary;
        if (agent.matchedMetrics.length > 0) matchedMetrics = agent.matchedMetrics;
        if (agent.suggestedActions.length > 0) suggestedActions = agent.suggestedActions;
        // Surface the LAST verified proposal from the tool trace, if any.
        measureProposal = agent.measureProposal ?? undefined;
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
      ...(measureProposal ? { measureProposal } : {}),
      grounding: {
        analyzedRows,
        totalRows: layer.getTotalRowCount(),
        sampled: layer.getTotalRowCount() > analyzedRows,
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        availableMetrics: metricValues.map((mv) => ({
          id: mv.metricId,
          name: mv.metricName,
          formula: mv.formula,
        })),
      },
    };

    await logActivity(ctx, "COPILOT", `Copilot (${mode}) answered for “${dataset.name}”`, dataset.projectId, {
      datasetId: dataset.id,
      request: userRequest.slice(0, 200),
      mode,
      tools: agentInfo?.steps.map((s) => s.tool) ?? [],
      summaryWithheld: agentInfo?.summaryWithheld ?? false,
      matchedMetrics: matchedMetrics.map((m) => m.metricId),
      suggestedActions: suggestedActions.map((a) => a.kind),
    });

    return ok(answer);
  } catch (err) {
    return toErrorResponse(err);
  }
}

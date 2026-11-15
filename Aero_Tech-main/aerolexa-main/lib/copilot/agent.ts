/**
 * Copilot agent loop.
 *
 * The model chooses what to compute; the engines compute it. On every turn the
 * model emits one JSON action (see agent-protocol.ts). Tool calls execute
 * against the dataset's real rows; their results are fed back verbatim. The
 * loop ends when the model calls `finish`, or when the step budget runs out.
 *
 * Honesty guarantees enforced here:
 * - A model-authored `summary` is only returned after the numeric guard
 *   (guard.ts) verifies every number in it against real tool output. Otherwise
 *   it is withheld and `summaryWithheld` is set — the caller shows the
 *   deterministic answer instead.
 * - If the provider errors out before producing anything useful, this returns
 *   null and the route falls back to the deterministic engine. A model outage
 *   never degrades into a fabricated answer.
 * - The loop is bounded (`MAX_STEPS`), so a model that never finishes cannot
 *   spin or run up unbounded latency.
 */

import type { MetricValue } from "@/lib/analytics/semantic-layer";
import {
  buildAgentSystemPrompt,
  buildAgentTurnPrompt,
  buildDashboardPromptAddendum,
  parseAgentAction,
  renderToolResult,
} from "@/lib/copilot/agent-protocol";
import type { CopilotAction, CopilotToolTrace, GroundedMetric } from "@/lib/copilot/engine";
import { verifySummary } from "@/lib/copilot/guard";
import type { MeasureProposalResult } from "@/lib/copilot/measure-proposal";
import { executeTool, type AgentContext, type ToolExecution } from "@/lib/copilot/tools";
import type { LLMProvider } from "@/lib/llm/providers";

/** Hard ceiling on model turns — a runaway agent is a bug, not a feature. */
export const MAX_STEPS = 6;

/**
 * Default wall-clock budget for the whole loop. Per-call timeouts alone would
 * allow MAX_STEPS × timeoutMs (minutes) of latency; this bounds the request so
 * a slow model degrades to the deterministic answer instead of hanging.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 45_000;

export interface AgentRunResult {
  provider: string;
  model: string;
  latencyMs: number;
  steps: CopilotToolTrace[];
  /** Guarded, model-authored summary — or null when withheld/unavailable. */
  summary: string | null;
  summaryWithheld: boolean;
  /** Why the summary was withheld (only set when summaryWithheld is true). */
  withheldReason: string | null;
  /** Real metric values the agent computed via tools. */
  matchedMetrics: GroundedMetric[];
  /** Runnable analyses the agent actually executed (with their exact configs). */
  suggestedActions: CopilotAction[];
  /** A3 — last verified measure proposal, when the agent called propose_measure. */
  measureProposal: MeasureProposalResult | null;
}

/** Build the display card for a metric the agent computed. matchedOn is empty: no token match claimed. */
function toGroundedMetric(mv: MetricValue): GroundedMetric {
  return {
    metricId: mv.metricId,
    metricName: mv.metricName,
    value: mv.value,
    formattedValue: mv.formattedValue,
    formula: mv.formula,
    resolvedColumns: mv.resolvedColumns,
    sampleSize: mv.sampleSize,
    totalRows: mv.totalRows,
    confidence: mv.confidence,
    matchedOn: [],
  };
}

function schemaSummary(ctx: AgentContext): string {
  const cols = ctx.columns.map((c) => `  - ${c.name} (${c.type})`).join("\n");
  return [
    `dataset name: "${ctx.datasetName}"`,
    `columns (${ctx.columns.length}):`,
    cols,
    `rows analysed: ${ctx.rows.length} of ${ctx.totalRows} total`,
    `governed metrics available: ${ctx.metricValues.length === 0 ? "none" : ctx.metricValues.map((m) => m.metricId).join(", ")}`,
  ].join("\n");
}

function shortSummary(exec: ToolExecution): string {
  if (!exec.ok) return exec.error ?? "failed";
  const first = exec.digest.split("\n").find((l) => l.trim().length > 0) ?? "ok";
  return first.slice(0, 200);
}

/**
 * Run the agent. Returns null when the provider failed before producing any
 * usable action (caller should fall back to the deterministic engine).
 */
export async function runCopilotAgent(
  provider: LLMProvider,
  ctx: AgentContext,
  request: string,
  options: {
    maxSteps?: number;
    timeoutMs?: number;
    totalBudgetMs?: number;
    /** Roadmap A1 — bind the agent to a dashboard page (advertises get_dashboard_context). */
    dashboardContext?: unknown;
  } = {},
): Promise<AgentRunResult | null> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const perCallTimeout = options.timeoutMs ?? 25000;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const started = Date.now();
  const onDashboard = Boolean(ctx.dashboard);
  const systemPrompt = buildAgentSystemPrompt(schemaSummary(ctx)) + (onDashboard ? buildDashboardPromptAddendum() : "");

  const transcript: string[] = [];
  const steps: CopilotToolTrace[] = [];
  const facts: string[] = [];
  const metricsById = new Map<string, GroundedMetric>();
  const actionsByKey = new Map<string, CopilotAction>();
  /** A3 — the most recent verified measure proposal, surfaced for the UI. */
  let measureProposal: MeasureProposalResult | null = null;
  /** The real model id the provider reported — never a placeholder. */
  let model = "";
  /** Why the loop ended without a finish — used for an accurate explanation. */
  let stopReason: "steps" | "time" = "steps";

  for (let step = 1; step <= maxSteps; step++) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining <= 0) {
      transcript.push("BUDGET EXHAUSTED before the next step.");
      stopReason = "time";
      break;
    }

    let content: string;
    try {
      const response = await provider.generate({
        systemPrompt,
        userPrompt: buildAgentTurnPrompt(request, transcript.join("\n\n")),
        maxTokens: 600,
        temperature: 0,
        // Never let a single call outlive the overall budget.
        timeout: Math.min(perCallTimeout, remaining),
      });
      content = response.content;
      if (!model && response.model) model = response.model;
    } catch (err) {
      // Provider died. If nothing has happened yet, let the caller fall back;
      // otherwise end with no summary rather than a guess.
      if (steps.length === 0) return null;
      transcript.push(`MODEL ERROR: ${err instanceof Error ? err.message : "unknown error"}`);
      break;
    }

    const action = parseAgentAction(content);
    if (action.kind === "invalid") {
      transcript.push(`INVALID RESPONSE: ${action.reason}. Reply with exactly one JSON object.`);
      steps.push({ step, tool: "(invalid)", args: {}, ok: false, summary: action.reason, error: action.reason });
      continue;
    }

    if (action.tool === "finish") {
      const summaryText = typeof action.args.summary === "string" ? action.args.summary.trim() : "";
      if (!summaryText) {
        transcript.push('ERROR: finish requires a non-empty "summary" string.');
        steps.push({
          step,
          tool: "finish",
          args: action.args,
          ok: false,
          summary: "empty summary",
          error: "empty summary",
        });
        continue;
      }
      const verdict = verifySummary(summaryText, [...facts, request, ctx.datasetName]);
      steps.push({
        step,
        tool: "finish",
        args: action.args,
        ok: true,
        summary: verdict.ok ? "summary verified against tool output" : "summary withheld (unverified numbers)",
      });
      return finalise(provider, model, started, steps, {
        summary: verdict.ok ? summaryText : null,
        summaryWithheld: !verdict.ok,
        withheldReason: verdict.ok
          ? null
          : `The model's summary contained numbers that were not computed from your data (${verdict.violations.join(
              ", ",
            )}), so it was withheld. The computed results below are real.`,
        metricsById,
        actionsByKey,
        measureProposal,
      });
    }

    // Real tool execution.
    const exec = executeTool(action.tool, action.args, ctx);
    steps.push({
      step,
      tool: action.tool,
      args: action.args,
      ok: exec.ok,
      summary: shortSummary(exec),
      ...(exec.ok ? {} : { error: exec.error }),
    });
    transcript.push(renderToolResult(action.tool, exec.ok, exec.digest, exec.error));
    if (exec.ok) facts.push(...exec.facts);

    // Collect the machine payloads for the UI.
    if (exec.tool === "compute_metrics" && exec.ok) {
      const metrics = (exec.data as { metrics?: MetricValue[] } | undefined)?.metrics ?? [];
      for (const mv of metrics) metricsById.set(mv.metricId, toGroundedMetric(mv));
    }
    if (exec.tool === "propose_measure" && exec.ok) {
      const data = exec.data as { proposal?: MeasureProposalResult } | undefined;
      if (data?.proposal) measureProposal = data.proposal;
    }
    if (exec.tool === "run_analysis" && exec.ok) {
      const data = exec.data as { kind: string; title: string; config: CopilotAction["config"] } | undefined;
      if (data?.config) {
        actionsByKey.set(`${data.kind}:${data.title}`, {
          kind: data.kind,
          title: data.title,
          description: `${data.title} — computed over your real rows. Save it to open the full analysis.`,
          config: data.config,
        });
      }
    }

    // Nudge the model toward a conclusion when the budget is nearly spent.
    if (step === maxSteps - 1) {
      transcript.push(
        "You are almost out of steps. If you can answer, call finish now using only numbers from the results above.",
      );
    }
  }

  // Budget exhausted without a finish. Return the real results, no summary.
  return finalise(provider, model, started, steps, {
    summary: null,
    summaryWithheld: true,
    withheldReason:
      stopReason === "time"
        ? "The model did not produce a verified summary within its time budget. The computed results below are real and complete."
        : "The model did not produce a verified summary within its step budget. The computed results below are real and complete.",
    metricsById,
    actionsByKey,
    measureProposal,
  });
}

function finalise(
  provider: LLMProvider,
  model: string,
  started: number,
  steps: CopilotToolTrace[],
  out: {
    summary: string | null;
    summaryWithheld: boolean;
    withheldReason: string | null;
    metricsById: Map<string, GroundedMetric>;
    actionsByKey: Map<string, CopilotAction>;
    measureProposal?: MeasureProposalResult | null;
  },
): AgentRunResult {
  return {
    provider: provider.name,
    model: model || "unknown",
    latencyMs: Date.now() - started,
    steps,
    summary: out.summary,
    summaryWithheld: out.summaryWithheld,
    withheldReason: out.withheldReason,
    matchedMetrics: [...out.metricsById.values()],
    suggestedActions: [...out.actionsByKey.values()],
    measureProposal: out.measureProposal ?? null,
  };
}

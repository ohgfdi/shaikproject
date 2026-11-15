"use client";

import { Bot, ChevronDown, ChevronUp, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { CopilotAction, CopilotAnswer, GroundedMetric } from "@/lib/copilot/engine";

/**
 * Roadmap A1 — "explain this page" copilot for dashboards.
 *
 * A compact side panel bound to the dashboard's live context: every question
 * carries the page id and the ACTIVE cross-filter state, so the copilot
 * answers about the page as filtered right now. Answers show the same
 * grounding footer and tool trace as the dataset copilot — provenance over
 * trust — and suggested analyses run through the real analyses API against
 * the dashboard's dataset (reported by the server in the grounding block).
 */
export function DashboardCopilot({
  dashboardId,
  pageId,
  crossFilters,
}: {
  dashboardId: string;
  pageId: string;
  crossFilters: { column: string; values: string[] }[];
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<CopilotAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<{ kind: string; message: string; ok: boolean } | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const request = prompt.trim();
    if (!request || loading) return;
    setLoading(true);
    setError(null);
    setRunState(null);
    try {
      const data = await api<CopilotAnswer>(`/api/dashboards/${dashboardId}/copilot`, {
        method: "POST",
        body: JSON.stringify({ request, pageId, crossFilters }),
      });
      setResponse(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: CopilotAction) {
    const datasetId = response?.datasetId;
    if (!action.config || !datasetId || runState?.kind === action.kind) return;
    setRunState({ kind: action.kind, message: "Running analysis…", ok: true });
    try {
      const data = await api<{ analysisId: string }>(`/api/datasets/${datasetId}/analyses`, {
        method: "POST",
        body: JSON.stringify({ kind: action.config.kind, config: action.config }),
      });
      setRunState({ kind: action.kind, message: "Analysis complete — opening the result…", ok: true });
      window.location.href = `/analyses/${data.analysisId}`;
    } catch (err) {
      setRunState({ kind: action.kind, message: errorMessage(err), ok: false });
    }
  }

  return (
    <Card className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bot className="size-4 text-accent" />
          Copilot — explain this page
          {crossFilters.length > 0 && (
            <Badge variant="info" className="ml-1">
              {crossFilters.length} filter{crossFilters.length === 1 ? "" : "s"} applied
            </Badge>
          )}
        </span>
        {open ? <ChevronUp className="size-4 text-muted" /> : <ChevronDown className="size-4 text-muted" />}
      </button>

      {open && (
        <CardContent className="border-t border-line pt-4">
          <form onSubmit={ask} className="flex gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. “why is Q3 flat?” or “explain the top widget”"
              className="h-10 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
              aria-label="Ask the copilot about this dashboard"
            />
            <button
              type="submit"
              disabled={loading || !prompt.trim()}
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : null}
              Ask
            </button>
          </form>

          {error && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#E8637A]/30 bg-[#E8637A]/10 p-3 text-sm text-[#B93A52] dark:text-[#F08A9B]">
              <TriangleAlert className="size-4 shrink-0" />
              {error}
            </div>
          )}

          {response && !error && (
            <div className="mt-4 space-y-3">
              <p className="whitespace-pre-wrap text-sm text-foreground">{response.explanation}</p>

              {response.agent && response.agent.steps.length > 0 && (
                <details className="rounded-lg border border-line bg-surface-2/40 p-3">
                  <summary className="cursor-pointer text-caption font-medium text-muted">
                    How this was computed — {response.agent.steps.length} tool step
                    {response.agent.steps.length === 1 ? "" : "s"} · {response.agent.provider}/{response.agent.model} ·{" "}
                    {response.agent.latencyMs} ms
                    {response.agent.summaryWithheld ? " · summary withheld" : ""}
                  </summary>
                  <ol className="mt-2 space-y-1.5">
                    {response.agent.steps.map((s) => (
                      <li key={s.step} className="text-caption text-muted">
                        <span className="font-medium text-foreground">
                          {s.step}. {s.tool}
                        </span>{" "}
                        — {s.summary}
                        {s.error ? ` (${s.error})` : ""}
                      </li>
                    ))}
                  </ol>
                  {response.agent.summaryWithheld && response.agent.withheldReason && (
                    <p className="mt-2 flex items-start gap-1.5 text-caption text-[#B93A52] dark:text-[#F08A9B]">
                      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                      {response.agent.withheldReason}
                    </p>
                  )}
                </details>
              )}

              {response.matchedMetrics.length > 0 && (
                <div className="space-y-2">
                  {response.matchedMetrics.map((m) => (
                    <GroundedMetricRow key={m.metricId} metric={m} />
                  ))}
                </div>
              )}

              {response.suggestedActions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {response.suggestedActions
                    .filter((a) => a.config)
                    .map((a) => (
                      <Button
                        key={a.kind}
                        variant="secondary"
                        size="sm"
                        onClick={() => void runAction(a)}
                        disabled={!response.datasetId}
                      >
                        {a.title}
                      </Button>
                    ))}
                </div>
              )}
              {runState && (
                <p className={runState.ok ? "text-caption text-muted" : "text-caption text-[#B93A52]"}>
                  {runState.message}
                </p>
              )}

              <p className="text-caption text-muted">
                Grounded on {response.grounding.analyzedRows.toLocaleString()} of{" "}
                {response.grounding.totalRows.toLocaleString()} rows · {response.grounding.availableMetrics.length}{" "}
                governed metric
                {response.grounding.availableMetrics.length === 1 ? "" : "s"} available
                {crossFilters.length > 0 ? ` · page filtered by ${crossFilters.map((f) => f.column).join(", ")}` : ""}.
                No number is shown unless it was computed from these rows.
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function GroundedMetricRow({ metric }: { metric: GroundedMetric }) {
  const coverage = Math.round(metric.confidence * 100);
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-[#58B368]/30 bg-[#58B368]/10 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {metric.metricName}: <strong>{metric.formattedValue}</strong>
        </p>
        <p className="mt-0.5 truncate text-caption text-muted">
          {metric.formula} · columns: {Object.values(metric.resolvedColumns).join(", ")} · {coverage}% coverage
        </p>
      </div>
    </div>
  );
}

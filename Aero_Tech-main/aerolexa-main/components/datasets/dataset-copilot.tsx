"use client";

import { ArrowRight, Bot, CheckCircle2, Loader2, ShieldCheck, TriangleAlert, Wrench } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { CopilotAction, CopilotAnswer, GroundedMetric } from "@/lib/copilot/engine";

/**
 * Dataset Copilot — a plain-language assistant grounded in real data.
 *
 * Every metric shown is computed live from the dataset's rows (semantic
 * layer) with its formula and resolved columns; suggestions run the real
 * analysis engine. When nothing matches the request, the copilot says so
 * instead of inventing an answer.
 */
export function DatasetCopilot({ datasetId }: { datasetId: string }) {
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
      const data = await api<CopilotAnswer>("/api/copilot", {
        method: "POST",
        body: JSON.stringify({ datasetId, request }),
      });
      setResponse(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: CopilotAction) {
    if (!action.config || runState?.kind === action.kind) return;
    setRunState({ kind: action.kind, message: "Running analysis…", ok: true });
    try {
      const data = await api<{ analysisId: string }>("/api/datasets/" + datasetId + "/analyses", {
        method: "POST",
        body: JSON.stringify({ kind: action.config.kind, config: action.config }),
      });
      setRunState({
        kind: action.kind,
        message: "Analysis complete — opening the result…",
        ok: true,
      });
      window.location.href = `/analyses/${data.analysisId}`;
    } catch (err) {
      setRunState({ kind: action.kind, message: errorMessage(err), ok: false });
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-accent" />
            Copilot
          </CardTitle>
          <CardDescription>
            Ask about this dataset in plain language. Answers cite the formula, columns and row coverage behind every
            number.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent>
        <form onSubmit={ask} className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. “show me revenue trends” or “what is our average order value?”"
            className="h-10 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
            aria-label="Ask the copilot about this dataset"
          />
          <button
            type="submit"
            disabled={loading || !prompt.trim()}
            aria-label="Ask copilot"
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            <span className="hidden sm:inline">Ask</span>
          </button>
        </form>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setPrompt(s)}
              className="rounded-full border border-line px-2.5 py-1 text-caption text-muted transition-colors hover:border-accent hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#E8637A]/30 bg-[#E8637A]/10 p-3 text-sm text-[#B93A52] dark:text-[#F08A9B]">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {response && !error && (
          <div className="mt-4 space-y-3">
            {/* Explanation — labelled with which brain actually produced it. */}
            <div className="rounded-lg border border-line bg-surface p-4">
              <h4 className="mb-2 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
                <ShieldCheck aria-hidden className="h-4 w-4 text-[#58B368]" />
                Answer
                {response.mode === "agent" && response.agent && !response.agent.summaryWithheld ? (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-normal text-muted">
                    model wording · numbers verified
                  </span>
                ) : (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-normal text-muted">
                    deterministic engine
                  </span>
                )}
              </h4>
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted">{response.explanation}</p>
            </div>

            {/* Agent provenance — which model, which tools, and any withheld prose. */}
            {response.agent && (
              <div className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="info"
                    title={`Answered via ${response.agent.provider} in ${response.agent.latencyMs} ms`}
                  >
                    <Bot aria-hidden className="mr-1 h-3 w-3" />
                    Agent · {response.agent.provider} · {response.agent.model}
                  </Badge>
                  <span className="text-caption text-muted">
                    {response.agent.steps.length} tool call{response.agent.steps.length === 1 ? "" : "s"} · ran the real
                    engines
                  </span>
                </div>
                {response.agent.summaryWithheld && response.agent.withheldReason && (
                  <p className="mt-2 flex items-start gap-1 text-caption text-[#B93A52] dark:text-[#F08A9B]">
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                    {response.agent.withheldReason}
                  </p>
                )}
                {response.agent.steps.length > 0 && (
                  <ol className="mt-2 space-y-1">
                    {response.agent.steps.map((s) => (
                      <li key={s.step} className="flex items-start gap-2 text-caption text-muted">
                        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface text-[10px]">
                          {s.step}
                        </span>
                        <Wrench aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="font-mono">{s.tool}</span>
                        <span className="min-w-0 flex-1 truncate">{s.summary}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {/* Matched metrics with provenance */}
            {response.matchedMetrics.length > 0 && (
              <div>
                <p className="mb-2 text-caption font-medium uppercase tracking-wide text-muted">Real metrics</p>
                <div className="space-y-2">
                  {response.matchedMetrics.map((m) => (
                    <GroundedMetricRow key={m.metricId} metric={m} />
                  ))}
                </div>
              </div>
            )}

            {/* A3 — verified measure proposal: the engine checked it; the user decides. */}
            {response.measureProposal && response.measureProposal.ok && (
              <div className="rounded-lg border border-[#58B368]/30 bg-[#58B368]/10 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <ShieldCheck aria-hidden className="h-4 w-4 text-[#58B368]" />
                  Proposed measure “{response.measureProposal.name}” — verified
                </p>
                <p className="mt-1 break-all font-mono text-caption text-muted">{response.measureProposal.dax}</p>
                <p className="mt-1 text-caption text-muted">
                  Engine-computed value: <strong>{response.measureProposal.evaluatedValue}</strong> · cross-check{" "}
                  {response.measureProposal.crossCheck}. Not saved yet — create it under the dataset’s custom metrics to
                  use it everywhere.
                </p>
              </div>
            )}

            {/* Suggested actions — runnable */}
            {response.suggestedActions.length > 0 && (
              <div>
                <p className="mb-2 text-caption font-medium uppercase tracking-wide text-muted">
                  {response.matchedMetrics.length > 0 ? "Go further" : "What I can run instead"}
                </p>
                <div className="space-y-2">
                  {response.suggestedActions.map((a) => (
                    <div key={a.kind + a.title} className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{a.title}</p>
                          <p className="mt-0.5 text-caption text-muted">{a.description}</p>
                          {a.missingRequirement && (
                            <p className="mt-1 flex items-center gap-1 text-caption text-[#B93A52] dark:text-[#F08A9B]">
                              <TriangleAlert className="h-3 w-3 shrink-0" />
                              {a.missingRequirement}
                            </p>
                          )}
                        </div>
                        {a.config && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={runState?.kind === a.kind && runState.ok}
                            onClick={() => void runAction(a)}
                          >
                            {runState?.kind === a.kind && runState.ok ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Run
                          </Button>
                        )}
                      </div>
                      {runState?.kind === a.kind && !runState.ok && (
                        <p className="mt-2 flex items-center gap-1 text-caption text-[#B93A52] dark:text-[#F08A9B]">
                          <TriangleAlert className="h-3 w-3 shrink-0" />
                          {runState.message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Grounding footer — measured coverage, not a vibe */}
            <p className="text-caption text-muted">
              Grounded on {response.grounding.analyzedRows.toLocaleString()}
              {response.grounding.sampled
                ? ` of ${response.grounding.totalRows.toLocaleString()} (labelled sample)`
                : ""}{" "}
              rows · {response.grounding.columns.length} columns · {response.grounding.availableMetrics.length} governed
              metric
              {response.grounding.availableMetrics.length === 1 ? "" : "s"} available. No number is shown unless it was
              computed from these rows.
            </p>
          </div>
        )}
      </CardContent>
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
          {metric.formula} · columns: {Object.values(metric.resolvedColumns).join(", ")}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {metric.matchedOn.map((t) => (
            <span key={t} className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
              matched “{t}”
            </span>
          ))}
        </div>
      </div>
      <Badge
        variant="info"
        title={`Computed from ${metric.sampleSize.toLocaleString()} of ${metric.totalRows.toLocaleString()} analysed rows (${coverage}% coverage)`}
      >
        <CheckCircle2 aria-hidden className="mr-1 h-3 w-3" />
        {coverage}% rows
      </Badge>
    </div>
  );
}

const SUGGESTIONS = [
  "What are the key metrics?",
  "Show revenue trends",
  "Any strong correlations?",
  "Segment by region",
  "Data quality issues?",
];

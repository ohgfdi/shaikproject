"use client";

import { Loader2, Send, ShieldCheck, Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { CONFIDENCE_LABEL } from "@/components/ui/theme";
import { ADVISOR_SUGGESTIONS } from "@/lib/advisor-suggestions";
import { api, errorMessage } from "@/lib/client/api";
import type { AdvisorResult, Confidence } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface AdvisorScopeDataset {
  id: string;
  name: string;
  rowCount: number;
  projectName: string | null;
}

const TIMELINE_STEPS = [
  "Analyzing dataset…",
  "Checking data quality…",
  "Calculating revenue drivers…",
  "Generating business interpretation…",
  "Preparing recommendation…",
];

function ConfidenceTag({ c }: { c: Confidence }) {
  const variant: Record<string, "default" | "accent" | "amber"> = {
    calculated: "accent",
    inferred: "amber",
    recommendation: "default",
  };
  return (
    <Badge variant={variant[c] ?? "default"} className="whitespace-nowrap" title={CONFIDENCE_LABEL[c]}>
      {c}
    </Badge>
  );
}

export function AdvisorPanel({
  datasets,
  initialDatasetId,
}: {
  datasets: AdvisorScopeDataset[];
  initialDatasetId?: string;
}) {
  const params = useSearchParams();
  const projectParam = params.get("project");
  const { toast } = useToast();
  const [scopeId, setScopeId] = useState(initialDatasetId ?? datasets[0]?.id ?? "");
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<"idle" | "thinking" | "done">("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [answer, setAnswer] = useState<AdvisorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const scope = datasets.find((d) => d.id === scopeId);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  const ask = async (q: string) => {
    if (!q.trim() || phase === "thinking") return;
    setQuestion(q);
    setError(null);
    setAnswer(null);
    setPhase("thinking");
    setStepIndex(0);
    let i = 0;
    timerRef.current = window.setInterval(() => {
      i += 1;
      setStepIndex(i);
      if (i >= TIMELINE_STEPS.length && timerRef.current) {
        window.clearInterval(timerRef.current);
      }
    }, 450);

    try {
      const res = await api<AdvisorResult>("/api/advisor", {
        method: "POST",
        body: JSON.stringify({ question: q, datasetId: scopeId || undefined, projectId: projectParam ?? undefined }),
      });
      if (timerRef.current) window.clearInterval(timerRef.current);
      setStepIndex(TIMELINE_STEPS.length);
      setAnswer(res);
      setPhase("done");
    } catch (err) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      const msg = errorMessage(err);
      setError(msg);
      setPhase("idle");
      if ((err as { code?: string })?.code === "NO_DATASET") {
        toast({ title: "No dataset yet", message: msg, type: "error" });
      }
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="flex flex-col gap-4 xl:col-span-2">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-h3 text-foreground">Ask your data anything</h2>
            <Badge variant="success" className="cursor-help">
              <ShieldCheck aria-hidden className="size-3" />
              Calculated
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            Answers are computed with deterministic, oracle-validated statistics over your uploaded data — contribution
            decomposition, Mann–Kendall trend tests, backtested projections, HHI concentration and Welch t-tests. No
            live model API is called; nothing is invented, and sections that need missing data are listed as
            unavailable.
          </p>

          <label className="mt-4 block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Advise on dataset</span>
            <select
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              disabled={phase === "thinking"}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rowCount.toLocaleString()} rows{d.projectName ? ` · ${d.projectName}` : ""})
                </option>
              ))}
            </select>
          </label>

          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <label className="sr-only" htmlFor="advisor-q">
              Your business question
            </label>
            <textarea
              id="advisor-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How is our business performing, and what should we improve next quarter?"
              rows={2}
              className="min-h-14 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
            <Button
              type="submit"
              loading={phase === "thinking"}
              disabled={!scope || question.trim().length < 4}
              aria-label="Ask the advisor"
            >
              <Send aria-hidden className="size-4" />
            </Button>
          </form>

          <div className="mt-3 flex flex-wrap gap-2">
            {ADVISOR_SUGGESTIONS.map((s) => (
              <button
                key={s.q}
                onClick={() => void ask(s.q)}
                disabled={phase === "thinking"}
                className="rounded-full border border-line px-3 py-1 text-caption text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
              >
                {s.q}
              </button>
            ))}
          </div>
        </Card>

        {phase === "thinking" && (
          <Card className="flex flex-col gap-3 p-5">
            {TIMELINE_STEPS.map((step, i) => (
              <p
                key={step}
                aria-current={i === stepIndex ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2.5 text-sm transition-colors",
                  i < stepIndex && "text-muted",
                  i === stepIndex && "font-medium text-foreground",
                  i > stepIndex && "text-muted/50",
                )}
              >
                {i < stepIndex ? (
                  <ShieldCheck aria-hidden className="size-4 text-accent" />
                ) : i === stepIndex ? (
                  <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
                ) : (
                  <span aria-hidden className="ml-1 size-1.5 rounded-full bg-line" />
                )}
                {step}
              </p>
            ))}
          </Card>
        )}

        {error && <div className="text-sm text-danger">{error}</div>}

        {answer && phase === "done" && <AdvisorAnswer answer={answer} />}
      </div>

      <aside aria-label="About the advisor" className="flex flex-col gap-4">
        <Card className="p-4">
          <h2 className="flex items-center gap-2 text-h3 text-foreground">
            <Sparkles aria-hidden className="size-4 text-accent" /> How the advisor works
          </h2>
          <ol className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>1. Your question is routed to the right analysis intent.</li>
            <li>2. Metric, dimension and date columns are resolved from your data.</li>
            <li>
              3. Contribution decomposition, Mann–Kendall trend test, backtested projection, HHI concentration and Welch
              segment tests run on your rows.
            </li>
            <li>
              4. Sections are flagged: calculated · inferred · recommendation — and anything the dataset cannot support
              is listed as unavailable, never guessed.
            </li>
          </ol>
          <p className="mt-3 text-caption text-muted">
            {scope ? (
              <>
                Advising on: <span className="font-medium text-foreground">{scope.name}</span>
              </>
            ) : (
              "Choose a dataset above."
            )}
          </p>
        </Card>
        {datasets.length === 0 && (
          <Card>
            <EmptyState
              title="No dataset to advise on"
              description="Upload a CSV/XLSX in any project — the advisor answers only from real data."
            />
          </Card>
        )}
      </aside>
    </div>
  );
}

function AdvisorAnswer({ answer }: { answer: AdvisorResult }) {
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-caption font-medium uppercase tracking-wide text-muted">Business question</p>
          <ConfidenceTag c={flagOf(answer, "Executive answer")} />
        </div>
        <p className="mt-1 font-medium text-foreground">{answer.businessQuestion}</p>
        <p className="mt-3 text-foreground">{answer.executiveAnswer}</p>
      </Card>

      <section aria-labelledby="evidence" className="card p-5">
        <h3 id="evidence" className="flex items-center justify-between gap-2 text-h3 text-foreground">
          Evidence
          <ConfidenceTag c="calculated" />
        </h3>
        <ul className="mt-3 flex flex-col gap-2">
          {answer.evidence.map((e, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-md bg-surface-2/60 px-3 py-2 text-sm">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>
                <span className="font-medium text-foreground">{e.label}.</span>{" "}
                <span className="text-muted">{e.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {answer.diagnostics && <DiagnosticsBlock d={answer.diagnostics} />}

      <Section title="Key drivers" confidence={flagOf(answer, "Key drivers")}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {answer.keyDrivers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </Section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Section title="Risks" confidence="inferred">
          <ul className="flex flex-col gap-2">
            {answer.risks.map((r, i) => (
              <RiskRow key={i} text={r} tone="risk" />
            ))}
          </ul>
        </Section>
        <Section title="Opportunities" confidence="inferred">
          <ul className="flex flex-col gap-2">
            {answer.opportunities.map((o, i) => (
              <RiskRow key={i} text={o} tone="opp" />
            ))}
          </ul>
        </Section>
      </div>

      <Section title="Options & recommendation" confidence="recommendation">
        <ul className="flex flex-col gap-2">
          {answer.options.map((o, i) => (
            <li key={i} className="rounded-md border border-line px-3 py-2.5 text-sm">
              <p className="font-medium text-foreground">
                {i + 1}. {o.title} <ConfidenceTag c={o.confidence} />
              </p>
              <p className="mt-1 text-muted">{o.detail}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 rounded-md border-l-2 border-accent bg-accent/5 px-3 py-2.5 text-sm font-medium text-foreground">
          Recommendation: {answer.recommendation}
        </p>
      </Section>

      <Section title="Expected impact" confidence={flagOf(answer, "Expected impact")}>
        <p className="text-sm text-muted">{answer.expectedImpact}</p>
      </Section>

      <Section title="Next actions" confidence="recommendation">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          {answer.nextActions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ol>
      </Section>

      <p className="rounded-md border border-line bg-surface-2/50 px-3 py-2 text-caption text-muted">
        <span className="font-medium text-foreground">Methodology:</span> {answer.methodologyNote} Used{" "}
        {answer.used.rowsUsed.toLocaleString()} of {answer.used.totalRows.toLocaleString()} rows
        {answer.used.sampled ? " (sampled)" : ""} from “{answer.used.datasetName}”.
      </p>
    </div>
  );
}

/**
 * Elite-advisor diagnostics — every number here was computed from the dataset
 * (lib/engine/advisor-analysis.ts). Sections render only when their data
 * existed; the "not computable" list shows what the dataset cannot support.
 */
function DiagnosticsBlock({ d }: { d: NonNullable<AdvisorResult["diagnostics"]> }) {
  const num = (v: number) =>
    !Number.isFinite(v)
      ? "—"
      : Math.abs(v) >= 1e6
        ? `${(v / 1e6).toFixed(2)}M`
        : Math.abs(v) >= 1e3
          ? `${(v / 1e3).toFixed(1)}K`
          : v.toFixed(2);

  return (
    <section className="card p-5" aria-label="Computed diagnostics">
      <h3 className="flex items-center justify-between gap-2 text-h3 text-foreground">
        Computed diagnostics
        <ConfidenceTag c="calculated" />
      </h3>
      <p className="mt-1 text-caption text-muted">
        Every figure below is derived from your uploaded rows — decomposition, trend test, backtest, concentration and
        significance are deterministic computations, not estimates.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {d.decomposition && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">
              Contribution by {d.decomposition.dimension}
              {d.decomposition.latestPeriodLabel ? ` · latest change vs ${d.decomposition.prevPeriodLabel ?? "—"}` : ""}
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-caption">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="py-1 pr-2 text-left font-medium">Group</th>
                    <th className="py-1 pr-2 text-right font-medium">Total</th>
                    <th className="py-1 pr-2 text-right font-medium">Share</th>
                    <th className="py-1 text-right font-medium">Δ latest</th>
                  </tr>
                </thead>
                <tbody>
                  {d.decomposition.groups.slice(0, 8).map((g) => (
                    <tr key={g.group} className="border-b border-line/50">
                      <td className="py-1 pr-2 text-foreground">{g.group}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-foreground">{num(g.total)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-muted">{g.sharePct.toFixed(1)}%</td>
                      <td className="py-1 text-right tabular-nums text-muted">
                        {g.latestChange === null ? "—" : `${g.latestChange >= 0 ? "+" : ""}${num(g.latestChange)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {d.trend && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">Trend & projection ({d.trend.dateCol})</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-caption text-muted">
              <li>
                {d.trend.nPeriods} {d.trend.granularity}ly periods · latest {num(d.trend.latest ?? 0)} (
                {d.trend.changePct === null
                  ? "—"
                  : `${d.trend.changePct >= 0 ? "+" : ""}${d.trend.changePct.toFixed(1)}%`}
                )
              </li>
              <li>
                Mann–Kendall: <span className="font-medium text-foreground">{d.trend.mannKendallDirection}</span> (p ={" "}
                {d.trend.mannKendallP.toFixed(4)})
              </li>
              {d.trend.projection && (
                <li>
                  Next period <span className="font-medium text-foreground">{num(d.trend.projection.nextPeriod)}</span>{" "}
                  via {d.trend.projection.method} · backtest MAE {num(d.trend.projection.mae)} (
                  {d.trend.projection.mape.toFixed(0)}%) over {d.trend.projection.folds} origins
                  {!d.trend.projection.reliable && (
                    <span className="text-warning"> · above the 25% plannability band</span>
                  )}
                </li>
              )}
            </ul>
          </div>
        )}

        {d.concentration && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">Concentration — {d.concentration.interpretation}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-caption text-muted">
              <li>
                HHI <span className="font-medium text-foreground">{d.concentration.hhi}</span> / 10,000 on{" "}
                {d.concentration.dimension}
              </li>
              <li>
                Top share {d.concentration.topSharePct.toFixed(1)}% · top 3 hold{" "}
                {d.concentration.top3SharePct.toFixed(1)}% of {d.concentration.levels} groups
              </li>
            </ul>
          </div>
        )}

        {d.segmentTest && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">
              Segment contrast — {d.segmentTest.significant ? "significant" : "not significant"}
            </p>
            <ul className="mt-2 flex flex-col gap-1.5 text-caption text-muted">
              <li>
                “{d.segmentTest.segmentA}” mean {num(d.segmentTest.meanA)} (n = {d.segmentTest.nA}) vs “
                {d.segmentTest.segmentB}” mean {num(d.segmentTest.meanB)} (n = {d.segmentTest.nB})
              </li>
              <li>
                Difference {d.segmentTest.diffPct >= 0 ? "+" : ""}
                {d.segmentTest.diffPct.toFixed(1)}% · Welch t-test p = {d.segmentTest.pValue.toFixed(4)}
              </li>
            </ul>
          </div>
        )}

        {d.outlierExposure && d.outlierExposure.outlierRows > 0 && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">Outlier exposure</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-caption text-muted">
              <li>
                {d.outlierExposure.outlierRows} row{d.outlierExposure.outlierRows === 1 ? "" : "s"} beyond 1.5×IQR (&gt;{" "}
                {num(d.outlierExposure.outlierThresholdHigh)})
              </li>
              {d.outlierExposure.totalSharePct !== null && (
                <li>
                  They carry{" "}
                  <span className="font-medium text-foreground">{d.outlierExposure.totalSharePct.toFixed(1)}%</span> of
                  the metric total
                </li>
              )}
            </ul>
          </div>
        )}

        {d.metric.name && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium text-foreground">Headline metric — {d.metric.name}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-caption text-muted">
              <li>
                Total <span className="font-medium text-foreground">{num(d.metric.total)}</span> · mean{" "}
                {num(d.metric.mean)} · median {num(d.metric.median)}
              </li>
              <li>
                σ {num(d.metric.stddev)} · {d.metric.nonEmpty.toLocaleString()} non-empty values
              </li>
            </ul>
          </div>
        )}
      </div>

      {d.unavailable.length > 0 && (
        <div className="mt-4 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          <p className="text-caption font-medium text-foreground">
            Not computable from this dataset (nothing was guessed):
          </p>
          <ul className="mt-1 list-disc pl-5 text-caption text-muted">
            {d.unavailable.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function flagOf(answer: AdvisorResult, section: string): Confidence {
  return answer.confidenceFlags.find((f) => f.section === section)?.confidence ?? "inferred";
}

function Section({
  title,
  confidence,
  children,
}: {
  title: string;
  confidence: Confidence;
  children: import("react").ReactNode;
}) {
  return (
    <section className="card p-5">
      <h3 className="flex items-center justify-between gap-2 text-h3 text-foreground">
        {title} <ConfidenceTag c={confidence} />
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RiskRow({ text, tone }: { text: string; tone: "risk" | "opp" }) {
  return (
    <li className="flex items-start gap-2 text-sm text-muted">
      <span
        aria-hidden
        className={cn("mt-0.5 size-2 shrink-0 rounded-full", tone === "risk" ? "bg-[#E8637A]" : "bg-[#58B368]")}
      />
      {text}
    </li>
  );
}

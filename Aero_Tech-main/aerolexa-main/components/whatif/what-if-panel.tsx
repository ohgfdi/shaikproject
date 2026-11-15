"use client";

import { ArrowLeftRight, FlaskConical, Minus, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage, WarningBanner } from "@/components/ui/feedback";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { fmtNum } from "@/lib/engine/whatif";
import type { WhatIfResult } from "@/lib/types";

export interface WhatIfColumn {
  name: string;
  type: string;
}

/**
 * The S5c crossover scene: the computed WhatIfResult stood up in 3D. Lazy +
 * client-only so the 3D runtime never inflates the what-if route bundle;
 * renders nothing on flat tiers or without WebGL (ChartCanvas self-gates).
 */
const WhatIfSceneMirror = dynamic(() => import("@/components/charts/3d/whatif").then((m) => m.WhatIfScene3D), {
  ssr: false,
  loading: () => null,
});

interface WhatIfResponse {
  result: WhatIfResult;
  dataset: { id: string; name: string; rowsScanned: number; totalRows: number };
}

export function WhatIfPanel({
  datasetId,
  datasetName,
  columns,
}: {
  datasetId: string;
  datasetName: string;
  columns: WhatIfColumn[];
}) {
  const numeric = columns.filter((c) => c.type === "number");
  const binaryCandidates = columns.filter(
    (c) =>
      c.name !== driver &&
      c.name !== outcome &&
      (c.type === "boolean" || /(^|_)(is|has|was|treated|churn|default|active|flag)[a-z0-9_]*$/i.test(c.name)),
  );
  const [driver, setDriver] = useState("");
  const [outcome, setOutcome] = useState("");
  const [pct, setPct] = useState(5);
  const [controls, setControls] = useState<string[]>([]);
  const [treatment, setTreatment] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIfResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await api<WhatIfResponse>(`/api/datasets/${datasetId}/whatif`, {
        method: "POST",
        body: JSON.stringify({
          driverColumn: driver,
          outcomeColumn: outcome,
          pctChange: pct,
          controlColumns: controls.length > 0 ? controls : undefined,
          treatmentColumn: treatment || undefined,
        }),
      });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const outcomes = numeric.filter((c) => c.name !== driver);
  const controlCandidates = numeric.filter((c) => c.name !== driver && c.name !== outcome);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-muted">
          {datasetName} · {numeric.length} numeric column{numeric.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <Badge variant="outline">Multivariate OLS · statsmodels-validated</Badge>
      </div>

      <Card className="p-5">
        <div className="grid grid-cols-1 items-end gap-4 lg:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Driver column (what changes)</span>
            <select
              value={driver}
              onChange={(e) => {
                setDriver(e.target.value);
                if (e.target.value === outcome) setOutcome("");
              }}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose… e.g. price</option>
              {numeric.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Outcome column (what you watch)</span>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              disabled={!driver}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose… e.g. margin</option>
              {outcomes.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">
              Change{" "}
              <span className={pct >= 0 ? "text-success" : "text-danger"}>
                {pct > 0 ? "+" : ""}
                {pct}%
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Minus aria-hidden className="size-4 shrink-0 text-muted" />
              <input
                type="range"
                min={-50}
                max={50}
                step={1}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                aria-label="Percentage change to apply"
                className="h-2 flex-1 cursor-pointer accent-[#5AA8AA]"
              />
              <Plus aria-hidden className="size-4 shrink-0 text-muted" />
            </span>
          </label>
        </div>
        {controlCandidates.length > 0 && (
          <div className="mt-4">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              Control variables{" "}
              <span className="font-normal text-muted">(held constant while {driver || "the driver"} changes)</span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {controlCandidates.map((c) => {
                const active = controls.includes(c.name);
                return (
                  <button
                    key={c.name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setControls((prev) => (active ? prev.filter((x) => x !== c.name) : [...prev, c.name]));
                      if (!active) setTreatment("");
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface text-muted hover:border-accent/40"
                    }`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-caption text-muted">
              Controls reduce omitted-variable bias: the driver&apos;s coefficient measures its effect with these
              columns held statistically constant.
            </p>
          </div>
        )}
        {binaryCandidates.length > 0 && (
          <div className="mt-4">
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              Causal cross-check column{" "}
              <span className="font-normal text-muted">
                (optional binary treatment — enables a design-robust re-estimation)
              </span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {binaryCandidates.map((c) => {
                const active = treatment === c.name;
                return (
                  <button
                    key={c.name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setTreatment(active ? "" : c.name);
                      if (!active) setControls((prev) => prev.filter((x) => x !== c.name));
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface text-muted hover:border-accent/40"
                    }`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-caption text-muted">
              When set, Aerolexa re-estimates the effect with propensity-score weighting (IPW) on this binary column and
              reports whether the two designs agree — the strongest evidence available without a real experiment.
            </p>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end">
          <Button
            onClick={() => void run()}
            loading={running}
            disabled={!driver || !outcome}
            icon={<ArrowLeftRight aria-hidden className="size-4" />}
          >
            Run what-if
          </Button>
        </div>
      </Card>

      {numeric.length < 2 && (
        <p className="mt-3 text-caption text-muted">
          This dataset has {numeric.length} numeric column(s) — what-if needs at least two. Cast string columns to
          Number in the dataset view first.
        </p>
      )}

      {error && <ErrorMessage title="Could not run the simulation" message={error} className="mt-4" />}

      {result && (
        <div className="mt-5">
          {result.result.fallback && (
            <WarningBanner title="Low-signal result — hypothetical only" severity="info" className="mb-4">
              The relationship between {result.result.driverColumn} and {result.result.outcomeColumn} is too weak to
              estimate reliably (r² = {result.result.model.rSquared.toFixed(3)}). Ledgerly shows a proportional
              projection and never claims causation.
            </WarningBanner>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ResultCard label="Before (current mean)" value={fmtNum(result.result.beforeValue)} />
            <ResultCard
              label={`After ${result.result.pctChange > 0 ? "+" : ""}${result.result.pctChange}% on ${result.result.driverColumn}`}
              value={fmtNum(result.result.afterValue)}
            />
            <ResultCard
              label="Delta"
              value={`${result.result.delta >= 0 ? "+" : ""}${fmtNum(result.result.delta)} (${result.result.deltaPct > 0 ? "+" : ""}${fmtNum(result.result.deltaPct)}%)`}
              accent={result.result.delta >= 0 ? "text-success" : "text-danger"}
            />
          </div>

          {/* 3D mirror of the computed projection (S5c) — the cards above are
              the authoritative numbers; the scene only mirrors them. */}
          <WhatIfSceneMirror result={result.result} height={240} />

          <Card className="mt-4 p-5">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <FlaskConical aria-hidden className="size-4 text-accent" /> Narrative
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">{result.result.narrative}</p>
            <p className="mt-3 text-caption text-muted">{result.result.confidenceNote}</p>
          </Card>

          <Card className="mt-4 p-5">
            <p className="font-medium text-foreground">How was this calculated?</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {result.result.methodology.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-caption text-muted">Slope (per 1 unit of driver)</dt>
                <dd className="tabular-nums font-medium text-foreground">{fmtNum(result.result.model.slope)}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">R² (fit quality)</dt>
                <dd className="tabular-nums font-medium text-foreground">{result.result.model.rSquared.toFixed(4)}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">Driver mean</dt>
                <dd className="tabular-nums font-medium text-foreground">{fmtNum(result.result.driverMean)}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">Coefficient p-value</dt>
                <dd className="tabular-nums font-medium text-foreground">{result.result.model.pValue.toFixed(4)}</dd>
              </div>
              <div>
                <dt className="text-caption text-muted">95% slope interval</dt>
                <dd className="tabular-nums font-medium text-foreground">
                  [{fmtNum(result.result.model.confidenceInterval[0])},{" "}
                  {fmtNum(result.result.model.confidenceInterval[1])}]
                </dd>
              </div>
            </dl>
            {(result.result.model.controls?.length ?? 0) > 0 && (
              <div>
                <dt className="text-caption text-muted">Controls held constant</dt>
                <dd className="font-medium text-foreground">{result.result.model.controls!.join(", ")}</dd>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline">{result.result.model.points.toLocaleString()} paired rows used</Badge>
              {(result.result.model.controls?.length ?? 0) > 0 && (
                <Badge variant="outline">multivariate OLS · {result.result.model.controls!.length} control(s)</Badge>
              )}
              <Badge variant="outline">
                HC1 robust SE:{" "}
                {fmtNum(result.result.model.slopeStandardErrorHC1 ?? result.result.model.slopeStandardError ?? 0)}
              </Badge>
              {result.result.fallback && <Badge variant="warning">fallback: hypothetical</Badge>}
            </div>
          </Card>

          {result.result.causal && (
            <Card
              className={`mt-4 p-5 ${
                result.result.causal.agreement === "agree"
                  ? ""
                  : result.result.causal.agreement === "disagree"
                    ? "border-danger/40"
                    : ""
              }`}
            >
              <p className="flex items-center gap-2 font-medium text-foreground">
                <Badge
                  variant={
                    result.result.causal.agreement === "agree"
                      ? "success"
                      : result.result.causal.agreement === "disagree"
                        ? "warning"
                        : "outline"
                  }
                >
                  {result.result.causal.agreement === "agree"
                    ? "designs AGREE"
                    : result.result.causal.agreement === "disagree"
                      ? "designs DISAGREE"
                      : "inconclusive"}
                </Badge>
                Causal cross-check — propensity-score weighting on “{result.result.causal.treatmentColumn}”
              </p>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-caption text-muted">Weighted contrast (ATE)</dt>
                  <dd className="tabular-nums font-medium text-foreground">
                    {fmtNum(result.result.causal.estimate)} [{fmtNum(result.result.causal.ci95.low)},{" "}
                    {fmtNum(result.result.causal.ci95.high)}]
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Per driver unit</dt>
                  <dd className="tabular-nums font-medium text-foreground">
                    {fmtNum(result.result.causal.estimatePerUnit)}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">OLS slope (comparison)</dt>
                  <dd className="tabular-nums font-medium text-foreground">{fmtNum(result.result.model.slope)}</dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">p-value</dt>
                  <dd className="tabular-nums font-medium text-foreground">
                    {Number.isFinite(result.result.causal.pValue) ? result.result.causal.pValue.toFixed(4) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Weighted balance (max |SMD|)</dt>
                  <dd className="tabular-nums font-medium text-foreground">
                    {result.result.causal.balanceMaxAbsSmdAfter.toFixed(3)}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Groups</dt>
                  <dd className="tabular-nums font-medium text-foreground">
                    {result.result.causal.nTreated.toLocaleString()} treated / {result.result.causal.n.toLocaleString()}{" "}
                    total
                  </dd>
                </div>
              </div>
              <p className="mt-3 text-caption text-muted">{result.result.causal.identifyingAssumption}</p>
              {result.result.causal.warnings.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-caption text-muted">
                  {result.result.causal.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ label, value, accent = "text-foreground" }: { label: string; value: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-caption text-muted">{label}</p>
        <p className={`mt-1 text-h2 tabular-nums ${accent}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

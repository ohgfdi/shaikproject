"use client";

/**
 * Power BI studio panel: three tabs over one dataset —
 *  1. KPI scorecards (target attainment + trend, computed server-side)
 *  2. DAX measure builder (filter context, CALCULATE, time intelligence)
 *  3. AI visuals (decomposition tree + key influencers with Wilson CIs)
 * All results come from the deterministic engines via the dataset API routes.
 */
import { BarChart3, FlaskConical, Gauge, Loader2, Play, Sparkles, Target, TreeDeciduous } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import { Chart3D } from "@/components/charts/3d/chart3d";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Badge, Card, CardContent, type BadgeVariant } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/client/api";
import type { TreeNode, Influencer } from "@/lib/engine/ai-visuals";
import { SUPPORTED_DAX_FUNCTIONS } from "@/lib/engine/dax";
import type { KpiResult } from "@/lib/engine/kpi";

export interface StudioColumn {
  name: string;
  type: string;
}

/**
 * ECharts (~1 MB) is loaded on demand: the chunk is fetched the first time a
 * visual actually renders, keeping the studio route bundle small.
 */
const PbiVisual = dynamic(() => import("@/components/charts/pbi-visual").then((m) => m.PbiVisual), {
  ssr: false,
  loading: () => <div aria-hidden className="w-full animate-pulse rounded-md bg-surface-2" style={{ height: 360 }} />,
});

// ---------------------------------------------------------------------------
// Shared response types (mirror the API routes)
// ---------------------------------------------------------------------------

interface KpiResponse {
  kpi: KpiResult;
  note: string;
}

interface DaxResponse {
  value?: unknown;
  series?: { category: string; value: unknown }[];
  note: string;
}

interface TreeResponse {
  tree: TreeNode;
  note: string;
}

interface InfluencersResponse {
  baseRate: number;
  totalRows: number;
  influencers: Influencer[];
  skippedColumns: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

const statusStyles: Record<string, BadgeVariant> = {
  onTrack: "success",
  needsAttention: "warning",
  offTrack: "critical",
  noTarget: "outline",
} as const;

const statusLabels: Record<KpiResult["current"]["status"], string> = {
  onTrack: "On track",
  needsAttention: "Needs attention",
  offTrack: "Off track",
  noTarget: "No target",
};

// ---------------------------------------------------------------------------
// KPI tab
// ---------------------------------------------------------------------------

function KpiTab({ datasetId, columns }: { datasetId: string; columns: StudioColumn[] }) {
  const numeric = columns.filter((c) => c.type === "number");
  const dates = columns.filter((c) => c.type === "date");

  const [measure, setMeasure] = useState(numeric[0]?.name ?? "");
  const [dateColumn, setDateColumn] = useState(dates[0]?.name ?? "");
  const [grain, setGrain] = useState<"day" | "month" | "quarter" | "year">("month");
  const [target, setTarget] = useState("");
  const [direction, setDirection] = useState<"increasing" | "decreasing">("increasing");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KpiResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await api<KpiResponse>(`/api/datasets/${datasetId}/kpi`, {
        method: "POST",
        body: JSON.stringify({
          measureColumn: measure,
          dateColumn: dateColumn || undefined,
          grain,
          target: target.trim() === "" ? undefined : Number(target),
          direction,
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

  const kpi = result?.kpi;
  const sparkline = kpi?.sparkline ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="grid grid-cols-1 items-end gap-4 lg:grid-cols-5">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Measure column</span>
            <select
              value={measure}
              onChange={(e) => setMeasure(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {numeric.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Date column</span>
            <select
              value={dateColumn}
              onChange={(e) => setDateColumn(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">No period (single card)</option>
              {dates.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Grain</span>
            <select
              value={grain}
              onChange={(e) => setGrain(e.target.value as typeof grain)}
              disabled={!dateColumn}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Target (optional)</span>
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. 1000"
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="block flex-1 text-sm">
              <span className="mb-1.5 block font-medium text-foreground">Direction</span>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as typeof direction)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              >
                <option value="increasing">↑ is good</option>
                <option value="decreasing">↓ is good</option>
              </select>
            </label>
            <Button onClick={run} disabled={!measure || running} loading={running}>
              {running ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              Compute
            </Button>
          </div>
        </div>
      </Card>

      {error ? <ErrorMessage title="KPI could not be computed" message={error} onRetry={run} /> : null}

      {kpi ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardContent>
              <div className="flex items-center justify-between">
                <p className="text-caption text-muted">Current period · {kpi.current.label}</p>
                <Badge variant={statusStyles[kpi.current.status] ?? "default"}>
                  {statusLabels[kpi.current.status]}
                </Badge>
              </div>
              <p className="mt-2 text-3xl font-semibold text-foreground">{fmt(kpi.current.value)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
                <span>Target: {fmt(kpi.current.target)}</span>
                <span>Attainment: {fmtPct(kpi.current.attainment)}</span>
                {kpi.current.changePct !== null ? (
                  <span className={kpi.current.changePct >= 0 ? "text-success" : "text-danger"}>
                    {kpi.current.changePct >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(kpi.current.changePct))} vs prior
                  </span>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardContent>
              <p className="text-caption text-muted">Trend by {grain}</p>
              {sparkline.length > 1 ? (
                <PbiVisual
                  height={180}
                  spec={{
                    kind: "ribbon",
                    categories: sparkline.map((s) => s.label),
                    values: [],
                    series: [{ name: measure, values: sparkline.map((s) => s.value) }],
                  }}
                />
              ) : (
                <p className="mt-4 text-sm text-muted">Need at least two periods for a trend — pick a coarser grain.</p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {result ? <p className="text-caption text-muted">{result.note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DAX tab
// ---------------------------------------------------------------------------

const DAX_EXAMPLES = [
  "SUM([Amount])",
  'CALCULATE(SUM([Amount]), [Region] = "East")',
  'DIVIDE(CALCULATE(SUM([Amount]), [Region] = "East"), CALCULATE(SUM([Amount]), ALL([Region])))',
  "TOTALYTD(SUM([Amount]), [Date])",
  "CALCULATE(SUM([Amount]), SAMEPERIODLASTYEAR([Date]))",
  "AVERAGEX(ALL(), [Amount] * [Qty])",
];

function DaxTab({ datasetId, columns }: { datasetId: string; columns: StudioColumn[] }) {
  const strings = columns.filter((c) => c.type !== "number");
  const [measure, setMeasure] = useState(`SUM([${numericFirst(columns)}])`);
  const [byCategory, setByCategory] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DaxResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await api<DaxResponse>(`/api/datasets/${datasetId}/dax`, {
        method: "POST",
        body: JSON.stringify({ measure, byCategory: byCategory || undefined }),
      });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const seriesData = useMemo(() => {
    if (!result?.series?.length) return null;
    return {
      categories: result.series.map((s) => s.category),
      values: result.series.map((s) => (typeof s.value === "number" ? s.value : 0)),
    };
  }, [result]);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-foreground">Measure expression (DAX-style)</span>
          <textarea
            value={measure}
            onChange={(e) => setMeasure(e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {DAX_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setMeasure(ex)}
              className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-muted hover:bg-surface-2"
            >
              {ex.length > 42 ? `${ex.slice(0, 42)}…` : ex}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Break out by (optional)</span>
            <select
              value={byCategory}
              onChange={(e) => setByCategory(e.target.value)}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Single value</option>
              {strings.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={run} disabled={!measure.trim() || running} loading={running}>
            {running ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
            Evaluate
          </Button>
        </div>
      </Card>

      {error ? <ErrorMessage title="Measure could not be evaluated" message={error} onRetry={run} /> : null}

      {result ? (
        <Card>
          <CardContent>
            {result.series ? (
              seriesData ? (
                <PbiVisual
                  spec={{
                    kind: "pareto",
                    title: `${measure} by ${byCategory}`,
                    categories: seriesData.categories,
                    values: seriesData.values,
                  }}
                />
              ) : null
            ) : (
              <>
                <p className="text-caption text-muted">Result</p>
                <p className="mt-1 text-3xl font-semibold text-foreground">{fmt(result.value)}</p>
              </>
            )}
            <p className="mt-3 text-caption text-muted">{result.note}</p>
          </CardContent>
        </Card>
      ) : null}

      <details className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-foreground">
          Supported functions ({SUPPORTED_DAX_FUNCTIONS.length})
        </summary>
        <p className="mt-2 font-mono text-xs leading-relaxed text-muted">{SUPPORTED_DAX_FUNCTIONS.join(" · ")}</p>
      </details>
    </div>
  );
}

function numericFirst(columns: StudioColumn[]): string {
  return columns.find((c) => c.type === "number")?.name ?? columns[0]?.name ?? "";
}

// ---------------------------------------------------------------------------
// AI visuals tab
// ---------------------------------------------------------------------------

type AiMode = "tree" | "influencers";

function AiVisualsTab({ datasetId, columns }: { datasetId: string; columns: StudioColumn[] }) {
  const numeric = columns.filter((c) => c.type === "number");
  const categoricals = columns.filter((c) => c.type !== "number");

  const [mode, setMode] = useState<AiMode>("tree");
  const [measureColumn, setMeasureColumn] = useState(numeric[0]?.name ?? "");
  const [levels, setLevels] = useState<string[]>(categoricals.slice(0, 2).map((c) => c.name));
  const [outcomeColumn, setOutcomeColumn] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [infl, setInfl] = useState<InfluencersResponse | null>(null);

  const runTree = async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await api<TreeResponse>(`/api/datasets/${datasetId}/ai-visuals`, {
        method: "POST",
        body: JSON.stringify({ mode: "tree", measureColumn, levels }),
      });
      setTree(data.tree);
    } catch (err) {
      setTree(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const runInfluencers = async () => {
    setRunning(true);
    setError(null);
    try {
      const data = await api<InfluencersResponse>(`/api/datasets/${datasetId}/ai-visuals`, {
        method: "POST",
        body: JSON.stringify({ mode: "influencers", outcomeColumn }),
      });
      setInfl(data);
    } catch (err) {
      setInfl(null);
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const toggleLevel = (name: string) => {
    setLevels((prev) => (prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name].slice(0, 4)));
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Visual</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as AiMode)}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="tree">Decomposition tree</option>
              <option value="influencers">Key influencers</option>
            </select>
          </label>

          {mode === "tree" ? (
            <>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Measure</span>
                <select
                  value={measureColumn}
                  onChange={(e) => setMeasureColumn(e.target.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                >
                  {numeric.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Levels (drill order, max 4)</span>
                <div className="flex flex-wrap gap-1.5">
                  {categoricals.slice(0, 8).map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => toggleLevel(c.name)}
                      aria-pressed={levels.includes(c.name)}
                      className={`rounded-full border px-2.5 py-1 text-xs ${levels.includes(c.name) ? "border-accent/40 bg-accent/10 text-accent-strong" : "border-line text-muted hover:bg-surface-2"}`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
              <Button onClick={runTree} disabled={!measureColumn || levels.length === 0 || running} loading={running}>
                {running ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <TreeDeciduous className="size-4" aria-hidden />
                )}
                Build tree
              </Button>
            </>
          ) : (
            <>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Outcome column (boolean / yes-no)</span>
                <select
                  value={outcomeColumn}
                  onChange={(e) => setOutcomeColumn(e.target.value)}
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                >
                  <option value="">Choose…</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button onClick={runInfluencers} disabled={!outcomeColumn || running} loading={running}>
                {running ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-4" aria-hidden />
                )}
                Find influencers
              </Button>
            </>
          )}
        </div>
      </Card>

      {error ? (
        <ErrorMessage
          title="Analysis could not run"
          message={error}
          onRetry={mode === "tree" ? runTree : runInfluencers}
        />
      ) : null}

      {mode === "tree" && tree ? (
        <Card>
          <CardContent>
            <p className="text-caption text-muted">
              Root total {fmt(tree.value)} · children ranked by contribution contrast
            </p>
            {/* The 3D mirror renders exactly the engine's tree; the 2D drill
                list stays below for accessible, copyable numbers. */}
            <div className="mb-4">
              <Tree3D tree={tree} />
            </div>
            <TreeView node={tree} />
          </CardContent>
        </Card>
      ) : null}

      {mode === "influencers" && infl ? (
        <Card>
          <CardContent>
            <p className="text-caption text-muted">
              Base rate {fmtPct(infl.baseRate)} across {infl.totalRows.toLocaleString()} rows
              {infl.skippedColumns.length ? ` · skipped: ${infl.skippedColumns.join(", ")}` : ""}
            </p>
            {infl.influencers.length === 0 ? (
              <p className="mt-3 text-sm text-muted">
                No group had enough rows — lower the minimum or pick a different outcome column.
              </p>
            ) : (
              <>
                <div className="mb-4">
                  <Influencers3D result={infl} />
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-caption text-muted">
                        <th className="py-2 pr-4 font-medium">Column</th>
                        <th className="py-2 pr-4 font-medium">Value</th>
                        <th className="py-2 pr-4 font-medium">Likelihood</th>
                        <th className="py-2 pr-4 font-medium">95% CI</th>
                        <th className="py-2 pr-4 font-medium">Lift</th>
                        <th className="py-2 pr-4 font-medium">Rows</th>
                        <th className="py-2 font-medium">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {infl.influencers.slice(0, 15).map((i, k) => (
                        <tr key={`${i.category}-${i.value}-${k}`} className="border-b border-line/60 last:border-0">
                          <td className="py-2 pr-4 font-medium text-foreground">{i.category}</td>
                          <td className="py-2 pr-4">{i.value || "—"}</td>
                          <td className="py-2 pr-4">{fmtPct(i.likelihood)}</td>
                          <td className="py-2 pr-4 text-muted">
                            [{fmtPct(i.ciLow)}, {fmtPct(i.ciHigh)}]
                          </td>
                          <td className={`py-2 pr-4 font-medium ${i.lift >= 1 ? "text-success" : "text-danger"}`}>
                            {i.lift.toFixed(2)}×
                          </td>
                          <td className="py-2 pr-4 text-muted">{i.count}</td>
                          <td className="py-2">
                            <Badge
                              variant={
                                i.strength === "strong" ? "success" : i.strength === "moderate" ? "info" : "outline"
                              }
                            >
                              {i.strength}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="mt-3 text-caption text-muted">{infl.note}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * WebGL mirrors for the AI visuals (S5), routed through the shared Chart3D
 * gate: client-only lazy chunk, mounted only when WebGL exists, error
 * boundary → 2D fallback (null). The 2D table/list below stays the canonical
 * view, exactly like every other data scene — the 3D only mirrors it.
 */
function Tree3D({ tree }: { tree: TreeNode }) {
  return (
    <Chart3D
      spec={{ kind: "decomposition-tree", title: "Decomposition tree", series: [], aiTree: tree }}
      height={360}
    />
  );
}
function Influencers3D({ result }: { result: InfluencersResponse }) {
  return (
    <Chart3D
      spec={{
        kind: "key-influencers",
        title: "Key influencers",
        series: [],
        aiInfluencers: {
          baseRate: result.baseRate,
          totalRows: result.totalRows,
          influencers: result.influencers,
          skippedColumns: result.skippedColumns,
        },
      }}
      height={320}
    />
  );
}
function TreeView({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  return (
    <div className={depth === 0 ? "" : "ml-4 border-l border-line pl-3"}>
      <div className="flex items-center gap-2 py-1">
        <span className={`font-medium ${depth === 0 ? "text-foreground" : "text-sm text-foreground"}`}>
          {node.label}
        </span>
        <span className="text-sm text-muted">{fmt(node.value)}</span>
        {depth > 0 ? <span className="text-caption text-muted">({fmtPct(node.shareOfParent)} of parent)</span> : null}
        <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, node.shareOfParent * 100)}%` }}
          />
        </div>
      </div>
      {node.children.slice(0, 8).map((child) => (
        <TreeView key={`${child.levelColumn}-${child.label}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function PowerBiStudioPanel({
  datasetId,
  datasetName,
  columns,
}: {
  datasetId: string;
  datasetName: string;
  columns: StudioColumn[];
}) {
  const [tab, setTab] = useState("kpi");
  const numericCount = columns.filter((c) => c.type === "number").length;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-muted">
          {datasetName} · {numericCount} numeric column{numericCount === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <Badge variant="outline">
          <Gauge className="mr-1 inline size-3.5" aria-hidden /> Deterministic engines · no LLM in the numeric path
        </Badge>
      </div>

      <Tabs
        items={[
          {
            key: "kpi",
            label: (
              <>
                <Target className="mr-1.5 inline size-4" aria-hidden />
                KPI scorecard
              </>
            ),
          },
          {
            key: "dax",
            label: (
              <>
                <BarChart3 className="mr-1.5 inline size-4" aria-hidden />
                DAX measures
              </>
            ),
          },
          {
            key: "ai",
            label: (
              <>
                <FlaskConical className="mr-1.5 inline size-4" aria-hidden />
                AI visuals
              </>
            ),
          },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === "kpi" ? <KpiTab datasetId={datasetId} columns={columns} /> : null}
      {tab === "dax" ? <DaxTab datasetId={datasetId} columns={columns} /> : null}
      {tab === "ai" ? <AiVisualsTab datasetId={datasetId} columns={columns} /> : null}
    </div>
  );
}

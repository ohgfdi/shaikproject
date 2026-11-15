"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChartRenderer, CalcExplainer } from "@/components/charts/chart";
import { Button } from "@/components/ui/button";
import { DemoBadge, ErrorMessage } from "@/components/ui/feedback";
import { Select, Input } from "@/components/ui/form";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { AnalysisResult, ChartSpec, ColType, Granularity, NumberFormatSetting } from "@/lib/types";
import { cn } from "@/lib/utils";

export type StudioKind =
  | "line"
  | "area"
  | "bar"
  | "stacked-bar"
  | "donut"
  | "scatter"
  | "histogram"
  | "box"
  | "heatmap"
  | "funnel"
  | "waterfall"
  | "kpi"
  | "geographic";

const KIND_OPTIONS: { value: StudioKind; label: string; hint: string }[] = [
  { value: "line", label: "Line", hint: "trend over time" },
  { value: "area", label: "Area", hint: "volume over time" },
  { value: "bar", label: "Bar", hint: "compare groups" },
  { value: "stacked-bar", label: "Stacked bar", hint: "groups over time" },
  { value: "donut", label: "Donut", hint: "share of total" },
  { value: "kpi", label: "KPI", hint: "headline numbers" },
  { value: "scatter", label: "Scatter", hint: "two metrics" },
  { value: "histogram", label: "Histogram", hint: "value spread" },
  { value: "box", label: "Box plot", hint: "distribution" },
  { value: "heatmap", label: "Heatmap", hint: "group × time" },
  { value: "funnel", label: "Funnel", hint: "conversion steps" },
  { value: "waterfall", label: "Waterfall", hint: "change decomposition" },
  { value: "geographic", label: "Geo (bar view)", hint: "region totals" },
];

interface StudioColumn {
  name: string;
  type: ColType;
}
interface StudioDataset {
  id: string;
  name: string;
  rowCount: number;
  isDemo: boolean;
  columns: StudioColumn[];
}
interface MetaEntry {
  type: string;
  values: { value: string; count: number }[];
  minDate?: string;
  maxDate?: string;
}
interface StudioResponse {
  chart: ChartSpec;
  configHuman: string[];
  methodology: { method: string; steps: string[]; assumptions: string[] };
  qualityWarnings: string[];
  isDemoLogic: boolean;
}

export function StudioPanel({
  datasets,
  numStyle = "comma",
}: {
  datasets: StudioDataset[];
  numStyle?: NumberFormatSetting;
}) {
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [kind, setKind] = useState<StudioKind>("line");
  const [metric, setMetric] = useState("");
  const [metric2, setMetric2] = useState("");
  const [dimension, setDimension] = useState("");
  const [date, setDate] = useState("");
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [filterCol, setFilterCol] = useState("");
  const [filterValues, setFilterValues] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, MetaEntry>>({});
  const [out, setOut] = useState<StudioResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const debounce = useRef<number | null>(null);

  const dataset = datasets.find((d) => d.id === datasetId);
  const columns = useMemo(() => dataset?.columns ?? [], [dataset]);
  const byType = useCallback((t: ColType) => columns.filter((c) => c.type === t), [columns]);
  const numCols = byType("number");
  const strCols = byType("string");
  const dateCols = byType("date");
  const needsMetric2 = kind === "scatter";
  const useDate = ["line", "area", "bar", "stacked-bar", "heatmap", "waterfall", "kpi"].includes(kind);
  const useDim = !["scatter", "histogram"].includes(kind);

  // Sensible defaults whenever the dataset changes
  useEffect(() => {
    setMetric(numCols[0]?.name ?? "");
    setMetric2(numCols[1]?.name ?? numCols[0]?.name ?? "");
    setDimension(strCols[0]?.name ?? "");
    setDate(dateCols[0]?.name ?? "");
    setFilterCol(strCols[0]?.name ?? "");
    setFilterValues([]);
    setFrom("");
    setTo("");
    setOut(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Filter metadata (top values + date bounds) for the selected dataset
  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    const cols = [...strCols.slice(0, 8).map((c) => c.name), ...dateCols.slice(0, 2).map((c) => c.name)];
    api<{ meta: Record<string, MetaEntry> }>("/api/studio/meta", {
      method: "POST",
      body: JSON.stringify({ datasetId: dataset.id, columns: cols }),
    })
      .then((res) => {
        if (cancelled) return;
        setMeta(res.meta);
        setFrom((f) => f || (res.meta[dateCols[0]?.name ?? ""]?.minDate ?? ""));
        setTo((t) => t || (res.meta[dateCols[0]?.name ?? ""]?.maxDate ?? ""));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Debounced server computation — every control change flows through here
  useEffect(() => {
    if (!dataset) return;
    if (debounce.current) window.clearTimeout(debounce.current);
    const t = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<StudioResponse>("/api/studio", {
          method: "POST",
          body: JSON.stringify({
            datasetId: dataset.id,
            chartKind: kind,
            metric: metric || undefined,
            metric2: metric2 || undefined,
            dimension: dimension || undefined,
            date: date || undefined,
            granularity,
            from: rangeEnabled ? from || undefined : undefined,
            to: rangeEnabled ? to || undefined : undefined,
            filterCol: filterEnabled && filterValues.length > 0 ? filterCol : undefined,
            filterValues: filterEnabled ? filterValues : undefined,
          }),
        });
        setOut(res);
      } catch (err) {
        setError(errorMessage(err));
        setOut(null);
      } finally {
        setLoading(false);
      }
    }, 240);
    debounce.current = t;
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [
    datasetId,
    kind,
    metric,
    metric2,
    dimension,
    date,
    granularity,
    rangeEnabled,
    from,
    to,
    filterEnabled,
    filterCol,
    filterValues,
    dataset,
    tick,
  ]);

  const refresh = () => setTick((x) => x + 1);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <section aria-label="Chart controls" className="xl:col-span-1">
        <Card className="flex flex-col gap-4 p-4">
          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">Dataset</p>
            <select
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.rowCount.toLocaleString()} rows)
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-foreground">Chart type</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setKind(k.value)}
                  aria-pressed={kind === k.value}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left text-caption transition-colors",
                    kind === k.value
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-line text-muted hover:bg-surface-2",
                  )}
                >
                  <span className="block font-medium">{k.label}</span>
                  <span className="block truncate text-muted/70">{k.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            {numCols.length > 0 && (
              <Select
                label="Metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                options={numCols.map((c) => ({ value: c.name, label: c.name }))}
              />
            )}
            {needsMetric2 && numCols.length > 1 && (
              <Select
                label="Second metric"
                value={metric2}
                onChange={(e) => setMetric2(e.target.value)}
                options={numCols.map((c) => ({ value: c.name, label: c.name }))}
              />
            )}
            {useDim && strCols.length > 0 && (
              <Select
                label="Dimension"
                value={dimension}
                onChange={(e) => setDimension(e.target.value)}
                options={strCols.map((c) => ({ value: c.name, label: c.name }))}
              />
            )}
            {useDate && dateCols.length > 0 && (
              <Select
                label="Date column"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
              />
            )}
            {useDate && dateCols.length > 0 && (
              <Select
                label="Granularity"
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as Granularity)}
                options={["day", "week", "month", "quarter", "year"].map((g) => ({ value: g, label: g }))}
              />
            )}
          </div>

          <div className="border-t border-line pt-3">
            <p className="mb-2 text-sm font-medium text-foreground">Filters</p>
            <Toggle label="Limit date range" checked={rangeEnabled} onChange={setRangeEnabled} />
            {rangeEnabled && dateCols.length > 0 && (
              <div className="mb-3 grid grid-cols-2 gap-2">
                <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            )}
            <Toggle label="Filter by category values" checked={filterEnabled} onChange={setFilterEnabled} />
            {filterEnabled && strCols.length > 0 && (
              <div className="mt-2">
                <Select
                  label="Filter column"
                  value={filterCol}
                  onChange={(e) => {
                    setFilterCol(e.target.value);
                    setFilterValues([]);
                  }}
                  options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(meta[filterCol]?.values ?? []).slice(0, 24).map((v) => (
                    <button
                      key={v.value}
                      onClick={() =>
                        setFilterValues((f) => (f.includes(v.value) ? f.filter((x) => x !== v.value) : [...f, v.value]))
                      }
                      aria-pressed={filterValues.includes(v.value)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-caption transition-colors",
                        filterValues.includes(v.value)
                          ? "border-accent bg-accent/15 text-foreground"
                          : "border-line text-muted hover:bg-surface-2",
                      )}
                    >
                      {v.value}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-caption text-muted">
                  {meta[filterCol]?.values?.length
                    ? `Top ${Math.min(24, meta[filterCol]?.values?.length ?? 0)} values by frequency.`
                    : "Scanning values…"}
                </p>
              </div>
            )}
          </div>

          <Button
            variant="secondary"
            onClick={refresh}
            loading={loading}
            icon={<RefreshCw aria-hidden className="size-4" />}
          >
            Refresh chart
          </Button>
        </Card>
      </section>

      <section aria-label="Chart preview" className="xl:col-span-2">
        {error && (
          <ErrorMessage
            title="Could not build this chart"
            message={error}
            howToFix="Some chart types need specific columns (check the hints). Adjust the controls and try again."
            onRetry={refresh}
            className="mb-4"
          />
        )}
        {loading && !out && <div className="card skeleton h-[320px]" />}
        {out && (
          <div className="flex flex-col gap-3">
            <Card className="p-4">
              <div className="mb-2 flex justify-end">
                {out.isDemoLogic && (
                  <DemoBadge tooltip="Geographic tiles are a live-service feature — showing the same totals as bars." />
                )}
              </div>
              <ChartRenderer spec={out.chart} numStyle={numStyle} height={340} />
              {out.qualityWarnings.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5">
                  {out.qualityWarnings.map((w, i) => (
                    <p
                      key={i}
                      className="rounded border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-caption text-muted"
                    >
                      {w}
                    </p>
                  ))}
                </div>
              )}
            </Card>
            <CalcExplainerForStudio out={out} />
          </div>
        )}
        {!out && !loading && (
          <Card>
            <p className="px-4 py-12 text-center text-sm text-muted">
              {dataset
                ? "Adjust the controls — the chart computes live from your uploaded data."
                : "Pick a dataset to start building."}
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded accent-[#5AA8AA]"
      />
      {label}
    </label>
  );
}

function CalcExplainerForStudio({ out }: { out: StudioResponse }) {
  const pseudo = {
    kind: "eda" as const,
    title: out.chart.title,
    dataset: { name: "Visualization Studio", id: "", rowCount: 0, columns: [] },
    scope: { rowsUsed: 0, totalRows: 0, sampled: false, filters: [] },
    configHuman: out.configHuman,
    methodology: out.methodology,
    qualityWarnings: out.qualityWarnings,
    charts: [out.chart],
  } as unknown as AnalysisResult;
  return <CalcExplainer result={pseudo} label="How was this calculated?" />;
}

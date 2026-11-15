/**
 * Pure `ChartSpec -> EChartsOption` mapper for the headless-Chromium renderer.
 *
 * `ChartSpec` is a *domain* model (`{ kind, categories, series:[{name,data}] }`),
 * not an ECharts option — it has no `type` per series and no axes. The renderer
 * used to `JSON.stringify` the spec straight into `chart.setOption(...)`, which
 * produced a blank canvas for every chart in every exported PDF while still
 * returning HTTP 200. This module is the missing adapter.
 *
 * Kinds that genuinely cannot be drawn on a canvas return `null` so the caller
 * falls back to the honest labelled-data-table renderer in
 * `lib/export/svg-chart.ts` — the same degradation pattern the HTML export
 * already uses. Never a silent empty frame.
 *
 * Dependency-free: safe to import from a node test environment.
 */

import { boxStats, type EChartsOption } from "@/lib/engine/pbi-echarts";
import type { ChartKind, ChartSeries, ChartSpec, VisualFormat } from "@/lib/types";

/** Kinds this mapper draws on an ECharts canvas. */
const CANVAS_KINDS = new Set<ChartKind>([
  "line",
  "area",
  "bar",
  "stacked-bar",
  "donut",
  "scatter",
  "histogram",
  "box",
  "heatmap",
  "funnel",
  "waterfall",
  "pivot",
]);

/**
 * Kinds with no canvas representation here. `kpi` renders as HTML cards,
 * `map` needs Leaflet tiles, and the AI visuals are bespoke DOM trees — all
 * three fall back to a labelled table rather than an empty canvas.
 */
const NON_CANVAS_KINDS = new Set<ChartKind>(["kpi", "map", "decomposition-tree", "key-influencers"]);

export function isCanvasChartKind(kind: string): kind is ChartKind {
  return CANVAS_KINDS.has(kind as ChartKind);
}

/** True when a fallback (non-canvas) renderer is the honest choice. */
export function isNonCanvasChartKind(kind: string): kind is ChartKind {
  return NON_CANVAS_KINDS.has(kind as ChartKind);
}

const PALETTE = ["#5AA8AA", "#FFB400", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"];

function axisName(spec: ChartSpec): string[] {
  return spec.categories ?? [];
}

/** Shared title/tooltip/legend scaffolding. */
function baseOption(spec: ChartSpec, tooltipTrigger: "item" | "axis" = "axis"): EChartsOption {
  const showLegend = spec.series.length > 1;
  return {
    title: spec.title
      ? {
          text: spec.title,
          subtext: spec.subtitle,
          left: "center",
          textStyle: { fontSize: 14 },
          subtextStyle: { fontSize: 11 },
        }
      : undefined,
    tooltip: { trigger: tooltipTrigger },
    legend: showLegend ? { data: spec.series.map((s) => s.name), bottom: 0, type: "scroll" } : undefined,
    grid: { left: 56, right: 24, top: spec.title ? 52 : 24, bottom: showLegend ? 40 : 28 },
    color: PALETTE,
  };
}

/** Cartesian x/y axis pair with axis-name wiring. */
function cartesian(spec: ChartSpec, yAxisExtra: Record<string, unknown> = {}) {
  return {
    xAxis: { type: "category", data: axisName(spec), name: spec.xLabel ?? "", nameGap: 24 },
    yAxis: { type: "value", name: spec.yLabel ?? spec.unit ?? "", ...yAxisExtra },
  };
}

/** Stacked variants must set `stack` per series or ECharts overlays them. */
function withStack(series: ChartSeries[], stackName: string): ChartSeries[] {
  return series.map((s) => ({ ...s, stack: stackName }));
}

/**
 * Build the ECharts option for a chart spec.
 *
 * `format` (ROADMAP 3.4) carries report-grade formatting from the widget:
 * data labels, a constant reference line and a palette override. Only kinds
 * with a cartesian/pie representation honor them — a control the chart type
 * cannot draw is never silently accepted.
 *
 * Returns `null` when the kind has no canvas representation — the caller must
 * then render the honest fallback rather than an empty frame.
 */
export function chartSpecToECharts(spec: ChartSpec, format?: VisualFormat): EChartsOption | null {
  if (!spec || typeof spec !== "object" || typeof spec.kind !== "string") return null;
  if (!isCanvasChartKind(spec.kind)) return null;

  const base = baseOption(spec);
  const series = Array.isArray(spec.series) ? spec.series : [];

  // ROADMAP 3.4: palette override feeds ECharts' color list.
  if (format?.palette?.length) base.color = format.palette;
  /** Data labels where the series type supports them. */
  const labels = () =>
    format?.dataLabels ? { label: { show: true, position: "top" as const, formatter: "{c}" } } : {};
  /** Constant reference line via markLine on the value axis. */
  const refLine = () =>
    format?.referenceLine
      ? {
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: format.referenceLine.color ?? "#c62828", type: "dashed", width: 1.5 },
            label: {
              position: "insideEndTop",
              formatter: format.referenceLine.label ?? String(format.referenceLine.value),
            },
            data: [{ yAxis: format.referenceLine.value }],
          },
        }
      : {};

  // A spec with no categories AND no series has nothing to draw. Returning null
  // routes it to the labelled-table fallback, which states that honestly.
  const hasData =
    axisName(spec).length > 0 ||
    series.some((s) => (s.data?.length ?? 0) > 0 || (s.points?.length ?? 0) > 0 || (s.box?.length ?? 0) > 0);
  if (!hasData) return null;

  switch (spec.kind) {
    case "line":
    case "area":
      return {
        ...base,
        ...cartesian(spec),
        series: series.map((s) => ({
          name: s.name,
          type: "line",
          data: s.data ?? [],
          smooth: true,
          connectNulls: true,
          ...(s.color ? { itemStyle: { color: s.color }, lineStyle: { color: s.color } } : {}),
          ...(spec.kind === "area" ? { areaStyle: { opacity: 0.25 } } : {}),
          ...labels(),
          ...refLine(),
        })),
      };

    case "bar":
    case "histogram":
      return {
        ...base,
        ...cartesian(spec),
        series: series.map((s, i) => ({
          name: s.name,
          type: "bar",
          data: s.data ?? [],
          ...(s.color ? { itemStyle: { color: s.color } } : {}),
          ...(spec.kind === "histogram" ? { barCategoryGap: "0%" } : {}),
          ...labels(),
          // The constant line lives on ONE series; the first keeps it.
          ...(i === 0 ? refLine() : {}),
        })),
      };

    case "stacked-bar":
      return {
        ...base,
        ...cartesian(spec),
        series: withStack(series, "total").map((s) => ({
          name: s.name,
          type: "bar",
          stack: "total",
          data: s.data ?? [],
          ...(s.color ? { itemStyle: { color: s.color } } : {}),
        })),
      };

    case "donut": {
      // A donut is a single ring: series[0]'s values, categories as labels.
      const first = series[0];
      const data = (first?.data ?? []).map((v, i) => ({
        name: axisName(spec)[i] ?? `Item ${i + 1}`,
        value: v ?? 0,
      }));
      return {
        ...base,
        tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
        ...(format?.palette?.length ? { color: format.palette } : {}),
        series: [
          {
            type: "pie",
            radius: ["45%", "72%"],
            center: ["50%", "52%"],
            avoidLabelOverlap: true,
            label: { show: true },
            data,
          },
        ],
      };
    }

    case "scatter": {
      const points = series.flatMap((s) => (s.points ?? []).map((p) => [p.x, p.y, p.label ?? s.name]));
      return {
        ...base,
        tooltip: { trigger: "item" },
        xAxis: { type: "value", name: spec.xLabel ?? "", scale: true },
        yAxis: { type: "value", name: spec.yLabel ?? spec.unit ?? "", scale: true },
        series: series.map((s) => ({
          name: s.name,
          type: "scatter",
          data: (s.points ?? []).map((p) => [p.x, p.y]),
          ...(s.color ? { itemStyle: { color: s.color } } : {}),
        })),
        ...(points.length === 0 ? {} : {}),
      };
    }

    case "box":
      return {
        ...base,
        xAxis: { type: "category", data: axisName(spec) },
        yAxis: { type: "value", name: spec.yLabel ?? spec.unit ?? "" },
        series: [
          {
            name: "distribution",
            type: "boxplot",
            data: series.length ? (series[0]!.box ?? series[0]!.data?.map((v) => [v ?? 0]) ?? []) : [],
            tooltip: { trigger: "item" },
          },
        ],
      };

    case "heatmap": {
      // `rowLabels` labels the y axis; values are read row-major.
      const rows = spec.rowLabels ?? [];
      const first = series[0];
      const values = first?.data ?? [];
      const cells = rows.flatMap((_, r) =>
        axisName(spec).map((_, c) => [c, r, values[r * axisName(spec).length + c] ?? null]),
      );
      return {
        ...base,
        tooltip: { trigger: "item" },
        xAxis: { type: "category", data: axisName(spec), name: spec.xLabel ?? "", nameGap: 24 },
        yAxis: { type: "category", data: rows, name: spec.yLabel ?? "" },
        visualMap: {
          min: Math.min(...values.filter((v): v is number => typeof v === "number"), 0),
          max: Math.max(...values.filter((v): v is number => typeof v === "number"), 1),
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
        },
        grid: { left: 56, right: 24, top: spec.title ? 52 : 24, bottom: 64 },
        series: [{ type: "heatmap", data: cells, label: { show: true } }],
      };
    }

    case "funnel":
      return {
        ...base,
        tooltip: { trigger: "item" },
        series: [
          {
            type: "funnel",
            left: "10%",
            width: "80%",
            top: spec.title ? 60 : 20,
            bottom: 20,
            sort: "descending",
            gap: 2,
            label: { show: true, position: "inside", formatter: "{b}: {c}" },
            data: axisName(spec).map((c, i) => ({ name: c, value: series[0]?.data?.[i] ?? 0 })),
          },
        ],
      };

    case "waterfall": {
      // Mirror of the PBI waterfall: a transparent helper series places each
      // bar at its running total. `series[i].totals` marks indices that are
      // already totals rather than deltas.
      const values = series[0]?.data ?? [];
      const totals = new Set(series[0]?.totals ?? []);
      const helper: (number | null)[] = [];
      let running = 0;
      values.forEach((v, i) => {
        const n = v ?? 0;
        if (totals.has(i)) {
          running = n;
          helper.push(null);
          return;
        }
        helper.push(n >= 0 ? running : running + n);
        running += n;
      });
      return {
        ...base,
        ...cartesian(spec),
        series: [
          {
            name: "base",
            type: "bar",
            stack: "w",
            itemStyle: { color: "transparent" },
            data: helper,
            silent: true,
            emphasis: { disabled: true },
          },
          {
            name: series[0]?.name ?? "change",
            type: "bar",
            stack: "w",
            barGap: "-100%",
            data: values.map((v, i) => {
              const n = v ?? 0;
              return {
                value: totals.has(i) ? n : Math.abs(n),
                itemStyle: { color: totals.has(i) ? "#374151" : n >= 0 ? "#2e7d32" : "#c62828" },
              };
            }),
            ...(format?.dataLabels ? { label: { show: true, position: "inside" as const, formatter: "{c}" } } : {}),
            ...refLine(),
          },
        ],
      };
    }

    case "pivot": {
      // A pivot snapshot is a heatmap: rowLabels x categories.
      const rows = spec.rowLabels ?? [];
      const cols = axisName(spec);
      const values = series.flatMap((s) => s.data ?? []);
      const cells = rows.flatMap((_, r) => cols.map((_, c) => [c, r, values[r * cols.length + c] ?? null]));
      return {
        ...base,
        tooltip: { trigger: "item" },
        xAxis: { type: "category", data: cols },
        yAxis: { type: "category", data: rows },
        visualMap: {
          min: Math.min(...values.filter((v): v is number => typeof v === "number"), 0),
          max: Math.max(...values.filter((v): v is number => typeof v === "number"), 1),
          calculable: true,
        },
        grid: { left: 96, right: 24, top: spec.title ? 52 : 24, bottom: 64 },
        series: [{ type: "heatmap", data: cells, label: { show: true } }],
      };
    }

    default:
      return null;
  }
}

/** Re-exported so callers get box-quartile parity without a second import. */
export { boxStats };

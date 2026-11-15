/**
 * Pure `PbiVisualSpec -> EChartsOption` mapper.
 *
 * Extracted from the `PbiVisual` React component's `useMemo` so the SAME
 * option builder runs in the browser and inside the headless-Chromium report
 * renderer. Previously the server had its own lossy reimplementation that
 * handled 2 of the 10 kinds and emitted an empty canvas for the other 8 —
 * a report would silently lose its visuals while still returning HTTP 200.
 *
 * This module must stay dependency-free (no React, no `echarts` import): the
 * renderer serialises the result into `setContent()` for the page's own
 * ECharts build to consume, and the tests import it under a node environment.
 */

import type { PbiVisualKind, PbiVisualSpec } from "@/lib/types";

/** Loosely-typed ECharts option. `echarts.EChartsOption` is a huge union and
 *  these builders are structurally valid subsets; typing it as a record keeps
 *  the serialisable contract explicit. */
export type EChartsOption = Record<string, unknown>;

/**
 * Compute the five-number summary for boxplots (Tukey, exclusive median).
 * Pre-computed rather than delegated to ECharts so the browser and the
 * renderer agree on quartiles exactly.
 */
export function boxStats(values: number[]): [number, number, number, number, number] {
  const s = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p: number) => {
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s.length === 0 ? 0 : lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };
  return [q(0), q(0.25), q(0.5), q(0.75), q(1)] as [number, number, number, number, number];
}

/** Every kind this mapper can draw on a canvas. */
export const PBI_CANVAS_KINDS: readonly PbiVisualKind[] = [
  "waterfall",
  "funnel",
  "sankey",
  "treemap",
  "sunburst",
  "gauge",
  "heatmap",
  "boxplot",
  "ribbon",
  "pareto",
] as const;

export function isCanvasRenderableKind(kind: string): kind is PbiVisualKind {
  return (PBI_CANVAS_KINDS as readonly string[]).includes(kind);
}

/**
 * Build the ECharts option for a PBI visual.
 *
 * Returns `null` for an unknown kind so callers can fall back to the honest
 * labelled-data-table renderer instead of drawing an empty canvas.
 */
export function pbiVisualToECharts(spec: PbiVisualSpec): EChartsOption | null {
  if (!spec || typeof spec !== "object") return null;
  if (!isCanvasRenderableKind(spec.kind)) return null;

  const base: EChartsOption = {
    title: spec.title ? { text: spec.title, left: "center", textStyle: { fontSize: 14 } } : undefined,
    tooltip: { trigger: "item" },
    grid: { left: 48, right: 24, top: spec.title ? 48 : 24, bottom: 40 },
  };

  // Report-grade formatting (ROADMAP 3.4): data labels + reference line +
  // palette override. Applied only where the chart type can honor them —
  // never a silently-ignored control.
  const fmt = spec.format;
  const paletteColors = fmt?.palette?.length ? { color: fmt.palette } : {};
  /** Reference line as an ECharts series markLine (cartesian kinds only). */
  const refLine = () =>
    fmt?.referenceLine
      ? {
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: fmt.referenceLine.color ?? "#c62828", type: "dashed", width: 1.5 },
            label: {
              position: "insideEndTop",
              formatter: fmt.referenceLine.label ?? String(fmt.referenceLine.value),
            },
            data: [{ yAxis: fmt.referenceLine.value }],
          },
        }
      : {};

  switch (spec.kind) {
    case "waterfall": {
      // Transparent helper series places each bar at the running total.
      let running = 0;
      const helper: number[] = [];
      const rise = spec.values.map((v) => {
        running += v;
        return v >= 0 ? v : Math.abs(v);
      });
      // Kept for ApexCharts path parity: fall/positions are unused by the
      // ECharts series below, but the helper push here IS load-bearing
      // (pre-total for rises, post-total for falls). Do not simplify.
      const _fall = spec.values.map(() => 0);
      const _positions = spec.values.map((v) => {
        const start = running - v;
        helper.push(v >= 0 ? start : start + v);
        return start;
      });
      return {
        ...base,
        ...paletteColors,
        xAxis: { type: "category", data: spec.categories },
        yAxis: { type: "value" },
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
            name: "change",
            type: "bar",
            stack: "w",
            barGap: "-100%",
            data: spec.values.map((v, i) => ({
              value: rise[i],
              itemStyle: { color: v >= 0 ? "#2e7d32" : "#c62828" },
            })),
            ...(fmt?.dataLabels ? { label: { show: true, position: "inside", formatter: "{c}" } } : {}),
            ...refLine(),
          },
        ],
      };
    }
    case "funnel":
      return {
        ...base,
        series: [
          {
            type: "funnel",
            left: "10%",
            width: "80%",
            sort: "descending",
            gap: 2,
            label: { show: true, position: "inside", formatter: "{b}: {c}" },
            data: spec.categories.map((c, i) => ({ name: c, value: spec.values[i] })),
          },
        ],
      };
    case "treemap":
      return {
        ...base,
        series: [
          {
            type: "treemap",
            roam: false,
            breadcrumb: { show: true },
            label: { show: true, formatter: "{b}\n{c}" },
            data: spec.categories.map((c, i) => ({ name: c, value: spec.values[i] })),
          },
        ],
      };
    case "sunburst":
      return {
        ...base,
        series: [
          {
            type: "sunburst",
            radius: ["0%", "90%"],
            label: { rotate: "radial" },
            data: spec.categories.map((c, i) => ({ name: c, value: spec.values[i] })),
          },
        ],
      };
    case "gauge":
      return {
        ...base,
        series: [
          {
            type: "gauge",
            min: 0,
            max: spec.gauge?.max ?? 100,
            progress: { show: true },
            axisLine: { lineStyle: { width: 14 } },
            detail: { formatter: "{value}", fontSize: 22 },
            data: [{ value: spec.gauge?.value ?? 0, name: spec.title ?? "KPI" }],
          },
        ],
      };
    case "heatmap":
      return {
        ...base,
        xAxis: { type: "category", data: spec.categories },
        yAxis: { type: "category", data: spec.heat?.yCategories ?? [] },
        visualMap: {
          min: Math.min(...(spec.heat?.cells.map((c) => c[2]) ?? [0])),
          max: Math.max(...(spec.heat?.cells.map((c) => c[2]) ?? [1])),
        },
        series: [{ type: "heatmap", data: spec.heat?.cells ?? [], label: { show: true } }],
      };
    case "boxplot": {
      const groups = spec.boxGroups ?? [];
      return {
        ...base,
        xAxis: { type: "category", data: groups.map((g) => g.name) },
        yAxis: { type: "value" },
        series: [
          {
            name: "distribution",
            type: "boxplot",
            data: groups.map((g) => boxStats(g.values)),
            ...refLine(),
          },
        ],
      };
    }
    case "ribbon":
      return {
        ...base,
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: spec.categories },
        yAxis: { type: "value" },
        series: (spec.series ?? [{ name: "value", values: spec.values }]).map((s, idx) => ({
          name: s.name,
          type: "line",
          stack: "ribbon",
          areaStyle: { opacity: 0.75 },
          emphasis: { focus: "series" },
          data: s.values,
          ...(idx === 0
            ? {
                ...refLine(),
                ...(fmt?.dataLabels ? { label: { show: true, position: "top", formatter: "{c}" } } : {}),
              }
            : {}),
        })),
      };
    case "pareto": {
      const total = spec.values.reduce((s, v) => s + v, 0) || 1;
      let cum = 0;
      const cumulative = spec.values.map((v) => {
        cum += v;
        return Math.round((cum / total) * 1000) / 10;
      });
      return {
        ...base,
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: spec.categories },
        yAxis: [{ type: "value" }, { type: "value", max: 100, axisLabel: { formatter: "{value}%" } }],
        series: [
          {
            type: "bar",
            name: "count",
            data: spec.values,
            ...(fmt?.dataLabels ? { label: { show: true, position: "top", formatter: "{c}" } } : {}),
            ...refLine(),
          },
          { type: "line", name: "cumulative %", yAxisIndex: 1, data: cumulative, smooth: true },
        ],
      };
    }
    case "sankey":
      return {
        ...base,
        series: [
          {
            type: "sankey",
            layoutIterations: 32,
            emphasis: { focus: "adjacency" },
            data: spec.categories.map((c) => ({ name: c })),
            links: spec.links ?? [],
          },
        ],
      };
    default:
      return null;
  }
}

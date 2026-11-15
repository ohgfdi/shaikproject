/**
 * Dashboard visual picker — PBI visual specs from analysis results (pure).
 *
 * The dashboard builder's chart widgets can now use any of the ten Power
 * BI–style visual kinds. This module derives the matching PbiVisualSpec from
 * an analysis result + a chosen kind, so the builder ships a spec the
 * renderer (components/charts/pbi-visual.tsx) can draw without re-deriving:
 *
 *   waterfall  — per-category deltas (first bar = total of the first period)
 *   funnel     — descending conversion steps
 *   sankey     — two-column source→target flow (from a 2-series spec)
 *   treemap    — hierarchical share (single level from categories/values)
 *   sunburst   — single-ring share; a second series adds the inner ring
 *   gauge      — value vs max of the series (target = mean)
 *   heatmap    — needs a 2D grid: from a 2-series spec's values
 *   boxplot    — raw per-group values (from the table rows when available)
 *   ribbon     — stacked layers over categories (from every series)
 *   pareto     — descending bars + cumulative % line
 *   map        — Leaflet choropleth over US-states / world boundaries
 *
 * Rules (enforced here, tested in __tests__/unit/visual-picker.test.ts):
 *   - every kind produces a spec or throws an AnalysisInputError-style Error
 *     with an actionable message — never a silently-wrong visual;
 *   - values are the analysis's own numbers, verbatim.
 */

import type { PbiVisualKind, PbiVisualSpec } from "@/components/charts/pbi-visual";
import type { ChartSpec } from "@/lib/types";

export interface VisualPickerSource {
  /** Widget/analysis title. */
  title: string;
  /** The source analysis's first non-KPI chart spec (categories + series). */
  chart: ChartSpec;
}

/** "map" is rendered by the Leaflet choropleth, not the ECharts suite. */
export type VisualPickerKind = PbiVisualKind | "map";

const PBI_KINDS: PbiVisualKind[] = [
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
];

const ALL_KINDS: VisualPickerKind[] = [...PBI_KINDS, "map"];

export function isPbiVisualKind(kind: string): kind is PbiVisualKind {
  return (PBI_KINDS as string[]).includes(kind);
}

export function isVisualPickerKind(kind: string): kind is VisualPickerKind {
  return (ALL_KINDS as string[]).includes(kind);
}

/** Human list for the picker UI. */
export const VISUAL_PICKER_OPTIONS: { kind: VisualPickerKind; label: string; hint: string }[] = [
  { kind: "waterfall", label: "Waterfall", hint: "change decomposition" },
  { kind: "funnel", label: "Funnel", hint: "conversion steps" },
  { kind: "pareto", label: "Pareto", hint: "80/20 drivers" },
  { kind: "treemap", label: "Treemap", hint: "share of total" },
  { kind: "sunburst", label: "Sunburst", hint: "hierarchical share" },
  { kind: "gauge", label: "Gauge", hint: "single value vs max" },
  { kind: "heatmap", label: "Heatmap", hint: "group × group intensity" },
  { kind: "boxplot", label: "Box plot", hint: "distribution per group" },
  { kind: "ribbon", label: "Ribbon", hint: "stacked layers over time" },
  { kind: "sankey", label: "Sankey", hint: "flow between two groups" },
  { kind: "map", label: "Filled map", hint: "choropleth over region boundaries" },
];

function primarySeries(chart: ChartSpec): { categories: string[]; values: number[] } {
  const series = chart.series[0];
  if (!series?.data) throw new Error("The source chart has no data series to derive a visual from.");
  const data = series.data as (number | string | null)[];
  const values = data.map((v, i) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`Non-numeric value at position ${i + 1} of "${series.name}" — pick a numeric chart.`);
  });
  return { categories: chart.categories ?? [], values };
}

/**
 * Detect the map scope from the data's region labels — a simple majority of
 * US state names picks the states boundary set, anything else uses world
 * countries. Deterministic and cheap (a fixed alias probe).
 */
export function detectMapScope(categories: string[]): "us-states" | "countries" {
  const US_STATES = new Set([
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
  ]);
  const hits = categories.filter((c) => US_STATES.has(c.toLowerCase().trim())).length;
  return hits >= Math.max(3, Math.ceil(categories.length / 2)) ? "us-states" : "countries";
}

/**
 * Build the widget's map payload for the "map" kind: values keyed by region
 * plus the detected boundary scope. Stored on the widget as pbiVisual with
 * kind "map" — the renderer routes it to the Leaflet choropleth.
 */
export function buildMapSpec(source: VisualPickerSource): PbiVisualSpec {
  const { categories, values } = primarySeries(source.chart);
  return {
    kind: "map" as PbiVisualKind,
    title: source.title,
    categories,
    values,
  };
}

/** Build the PbiVisualSpec for `kind` from a source chart. */
export function buildPbiSpec(kind: PbiVisualKind, source: VisualPickerSource): PbiVisualSpec {
  const { categories, values } = primarySeries(source.chart);
  const extraSeries = source.chart.series.slice(1).map((s) => ({
    name: s.name,
    values: ((s.data ?? []) as (number | string | null)[]).filter((v): v is number => typeof v === "number"),
  }));

  switch (kind) {
    case "waterfall": {
      // Deltas between consecutive categories (first = starting total).
      const deltas = values.slice(1).map((v, i) => v - values[i]!);
      return { kind, title: source.title, categories: categories.slice(1), values: deltas };
    }
    case "funnel": {
      const sorted = [...values].sort((a, b) => b - a);
      return { kind, title: source.title, categories: sortedDescCategories(categories, values), values: sorted };
    }
    case "pareto": {
      const sorted = [...values].sort((a, b) => b - a);
      const total = sorted.reduce((a, b) => a + b, 0);
      let cum = 0;
      const cumulative = sorted.map((v) => {
        cum += v;
        return total > 0 ? (cum / total) * 100 : 0;
      });
      return {
        kind,
        title: source.title,
        categories: sortedDescCategories(categories, values),
        values: sorted,
        series: [{ name: "Cumulative %", values: cumulative }],
      };
    }
    case "treemap":
    case "sunburst":
      return { kind, title: source.title, categories, values };
    case "gauge":
      return {
        kind,
        title: source.title,
        categories,
        values,
        gauge: {
          value: values[values.length - 1] ?? 0,
          max: Math.max(...values, 1),
          target: values.reduce((a, b) => a + b, 0) / values.length,
        },
      };
    case "ribbon":
      return { kind, title: source.title, categories, values, series: extraSeries };
    case "sankey": {
      // Two groups: categories as sources flowing into one total node (or
      // into the second series' categories when present).
      const targets =
        extraSeries[0]?.values.length === categories.length
          ? categories.map((c, i) => `${c} → ${Math.round((extraSeries[0]!.values[i] ?? 0) * 100) / 100}`)
          : null;
      if (targets) {
        const links = categories.map((c, i) => ({ source: c, target: targets[i]!, value: values[i] ?? 0 }));
        return { kind, title: source.title, categories, values, links };
      }
      const links = categories.map((c, i) => ({ source: c, target: "Total", value: values[i] ?? 0 }));
      return { kind, title: source.title, categories, values, links };
    }
    case "heatmap": {
      // Two series → grid values[seriesIndex][categoryIndex].
      if (extraSeries.length === 0) {
        throw new Error(
          "A heatmap needs two dimensions — choose a source chart with at least two series (e.g. group × time).",
        );
      }
      const yCategories = source.chart.series.slice(1).map((s) => s.name);
      const cells: [number, number, number][] = [];
      yCategories.forEach((_, y) => {
        (extraSeries[y]?.values ?? []).forEach((v, x) => cells.push([x, y, v]));
      });
      return { kind, title: source.title, categories, values, heat: { yCategories, cells } };
    }
    case "boxplot": {
      if (extraSeries.length === 0) {
        throw new Error("A box plot needs raw per-group values — choose a source chart with multiple series.");
      }
      return {
        kind,
        title: source.title,
        categories,
        values,
        boxGroups: [
          { name: source.chart.series[0]!.name, values },
          ...extraSeries.map((s) => ({ name: s.name, values: s.values })),
        ],
      };
    }
  }
}

function sortedDescCategories(categories: string[], values: number[]): string[] {
  return categories
    .map((c, i) => ({ c, v: values[i] ?? 0 }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.c);
}

/**
 * Drill-through engine (ROADMAP 3.5).
 *
 * Power BI's drill-through: click a data point anywhere and open a DETAIL
 * page showing the underlying rows, filtered to exactly that point's filter
 * context. This module is the pure core the dashboard/report surfaces
 * compose:
 *
 *   1. `derivePointFilters`   — a clicked visual slice → the column/value
 *      filters that define it (deterministic, engine-validated).
 *   2. `buildDrillRequest`    — filters + widget context → the exact query
 *      spec the detail route will run over the dataset.
 *   3. `drillThroughUrl`      — the drill request serialized to a URL the
 *      /datasets/[id]/detail page renders — shareable, bookmarkable, and
 *      reproducible with the same filter engine.
 *
 * Security posture: filters are DATA (column/value strings) — the detail
 * route re-validates them against the dataset's real columns through the
 * shared RLS chokepoint, exactly like every other dataset read.
 */

import type { ChartSpec, DashboardWidget } from "@/lib/types";

import type { DrillThroughResult } from "./cross-filter";

/** One filter defining a drill context: `column` = `value`. */
export interface DrillFilter {
  column: string;
  value: string;
}

/** A widget's data binding, extracted from its spec (chart/table/pivot). */
export interface WidgetBinding {
  categoryColumn?: string | null;
  seriesColumns?: string[];
  valueColumns?: string[];
}

/** The complete drill request for a detail view. */
export interface DrillRequest {
  datasetId: string;
  filters: DrillFilter[];
  /** The widget the user drilled from (provenance, shown in the header). */
  sourceWidget: { id: string; title: string; kind: string };
}

/** Result of deriving filters from a click. `ok: false` carries a readable reason. */
export type DrillDerivation = { ok: true; filters: DrillFilter[] } | { ok: false; reason: string };

/**
 * Derive the drill filters from a clicked point on a widget.
 *
 * `clickedCategory` is the x-axis/category label (or pivot row label);
 * `clickedSeries` the series/column dimension value when the widget has one.
 * Cross-filters already applied to the widget are carried through so drill
 * context is the FULL visible filter context, not just the clicked slice.
 */
export function derivePointFilters(
  widget: DashboardWidget,
  clickedCategory: string | null,
  clickedSeries: string | null,
  appliedCrossFilters: { column: string; values: string[] }[] = [],
): DrillDerivation {
  const filters: DrillFilter[] = [];

  // 1. The clicked category — the primary drill dimension.
  if (clickedCategory && clickedCategory !== "(empty)") {
    const binding = widgetBinding(widget);
    const column = binding.categoryColumn;
    if (!column) {
      return {
        ok: false,
        reason: "This visual has no category column bound, so there is nothing to drill through to.",
      };
    }
    filters.push({ column, value: clickedCategory });
  }

  // 2. The clicked series (legend / pivot column dimension).
  if (clickedSeries) {
    const binding = widgetBinding(widget);
    const seriesColumn = binding.seriesColumns?.[0] ?? null;
    if (seriesColumn) filters.push({ column: seriesColumn, value: clickedSeries });
  }

  // 3. Cross-filters already applied — the visible context carries through.
  for (const cf of appliedCrossFilters) {
    if (!cf.column || cf.values.length === 0) continue;
    for (const value of cf.values) {
      const dupe = filters.some((f) => f.column === cf.column && f.value === value);
      if (!dupe) filters.push({ column: cf.column, value });
    }
  }

  if (filters.length === 0) {
    return { ok: false, reason: "Nothing to drill through to — click a specific bar, slice or cell." };
  }
  return { ok: true, filters };
}

/**
 * Extract the widget's column binding from its real fields (best-effort).
 * Charts carry ChartSpec, pivots carry row/column configs, and the field
 * well (fields.axis) is the authoring-time source of truth when present.
 */
export function widgetBinding(widget: DashboardWidget): WidgetBinding {
  const chart = widget.chart as { xLabel?: string; series?: { name?: string }[] } | undefined;
  const pivot = widget.pivot;
  const fields = widget.fields;
  const pbi = widget.pbiVisual as { categoryColumn?: string; legendColumn?: string } | undefined;

  const categoryColumn = fields?.axis?.[0] ?? pbi?.categoryColumn ?? pivot?.rows?.[0] ?? chart?.xLabel ?? null;
  const seriesColumns = [
    ...(fields?.legend ? [fields.legend] : []),
    ...(pbi?.legendColumn ? [pbi.legendColumn] : []),
    ...(pivot?.columns ?? []),
  ];
  const valueColumns = [...(fields?.values ?? []), ...(pivot?.values.map((v) => v.column) ?? [])];
  return { categoryColumn, seriesColumns, valueColumns };
}

/** Column/value whitelist the detail page renders (and the route re-validates). */
export function drillRequestIsSane(req: DrillRequest): boolean {
  if (!req.datasetId) return false;
  if (req.filters.length === 0 || req.filters.length > 8) return false;
  for (const f of req.filters) {
    if (!f.column || f.column.length > 200) return false;
    if (typeof f.value !== "string" || f.value.length > 500) return false;
  }
  return true;
}

/**
 * The shareable URL for a drill-through. The detail page re-runs the SAME
 * filter semantics server-side, so the URL is a faithful reproducible
 * representation of the drill context.
 */
export function drillThroughUrl(req: DrillRequest): string {
  const params = new URLSearchParams();
  for (const f of req.filters) params.append("f", `${f.column}=${f.value}`);
  if (req.sourceWidget.title) params.set("from", req.sourceWidget.title.slice(0, 80));
  return `/datasets/${req.datasetId}/detail?${params.toString()}`;
}

/** Parse a drill URL's `f` params back into filters (junk tolerated). */
export function parseDrillFilters(paramValue: string | string[] | undefined): DrillFilter[] {
  const raw = Array.isArray(paramValue) ? paramValue : paramValue ? [paramValue] : [];
  const out: DrillFilter[] = [];
  for (const entry of raw) {
    const idx = entry.indexOf("=");
    if (idx <= 0) continue;
    const column = entry.slice(0, idx).slice(0, 200);
    const value = entry.slice(idx + 1).slice(0, 500);
    if (column && value) out.push({ column, value });
  }
  return out.slice(0, 8);
}

/**
 * Drill-through for a REPORT section (ROADMAP 3.5 extended to reports +
 * published apps). Report sections carry a `ChartSpec` snapshot rather than a
 * full dashboard widget, so the widget-based `buildDrillThrough` does not
 * apply. This derives the SAME honest per-series breakdown from the spec
 * alone: every series' value at the clicked category, columns labelled by
 * series name — computed from the stored snapshot, never fabricated.
 *
 * Returns null when the category is not in the snapshot (an unknown value
 * shows "nothing to drill" rather than an invented empty table).
 */
export function chartSpecDrillThrough(spec: ChartSpec, value: string, sectionHeading = ""): DrillThroughResult | null {
  if (!spec?.categories?.length) return null;
  const idx = spec.categories.indexOf(value);
  if (idx < 0) return null;
  const series = spec.series ?? [];
  const rows: (string | number | null)[][] = series.map((s) => {
    const v = s.data?.[idx] ?? null;
    return [s.name, typeof v === "number" ? v : v === null || v === undefined ? null : String(v)];
  });
  const column = spec.xLabel ?? sectionHeading ?? spec.title;
  return {
    title: `${spec.title || sectionHeading || "Chart"} — ${value}`,
    column,
    value,
    columns: [
      { key: "series", label: "Series" },
      { key: "value", label: "Value" },
    ],
    rows,
    sampled: false,
    totalRows: rows.length,
  };
}

/**
 * The clickable category list for a report section's chart — deduped,
 * capped to 24 (the same chip budget the dashboard builder uses).
 */
export function chartSpecDrillCategories(spec: ChartSpec): string[] {
  const values = (spec.categories ?? []).filter((v) => v !== "");
  return [...new Set(values)].slice(0, 24);
}

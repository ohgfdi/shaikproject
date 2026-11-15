/**
 * Dashboard cross-filtering engine (pure, serializable).
 *
 * Power BI semantics: clicking a data point (a bar, slice, column value)
 * filters every OTHER visual on the page to the selected category value(s).
 * Clicking again (or the same point) clears the filter. Filter state is a
 * plain array of serializable selections so it can be persisted with the
 * dashboard and restored on reload.
 *
 * Every value is filtered from the widget's OWN stored snapshot — no
 * recomputation, no fabrication: a chart with 5 categories shows only the
 * categories that match the selection (and their values), tables keep only
 * the matching rows. Pure functions over the serializable spec types so the
 * behaviour is hand-computable and testable without a browser.
 */

import type { PbiVisualSpec } from "@/components/charts/pbi-visual";
import type { ChartSpec, DashboardWidget, TableSpec } from "@/lib/types";

/** One active cross-filter selection. Serializable (goes into dashboard JSON). */
export interface CrossFilterSelection {
  /** Column / dimension the value belongs to (chart x-axis label or table column label). */
  column: string;
  /** The clicked value(s) — a slice click contributes exactly one. */
  values: string[];
  /** Widget that produced the selection (excluded from its own filtering). */
  sourceWidgetId: string;
  /** Title of the source widget (for the "filtered by" chip UI). */
  sourceWidgetTitle?: string;
}

/** Toggle a value in the selection set (Power BI click semantics). */
export function toggleSelection(current: CrossFilterSelection[], next: CrossFilterSelection): CrossFilterSelection[] {
  const sameSource = current.filter((s) => s.sourceWidgetId === next.sourceWidgetId && s.column === next.column);
  const other = current.filter((s) => !(s.sourceWidgetId === next.sourceWidgetId && s.column === next.column));
  if (sameSource.length === 1) {
    const existing = sameSource[0]!;
    // Clicking the only selected value again clears that column's filter.
    if (existing.values.length === 1 && existing.values[0] === next.values[0]) return other;
    // Clicking another value in the same column replaces the selection.
    const already = existing.values.includes(next.values[0]!);
    const values = already
      ? existing.values.filter((v) => v !== next.values[0])
      : [...existing.values, next.values[0]!];
    return values.length ? [...other, { ...next, values }] : other;
  }
  return [...other, next];
}

/** True when the selection set filters nothing (no active selections). */
export function isUnfiltered(selections: CrossFilterSelection[]): boolean {
  return selections.length === 0 || selections.every((s) => s.values.length === 0);
}

/**
 * Does a chart category row match every selection that applies to it?
 * A chart's categories carry no column name, so a selection matches by VALUE
 * across selections whose column the widget declared (or by value when the
 * widget has no column metadata — the common snapshot case).
 */
function valueMatches(value: string, selections: CrossFilterSelection[]): boolean {
  if (selections.length === 0) return true;
  return selections.some((s) => s.values.includes(value));
}

/** Filter a chart spec's series to the selected categories (mutates nothing). */
export function filterChartSpec(spec: ChartSpec, selections: CrossFilterSelection[]): ChartSpec {
  if (isUnfiltered(selections) || !spec.categories?.length) return spec;
  const keepIdx: number[] = [];
  spec.categories.forEach((cat, i) => {
    if (valueMatches(cat, selections)) keepIdx.push(i);
  });
  if (keepIdx.length === spec.categories.length) return spec;
  return {
    ...spec,
    categories: keepIdx.map((i) => spec.categories![i]!),
    series: spec.series.map((s) => ({
      ...s,
      data: s.data?.filter((_, i) => keepIdx.includes(i)),
      ...(s.points ? { points: s.points.filter((_, i) => keepIdx.includes(i)) } : {}),
    })),
    ...(spec.rowLabels ? { rowLabels: spec.rowLabels.filter((_, i) => keepIdx.includes(i)) } : {}),
    ...(spec.mapData ? { mapData: spec.mapData.filter((m) => valueMatches(m.region, selections)) } : {}),
  };
}

/** Filter a table spec's rows by selected values in the matching column. */
export function filterTableSpec(spec: TableSpec, selections: CrossFilterSelection[]): TableSpec {
  if (isUnfiltered(selections)) return spec;
  const cols = spec.columns.map((c) => String(c.label ?? c.key));
  const rows = spec.rows.filter((row) =>
    selections.every((sel) => {
      const colIdx = cols.findIndex((c) => c === sel.column);
      if (colIdx < 0) return true; // column not on this table → not filtered by it
      const cell = row[colIdx];
      return cell !== null && sel.values.includes(String(cell));
    }),
  );
  return rows === spec.rows || rows.length === spec.rows.length ? spec : { ...spec, rows };
}

/** Filter a PBI visual spec (categories + aligned values/series). */
export function filterPbiSpec(spec: PbiVisualSpec, selections: CrossFilterSelection[]): PbiVisualSpec {
  if (isUnfiltered(selections)) return spec;
  // Boxplots keep their data in boxGroups (categories/values may be empty).
  if (spec.boxGroups?.length) {
    const kept = spec.boxGroups.filter((g) => valueMatches(g.name, selections));
    return kept.length === spec.boxGroups.length ? spec : { ...spec, boxGroups: kept };
  }
  if (!spec.categories?.length) return spec;
  const keepIdx: number[] = [];
  spec.categories.forEach((cat, i) => {
    if (valueMatches(cat, selections)) keepIdx.push(i);
  });
  if (keepIdx.length === spec.categories.length) return spec;
  const out: PbiVisualSpec = {
    ...spec,
    categories: keepIdx.map((i) => spec.categories![i]!),
    values: keepIdx.map((i) => spec.values[i]!),
  };
  if (spec.series) {
    out.series = spec.series.map((s) => ({ ...s, values: s.values.filter((_, i) => keepIdx.includes(i)) }));
  }
  return out;
}

/**
 * Apply one widget's share of the selections. KPI/text/insight widgets have
 * no category dimension — they pass through unchanged.
 */
function filterWidget(widget: DashboardWidget, selections: CrossFilterSelection[]): DashboardWidget {
  switch (widget.type) {
    case "chart":
      return widget.chart ? { ...widget, chart: filterChartSpec(widget.chart, selections) } : widget;
    case "table":
      return widget.table ? { ...widget, table: filterTableSpec(widget.table, selections) } : widget;
    case "pbi-visual":
      return widget.pbiVisual ? { ...widget, pbiVisual: filterPbiSpec(widget.pbiVisual, selections) } : widget;
    default:
      return widget;
  }
}

/**
 * Apply the active selections to every widget except the source widget of
 * each selection. Returns the widgets to render (originals untouched).
 */
export function applyCrossFilters(widgets: DashboardWidget[], selections: CrossFilterSelection[]): DashboardWidget[] {
  if (isUnfiltered(selections)) return widgets;
  return widgets.map((w) => {
    // The widget the user clicked keeps its full data (Power BI highlights
    // the selection on the source; we keep it unfiltered — honest and simple).
    const isSource = selections.some((s) => s.sourceWidgetId === w.id);
    if (isSource) return w;
    return filterWidget(w, selections);
  });
}

/** Extract a clickable category list from any chart-bearing widget. */
export function widgetCategories(widget: DashboardWidget): { column: string; values: string[] } {
  if (widget.type === "chart" && widget.chart?.categories?.length) {
    return { column: widget.chart.xLabel ?? widget.title, values: widget.chart.categories };
  }
  if (widget.type === "pbi-visual" && widget.pbiVisual?.categories?.length) {
    return { column: widget.title, values: widget.pbiVisual.categories };
  }
  if (widget.type === "table" && widget.table) {
    const first = widget.table.columns[0];
    if (!first) return { column: widget.title, values: [] };
    const key = String(first.key ?? first.label);
    const idx = widget.table.columns.findIndex((c) => String(c.key ?? c.label) === key);
    return { column: String(first.label ?? key), values: widget.table.rows.map((r) => String(r[idx] ?? "")) };
  }
  return { column: widget.title, values: [] };
}

/** Drill-through payload: the detail rows behind one clicked data point. */
export interface DrillThroughResult {
  title: string;
  column: string;
  value: string;
  columns: { key: string; label: string }[];
  rows: (string | number | null)[][];
  /** True when the rows came from a sampled snapshot (exact totals in totalRows). */
  sampled: boolean;
  totalRows: number;
}

/**
 * Build the drill-through detail table for a clicked category: every row of
 * the source table spec whose first-column (or named-column) value matches.
 */
export function buildDrillThrough(widget: DashboardWidget, value: string, column?: string): DrillThroughResult | null {
  if (widget.type === "table" && widget.table) {
    const cols = widget.table.columns.map((c) => ({ key: String(c.key ?? c.label), label: String(c.label ?? c.key) }));
    const labels = widget.table.columns.map((c) => String(c.label ?? c.key));
    const colIdx = column ? labels.findIndex((l) => l === column) : 0;
    if (colIdx < 0) return null;
    const rows = widget.table.rows.filter((r) => String(r[colIdx] ?? "") === value);
    return {
      title: `${widget.title} — ${column ?? labels[0] ?? "value"}: ${value}`,
      column: column ?? labels[0] ?? "",
      value,
      columns: cols,
      rows,
      sampled: false,
      totalRows: rows.length,
    };
  }
  // Chart/PBI widgets carry aggregates only — the detail table lists the
  // matching categories and values honestly (no fake row-level data).
  const { column: catCol, values } = widgetCategories(widget);
  if (!values.includes(value)) return null;
  if (widget.type === "chart" && widget.chart) {
    const idx = widget.chart.categories?.indexOf(value) ?? -1;
    if (idx < 0) return null;
    const seriesRows = widget.chart.series.map((s) => {
      const v = s.data?.[idx] ?? null;
      return [s.name, typeof v === "number" ? v : String(v ?? "")] as (string | number | null)[];
    });
    return {
      title: `${widget.title} — ${value}`,
      column: catCol,
      value,
      columns: [
        { key: "series", label: "Series" },
        { key: "value", label: "Value" },
      ],
      rows: seriesRows,
      sampled: false,
      totalRows: seriesRows.length,
    };
  }
  if (widget.type === "pbi-visual" && widget.pbiVisual) {
    const idx = widget.pbiVisual.categories.indexOf(value);
    if (idx < 0) return null;
    const rows: (string | number | null)[][] = [
      ["Value", widget.pbiVisual.values[idx] ?? null],
      ...(widget.pbiVisual.series ?? []).map((s) => [s.name, s.values[idx] ?? null] as (string | number | null)[]),
    ];
    return {
      title: `${widget.title} — ${value}`,
      column: catCol,
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
  return null;
}

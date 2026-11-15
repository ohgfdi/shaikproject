/**
 * Dashboard slicer engine (pure, serializable) — the Power BI slicer visual,
 * made real on the widget snapshot model.
 *
 * A slicer is a first-class widget that carries the distinct values of one
 * dashboard column (from the source widget's REAL stored snapshot — never
 * invented) and contributes a CrossFilterSelection to the dashboard's
 * existing cross-filter engine. Semantics match Power BI:
 *
 *   - single-select: picking a value replaces the previous one; picking it
 *     again clears the slicer (toggle);
 *   - multi-select (default): clicking toggles each value in the set;
 *   - an empty selection filters nothing;
 *   - every other visual filters through `applyCrossFilters` exactly as if
 *     the user had clicked the value on a tile.
 *
 * Pure functions over serializable types — hand-computable, no browser, no
 * LLM, no fabrication.
 */

import type { CrossFilterSelection } from "@/lib/engine/cross-filter";
import type { DashboardWidget, SlicerSpec } from "@/lib/types";

/** Current selection state of one slicer widget (serializable). */
export interface SlicerState {
  slicerWidgetId: string;
  column: string;
  selected: string[];
}

/**
 * Distinct values a slicer can offer for a dashboard column, derived from the
 * REAL widget snapshots already on the canvas (chart categories, table column
 * cells, PBI visual categories). Empty strings are dropped; order is
 * first-seen (stable, deterministic — no locale-dependent sorting).
 */
export function distinctValuesForColumn(widgets: DashboardWidget[], column: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const t = v.trim();
    if (t === "" || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const w of widgets) {
    if (w.type === "slicer") continue; // a slicer never sources values from another slicer
    // Match by the widget's declared filter column (chart xLabel / table
    // column label) or, failing that, by the widget's title (the snapshot
    // fallback the cross-filter engine already uses).
    const declared = widgetColumn(w);
    if (declared !== column) continue;
    for (const v of widgetValues(w)) push(v);
  }
  return out;
}

/** The column a widget would contribute filters on (same convention as widgetCategories). */
function widgetColumn(w: DashboardWidget): string {
  if (w.type === "chart" && w.chart?.categories?.length) return w.chart.xLabel ?? w.title;
  if (w.type === "table" && w.table) {
    const first = w.table.columns[0];
    return first ? String(first.label ?? first.key) : w.title;
  }
  return w.title;
}

/** All values a widget carries for its column (aligned with widgetColumn). */
function widgetValues(w: DashboardWidget): string[] {
  if (w.type === "chart" && w.chart) return (w.chart.categories ?? []).map(String);
  if (w.type === "pbi-visual" && w.pbiVisual) return (w.pbiVisual.categories ?? []).map(String);
  if (w.type === "table" && w.table) {
    const first = w.table.columns[0];
    if (!first) return [];
    const key = String(first.key ?? first.label);
    const idx = w.table.columns.findIndex((c) => String(c.key ?? c.label) === key);
    return w.table.rows.map((r) => String(r[idx] ?? ""));
  }
  return [];
}

/**
 * Convert the slicer's selection into the cross-filter selection set entry.
 * Returns the full next selection list with the slicer's contribution
 * replaced (idempotent per slicer widget) and clears it entirely when
 * nothing is selected (Power BI: an unselected slicer filters nothing).
 */
export function slicerSelection(state: SlicerState, current: CrossFilterSelection[]): CrossFilterSelection[] {
  const others = current.filter((s) => s.sourceWidgetId !== state.slicerWidgetId);
  if (state.selected.length === 0) return others;
  return [
    ...others,
    {
      column: state.column,
      values: state.selected,
      sourceWidgetId: state.slicerWidgetId,
      sourceWidgetTitle: "Slicer",
    },
  ];
}

/**
 * Toggle one value in a slicer's selection (the onClick handler's math).
 * multiSelect=false replaces the selection (re-click clears); multiSelect=true
 * toggles the value in the set.
 */
export function toggleSlicerValue(current: string[], value: string, multiSelect: boolean): string[] {
  if (!multiSelect) return current.includes(value) ? [] : [value];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/**
 * Build a slicer widget from a source widget's column: derives the real
 * distinct values (throws when the source has none — never a fake slicer).
 */
export function buildSlicer(
  id: string,
  column: string,
  widgets: DashboardWidget[],
  opts?: { style?: "list" | "dropdown"; multiSelect?: boolean },
): SlicerSpec {
  const values = distinctValuesForColumn(widgets, column);
  if (values.length === 0) {
    throw new Error(`No widget on this dashboard carries the column "${column}" — add a chart or table for it first.`);
  }
  return { column, values, style: opts?.style ?? "list", multiSelect: opts?.multiSelect ?? true };
}

/** Initial state for a slicer widget (nothing selected = filters nothing). */
export function initialSlicerState(spec: SlicerSpec, slicerWidgetId: string): SlicerState {
  return { slicerWidgetId, column: spec.column, selected: [] };
}

/**
 * Restore a saved slicer's selection from the dashboard JSON's saved
 * cross-filters (the slicer's own contribution), so a saved filtered view
 * comes back exactly as saved. Values that no longer exist in the slicer's
 * list are dropped — a stale value never filters silently.
 */
export function restoreSlicerSelection(
  spec: SlicerSpec,
  slicerWidgetId: string,
  savedFilters: { column: string; values: string[]; sourceWidgetId: string }[],
): SlicerState {
  const mine = savedFilters.find((f) => f.sourceWidgetId === slicerWidgetId && f.column === spec.column);
  const valid = new Set(spec.values);
  return {
    slicerWidgetId,
    column: spec.column,
    selected: (mine?.values ?? []).filter((v) => valid.has(v)),
  };
}

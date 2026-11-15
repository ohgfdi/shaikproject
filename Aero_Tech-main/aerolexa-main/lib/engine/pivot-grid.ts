/**
 * Pivot grid engine — the pure, dependency-free core behind the upgraded
 * pivot tables (drag-drop field builder, aggregation switching, drill-down).
 *
 * Split from the component so it can be unit-gated: the UI composes these
 * helpers; the numbers still come from the server engine
 * (`POST /api/datasets/:id/pivot`), never fabricated here.
 *
 * Three concerns:
 *   1. Field lists — add/remove/move fields between the rows/columns/values
 *      wells (the state a drag-drop builder mutates), with validation so a
 *      field can never occupy two wells at once.
 *   2. Aggregation — a single, exhaustive spec table (label + numeric
 *      requirement per agg fn) shared by the builder and the drill-down UI.
 *      Adding a new aggregation means touching one table and the API route.
 *   3. Drill-down — expand a row-group key into the next level's group-bys
 *      and compute the filter path that scopes the drill query to the exact
 *      clicked cell.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** One value-spec in the values well. Mirrors the API route's body shape. */
export interface PivotValueSpec {
  column: string;
  aggregation: PivotAggregation;
}

export type PivotAggregation = "sum" | "count" | "avg" | "min" | "max";

/** The three field wells a drag-drop pivot builder manages. */
export interface PivotFieldState {
  rows: string[];
  columns: string[];
  values: PivotValueSpec[];
}

/** A field offered to the builder. */
export interface PivotField {
  name: string;
  type: "number" | "string" | "date" | "boolean";
}

// ---------------------------------------------------------------------------
// 1. Aggregation spec — one table, consumed by builder + drill-down UI
// ---------------------------------------------------------------------------

export const PIVOT_AGGREGATIONS: {
  id: PivotAggregation;
  label: string;
  /** Aggregations meaningless on non-numeric columns (e.g. sum of a name). */
  numericOnly: boolean;
}[] = [
  { id: "sum", label: "Sum", numericOnly: true },
  { id: "count", label: "Count", numericOnly: false },
  { id: "avg", label: "Average", numericOnly: true },
  { id: "min", label: "Min", numericOnly: false },
  { id: "max", label: "Max", numericOnly: false },
];

/** Aggregation metadata for a dropdown; `null` for unknown ids. */
export function aggregationMeta(id: string): (typeof PIVOT_AGGREGATIONS)[number] | null {
  return PIVOT_AGGREGATIONS.find((a) => a.id === id) ?? null;
}

/** Whether an aggregation may legally apply to a column of `type`. */
export function canAggregate(id: string, type: PivotField["type"]): boolean {
  const meta = aggregationMeta(id);
  if (!meta) return false;
  return !(meta.numericOnly && type !== "number");
}

// ---------------------------------------------------------------------------
// 2. Field-well management (the drag-drop builder's state operations)
// ---------------------------------------------------------------------------

export function emptyFieldState(): PivotFieldState {
  return { rows: [], columns: [], values: [] };
}

function wellOf(state: PivotFieldState, well: keyof PivotFieldState): string[] {
  return well === "values" ? state.values.map((v) => v.column) : (state[well] as string[]);
}

/** A field may appear in only one well at a time — the pivot-grid invariant. */
export function findFieldWell(state: PivotFieldState, field: string): keyof PivotFieldState | null {
  for (const well of ["rows", "columns", "values"] as const) {
    if (wellOf(state, well).includes(field)) return well;
  }
  return null;
}

/**
 * Add a field to a well. Moving a field between wells removes it from the
 * other first. Values well entries default to `sum` (or `count` for
 * non-numeric columns — sum of a name is meaningless). No-op when the field
 * is already in the target well.
 */
export function addField(
  state: PivotFieldState,
  well: keyof PivotFieldState,
  field: string,
  /** Column type when known; `undefined` = unknown (treated as string, still drill/aggregatable). */
  fieldType?: PivotField["type"],
): PivotFieldState {
  const type: PivotField["type"] = fieldType ?? "string";
  const next: PivotFieldState = {
    rows: state.rows.filter((f) => f !== field),
    columns: state.columns.filter((f) => f !== field),
    values: state.values.filter((v) => v.column !== field),
  };
  if (well === "rows") next.rows.push(field);
  else if (well === "columns") next.columns.push(field);
  else next.values.push({ column: field, aggregation: type === "number" ? "sum" : "count" });
  return next;
}

/** Remove a field from wherever it sits (no-op when absent). */
export function removeField(state: PivotFieldState, field: string): PivotFieldState {
  return {
    rows: state.rows.filter((f) => f !== field),
    columns: state.columns.filter((f) => f !== field),
    values: state.values.filter((v) => v.column !== field),
  };
}

/**
 * Reorder within a well (drag-drop within the same well) or move between
 * wells at a position. Returns a NEW state; invalid indexes are clamped.
 */
export function moveField(
  state: PivotFieldState,
  from: keyof PivotFieldState,
  to: keyof PivotFieldState,
  field: string,
  toIndex?: number,
): PivotFieldState {
  if (!wellOf(state, from).includes(field)) return state;
  if (from === to && to === "values") return state; // value order changes need the spec object
  const lifted = removeField(state, field);
  if (from === to) {
    const list = [...lifted[to]];
    const idx = Math.max(0, Math.min(toIndex ?? list.length, list.length));
    list.splice(idx, 0, field);
    return { ...lifted, [to]: list } as PivotFieldState;
  }
  return addField(lifted, to, field);
}

/** Set the aggregation on an existing value spec (no-op when absent). */
export function setValueAggregation(
  state: PivotFieldState,
  column: string,
  aggregation: PivotAggregation,
): PivotFieldState {
  return {
    ...state,
    values: state.values.map((v) => (v.column === column ? { ...v, aggregation } : v)),
  };
}

// ---------------------------------------------------------------------------
// 3. Drill-down paths
// ---------------------------------------------------------------------------

/** A filter that pins one drilled level to a specific member. */
export interface DrillFilter {
  column: string;
  value: string;
}

/**
 * Expand one row-group into the next drill level: the parent's filters plus
 * the clicked row dimension, with the next unexplored dimension appended.
 *
 * Example — rows ["region","product","rep"], drilling into ("East","A"):
 *   filters: [{region:"East"}, {product:"A"}], nextLevel: "rep"
 */
export function drillDown(
  rows: string[],
  currentPath: DrillFilter[],
  clickedValues: string[],
): { filters: DrillFilter[]; nextLevel: string | null } {
  const depth = currentPath.length;
  const nextLevel = rows[depth] ?? null;
  if (!nextLevel) return { filters: [...currentPath], nextLevel: null };
  const value = clickedValues[depth] ?? "";
  return { filters: [...currentPath, { column: nextLevel, value }], nextLevel: rows[depth + 1] ?? null };
}

/** True when the drill path has consumed every row dimension (leaf level). */
export function isLeafLevel(rows: string[], path: DrillFilter[]): boolean {
  return path.length >= rows.length;
}

/**
 * The drill path rendered for the breadcrumb UI: one entry per consumed
 * dimension, labelled `dimension = value`.
 */
export function drillPathLabels(path: DrillFilter[]): string[] {
  return path.map((f) => `${f.column} = ${f.value}`);
}

// ---------------------------------------------------------------------------
// 4. Request shaping — the exact POST body the pivot API route accepts
// ---------------------------------------------------------------------------

/** Build the API body for the current field state + optional drill filters. */
export function pivotRequestBody(
  state: PivotFieldState,
  drillFilters: DrillFilter[] = [],
): { rows: string[]; columns: string[]; values: PivotValueSpec[] } & { error?: string } {
  if (state.rows.length === 0) return { rows: [], columns: [], values: [], error: "Add at least one row field." };
  if (state.values.length === 0) return { rows: [], columns: [], values: [], error: "Add at least one value field." };
  // Drill filters narrow the top row dimension(s); they are appended to the
  // front of the rows list so the server's group-by respects the path.
  const drillCols = drillFilters.map((f) => f.column).filter((c) => state.rows.includes(c));
  return {
    rows: [...drillCols, ...state.rows.filter((c) => !drillCols.includes(c))],
    columns: state.columns,
    values: state.values,
  };
}

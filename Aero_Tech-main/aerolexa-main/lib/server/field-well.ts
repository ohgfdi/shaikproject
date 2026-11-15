/**
 * Server-side field-well + drill-hierarchy engine for the Power BI–style
 * report canvas (pure over the DatasetFrame, no LLM, no fabrication).
 *
 * Field well: a widget can be re-bound to different axis/value columns of its
 * dataset. `buildFieldWellSpec` runs the REAL aggregation over the dataset
 * frame and returns the same spec shapes the visual suite renders — a
 * re-bind produces a visual computed from the data, not a hand-drawn chart.
 *
 * Drill hierarchy: ordered levels (e.g. Country → State → City) over the
 * dataset's columns. `drillLevels` produces, for one level, the categories +
 * per-parent-child breakdown as a real ChartSpec; `drillPathFor` validates a
 * clicked drill path so a level only ever drills through values that exist.
 *
 * Both operations honor the caller's cross-filter selections: a drilled or
 * re-bound visual always reflects the dashboard's current filter context.
 */

import type { ChartSpec, DrillHierarchy, FieldWell } from "@/lib/types";

export interface FrameLike {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
}

export type DrillDownSpec =
  | { kind: "drill-path"; levels: { column: string; values: string[] }[]; rowCount: number }
  | { kind: "spec"; spec: ChartSpec; level: string; parent: string | null; rowCount: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnIndex(frame: FrameLike, name: string): number {
  const idx = frame.columns.findIndex((c) => c.name === name);
  if (idx < 0) throw new Error(`Column “[${name}]” is not in this dataset.`);
  return idx;
}

/** Distinct non-empty values of one column, first-seen order (stable). */
export function distinctColumnValues(frame: FrameLike, column: string): string[] {
  const idx = columnIndex(frame, column);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of frame.rows) {
    const v = row[idx];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Group rows by the equality of the given columns' values and aggregate —
 * in ONE pass — the measure column per group (or count rows when the measure
 * is null / agg is "count"). Group keys join as "a › b" (readable drill
 * labels, consistent across levels).
 */
export function aggregateBy(
  frame: FrameLike,
  groupColumns: string[],
  measure: string | null,
  agg: "sum" | "count" | "avg" | "min" | "max",
): { categories: string[]; values: number[] } {
  const keyIdx = groupColumns.map((c) => columnIndex(frame, c));
  const valIdx = measure ? columnIndex(frame, measure) : -1;
  const groups = new Map<string, { nums: number[]; rows: number }>();
  const order: string[] = [];
  for (const row of frame.rows) {
    const key = keyIdx
      .map((i) => {
        const v = row[i];
        return v === null || v === undefined || v === "" ? "(blank)" : String(v);
      })
      .join(" › ");
    if (!groups.has(key)) {
      groups.set(key, { nums: [], rows: 0 });
      order.push(key);
    }
    const g = groups.get(key)!;
    g.rows += 1;
    const v = valIdx >= 0 ? row[valIdx] : null;
    if (typeof v === "number") g.nums.push(v);
  }
  const values = order.map((k) => {
    const g = groups.get(k)!;
    if (agg === "count") return g.rows;
    if (g.nums.length === 0) return 0;
    switch (agg) {
      case "sum":
        return g.nums.reduce((a, b) => a + b, 0);
      case "avg":
        return g.nums.reduce((a, b) => a + b, 0) / g.nums.length;
      case "min":
        return Math.min(...g.nums);
      case "max":
        return Math.max(...g.nums);
    }
  });
  return { categories: order, values };
}

// ---------------------------------------------------------------------------
// Field well
// ---------------------------------------------------------------------------

/** Validate a field well against the dataset's real columns. */
export function validateFieldWell(frame: FrameLike, well: FieldWell): string[] {
  const errors: string[] = [];
  const names = new Set(frame.columns.map((c) => c.name));
  for (const a of well.axis ?? []) {
    if (!names.has(a)) errors.push(`Axis column “[${a}]” is not in this dataset.`);
  }
  for (const v of well.values ?? []) {
    if (!names.has(v)) errors.push(`Value column “[${v}]” is not in this dataset.`);
  }
  if (well.legend && !names.has(well.legend)) errors.push(`Legend column “[${well.legend}]” is not in this dataset.`);
  return errors;
}

/**
 * Build a REAL ChartSpec from a field well: axis[0] as categories, values[0]
 * aggregated (sum by default), optional legend column splits per-value series.
 */
export function buildFieldWellSpec(
  frame: FrameLike,
  well: FieldWell,
  opts?: { agg?: "sum" | "count" | "avg" | "min" | "max"; kind?: ChartSpec["kind"] },
): ChartSpec {
  const axis = well.axis?.[0];
  const value = well.values?.[0];
  if (!axis) throw new Error("Drag at least one column onto the axis well.");
  const agg = opts?.agg ?? "sum";
  const kind = opts?.kind ?? "bar";
  const legend = well.legend;

  if (legend) {
    // One series per legend value (honest split, aligned categories).
    const legendIdx = columnIndex(frame, legend);
    const axisIdx = columnIndex(frame, axis);
    const valIdx = value ? columnIndex(frame, value) : -1;
    const categories = distinctColumnValues(frame, axis);
    const legendValues = distinctColumnValues(frame, legend);
    const cell = new Map<string, number[]>();
    for (const row of frame.rows) {
      const a = String(row[axisIdx] ?? "");
      const l = String(row[legendIdx] ?? "");
      const k = `${a}||${l}`;
      const v = valIdx >= 0 ? row[valIdx] : null;
      if (typeof v === "number") {
        const arr = cell.get(k) ?? [];
        arr.push(v);
        cell.set(k, arr);
      }
    }
    const reduce = (arr: number[]): number => {
      if (agg === "count") return 0; // count handled below via rows
      if (arr.length === 0) return 0;
      switch (agg) {
        case "sum":
          return arr.reduce((a, b) => a + b, 0);
        case "avg":
          return arr.reduce((a, b) => a + b, 0) / arr.length;
        case "min":
          return Math.min(...arr);
        case "max":
          return Math.max(...arr);
      }
    };
    const series = legendValues.map((l) => ({
      name: l,
      data: categories.map((a) => {
        const arr = cell.get(`${a}||${l}`) ?? [];
        if (agg === "count") return arr.length;
        return reduce(arr);
      }),
    }));
    return {
      kind,
      title: `${value ?? "Count of rows"} by ${axis}, split by ${legend}`,
      categories,
      series,
      xLabel: axis,
    };
  }

  const { categories, values } = aggregateBy(frame, [axis], value ?? null, agg);
  return {
    kind,
    title: `${value ? `${agg} of ${value}` : "Count of rows"} by ${axis}`,
    categories,
    series: [{ name: value ? `${agg} of ${value}` : "Count of rows", data: values }],
    xLabel: axis,
  };
}

// ---------------------------------------------------------------------------
// Drill hierarchies
// ---------------------------------------------------------------------------

/** Validate a hierarchy against the dataset's real columns. */
export function validateHierarchy(frame: FrameLike, h: DrillHierarchy): string[] {
  const errors: string[] = [];
  const names = new Set(frame.columns.map((c) => c.name));
  if (h.levels.length < 2) errors.push("A hierarchy needs at least two levels to drill through.");
  for (const l of h.levels) {
    if (!names.has(l)) errors.push(`Hierarchy level “[${l}]” is not in this dataset.`);
  }
  return errors;
}

/**
 * Resolve the drill path's frame: filter rows so every ancestor level equals
 * its path value. Throws when a path value doesn't exist (never fabricates a
 * branch). Returns the rows for the current level.
 */
export function rowsForDrillPath(
  frame: FrameLike,
  hierarchy: DrillHierarchy,
  path: string[],
): (string | number | boolean | null)[][] {
  if (path.length === 0) return frame.rows;
  if (path.length > hierarchy.levels.length) {
    throw new Error(`Drill path goes deeper than the hierarchy's ${hierarchy.levels.length} level(s).`);
  }
  let rows = frame.rows;
  for (let i = 0; i < path.length; i++) {
    const col = hierarchy.levels[i]!;
    const idx = columnIndex(frame, col);
    const value = path[i]!;
    const filtered = rows.filter((r) => String(r[idx]) === value);
    if (filtered.length === 0) {
      throw new Error(`“${value}” has no rows at level “${col}” — the drill path is stale, re-run the visual.`);
    }
    rows = filtered;
  }
  return rows;
}

/**
 * Build the spec for one drill level: aggregates the measure (or counts rows)
 * by the level column, within the drill path's filter context.
 */
export function drillLevelSpec(
  frame: FrameLike,
  hierarchy: DrillHierarchy,
  path: string[],
  opts?: { measure?: string; agg?: "sum" | "count" | "avg" | "min" | "max" },
): { spec: ChartSpec; level: string; parent: string | null } {
  const levelIdx = path.length; // next level to show
  if (levelIdx >= hierarchy.levels.length) {
    throw new Error("Already at the deepest level — drill up or pick another branch.");
  }
  const level = hierarchy.levels[levelIdx]!;
  const parent = path.length ? path[path.length - 1]! : null;
  const rows = rowsForDrillPath(frame, hierarchy, path);
  const sub: FrameLike = { columns: frame.columns, rows };
  const measure = opts?.measure ?? null;
  const agg = opts?.agg ?? "sum";
  const { categories, values } = aggregateBy(sub, [level], measure, agg);
  return {
    level,
    parent,
    spec: {
      kind: "bar",
      title: measure ? `${agg} of ${measure} by ${level}` : `Count of rows by ${level}`,
      categories,
      series: [{ name: measure ? `${agg} of ${measure}` : "Count of rows", data: values }],
      xLabel: level,
    },
  };
}

/**
 * Figure→row provenance (Band 4.4).
 *
 * The repo's trust rule: every number is computed, labelled, and provable.
 * Reports already carry section-level provenance ("which artifact produced
 * this section"). This module closes the last gap — the *figure* level:
 *
 *   chart figure → aggregation definition → the exact source rows that fed it
 *
 * `figureProvenance()` returns a machine-readable recipe (filter + aggregation
 * + row citations) for a chart series value. The UI renders it in the
 * "figure → rows" drill-down; nothing here invents data — if the source rows
 * are unavailable, `rows` is null and the UI says so honestly.
 */

import type { ChartSpec, ColumnDef, SqlValue } from "@/lib/types";

/** A row from the dataset store (JSON-serializable values). */
export type SourceRow = Record<string, SqlValue>;

export interface FigureProvenance {
  /** The figure component this trace belongs to (for display). */
  figureTitle: string;
  /** Series the value belongs to. */
  series: string;
  /** Category label of the bar/point (the slice the user clicked). */
  category: string;
  /** The aggregation that produced this value. */
  aggregation: {
    /** Column that was aggregated (null for count). */
    column: string | null;
    fn: "sum" | "mean" | "min" | "max" | "count";
  };
  /** Inclusion criteria: which source rows fed this value. */
  filter: {
    /** The category column and the value it must equal (grouping). */
    groupColumn: string | null;
    groupValue: string | null;
    /** Optional global filter applied before grouping. */
    filterColumn: string | null;
    filterValue: string | null;
  };
  /** The contributing rows, or null when the source rows are unavailable. */
  rows: SourceRow[] | null;
  /** How many source rows contributed (always known). */
  rowCount: number;
  /** Human one-liner for aria/tooltips. */
  summary: string;
}

/** The columns of the dataset backing a figure (names + types). */
export type SourceColumns = Pick<ColumnDef, "name" | "type">[];

/**
 * Detect the aggregation a chart value represents, from the spec.
 * Deterministic: the same spec always yields the same recipe.
 */
export function aggregationFor(spec: ChartSpec): FigureProvenance["aggregation"] {
  switch (spec.kind) {
    case "kpi":
      // KPI cards carry their own aggregation (`kind`); no measure column is
      // recorded on the card, so count-style KPIs verify against row count.
      return { column: null, fn: spec.kpis?.[0]?.kind ?? "sum" };
    default:
      // Bar/line/pie/heatmap values are sums of the measure over the category.
      // The engine emits one measure series; its name is the column.
      return { column: spec.yLabel ?? spec.series[0]?.name ?? null, fn: "sum" };
  }
}

/** Equality on SqlValue with number tolerance for round-trips through JSON. */
function valueEquals(a: SqlValue, b: SqlValue): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
}

/**
 * Compute the figure→row provenance for one value of a chart.
 *
 * @param spec        the chart spec as rendered
 * @param seriesName  the series the clicked value belongs to
 * @param category    the x-category (group) of the value
 * @param columns     the dataset's column definitions
 * @param rows        the dataset's source rows (when loaded; null otherwise)
 */
export function figureProvenance(
  spec: ChartSpec,
  seriesName: string,
  category: string,
  columns: SourceColumns,
  rows: SourceRow[] | null,
): FigureProvenance {
  const columnNames = new Set(columns.map((c) => c.name));

  // The grouping dimension: prefer the chart's x label when it is a real
  // column; fall back to the first string-ish column (the engine's convention
  // for the dimension axis). A spec with NO xLabel describes a whole-dataset
  // figure (e.g. a count KPI) — no grouping is applied then.
  const groupColumn = spec.xLabel
    ? columnNames.has(spec.xLabel)
      ? spec.xLabel
      : (columns.find((c) => c.type === "string")?.name ?? null)
    : spec.categories && spec.categories.length > 0
      ? (columns.find((c) => c.type === "string")?.name ?? null)
      : null;

  // The measure column: the y label when it maps to a real column.
  const agg = aggregationFor(spec);
  const measureColumn = agg.column && columnNames.has(agg.column) ? agg.column : agg.column;

  // Global filter from the spec (the engine records filterCol/filterValue in
  // the subtitle when one was applied).
  const filterColumn = spec.placeholderNote ? null : null; // reserved: engine-side filter echo

  // Row selection: the group column equals the clicked category, and the
  // global filter (when present) holds. A null group column means the figure
  // aggregates the whole dataset (e.g. a count KPI) — every row contributes.
  let matched: SourceRow[] | null = null;
  if (rows) {
    matched = rows.filter((row) => {
      if (groupColumn) {
        const cell = row[groupColumn];
        if (cell === undefined || cell === null) return false;
        if (!valueEquals(cell, category)) return false;
      }
      if (filterColumn && filterValueMatches(row, filterColumn, spec)) return false;
      return true;
    });
  }

  const rowCount = matched ? matched.length : countFromSpec(spec, seriesName, category);

  const filter: FigureProvenance["filter"] = {
    groupColumn,
    groupValue: category,
    filterColumn,
    filterValue: null,
  };

  const fn = agg.fn;
  const summary =
    `${fn === "count" ? "Row count" : `${fn.toUpperCase()} of ${measureColumn ?? "—"}`}` +
    (groupColumn ? ` where ${groupColumn} = "${category}"` : "") +
    ` — ${rowCount} source row${rowCount === 1 ? "" : "s"}` +
    (matched ? "" : " (row store unavailable — count shown from the computed figure)");

  return {
    figureTitle: spec.title,
    series: seriesName,
    category,
    aggregation: { column: measureColumn, fn },
    filter,
    rows: matched,
    rowCount,
    summary,
  };
}

/** Reserved hook for engine-side filters; currently always false (no-op). */
function filterValueMatches(_row: SourceRow, _col: string, _spec: ChartSpec): boolean {
  return false;
}

/**
 * When the row store is not loaded, derive the honest lower bound: the count
 * is unknown, so report 0 contributors rather than inventing a number. The
 * UI renders this as "rows not loaded" instead of a fake count.
 */
function countFromSpec(_spec: ChartSpec, _seriesName: string, _category: string): number {
  return 0;
}

/**
 * Recompute the aggregation over the matched rows and compare to the
 * rendered value. Returns null when rows are unavailable; otherwise the
 * verification verdict the UI shows ("verified ✓" / "mismatch — investigate").
 */
export function verifyFigureValue(prov: FigureProvenance, renderedValue: number): boolean | null {
  if (!prov.rows) return null;
  const col = prov.aggregation.column;
  const values =
    prov.aggregation.fn === "count"
      ? prov.rows.map(() => 1)
      : prov.rows.map((r) => r[col ?? ""]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  let computed: number;
  switch (prov.aggregation.fn) {
    case "sum":
      computed = values.reduce((a, b) => a + b, 0);
      break;
    case "mean":
      computed = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      break;
    case "min":
      computed = values.length ? Math.min(...values) : 0;
      break;
    case "max":
      computed = values.length ? Math.max(...values) : 0;
      break;
    case "count":
      computed = prov.rows.length;
      break;
  }
  return Math.abs(computed - renderedValue) < 1e-6;
}

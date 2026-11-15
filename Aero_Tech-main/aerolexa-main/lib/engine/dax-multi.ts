/**
 * Multi-table DAX over a star model (ROADMAP 2.2 + 2.4).
 *
 * The single-table DAX engine evaluates one flat row set. A star model is the
 * key Power BI abstraction on top of it: a fact table plus dimension tables
 * joined many→one. To reuse the whole engine (context transition, CALCULATE,
 * iterators, time intelligence) without reimplementing a tabular core, this
 * module MATERIALIZES the star into one flat row set:
 *
 *   - fact columns keep their plain names ([Amount], [Date]);
 *   - dimension columns are added under qualified names ("DimCustomer.Segment")
 *     by following each relationship per fact row (orphans become null/BLANK),
 *     exactly like Power BI's row propagation;
 *   - an unambiguous plain dimension column is also reachable unqualified via
 *     the model's `colAliases` — a name shared with the fact or two dimensions
 *     must be table-qualified ('DimCustomer'[Segment]), like DAX.
 *
 * Because RELATED() on a materialized model is the joined value on the fact
 * row, `RELATED('DimCustomer'[Segment])` and table-qualified references work
 * inside CALCULATE/FILTER/iterators without any join recomputation.
 *
 * An optional auto date dimension (ROADMAP 2.4) generates a contiguous
 * DimDate table over the fact's first ISO date column and wires it as the
 * engine's `calendar`, so SAMEPERIODLASTYEAR / PREVIOUS* / NEXT* on a sparse
 * fact see the true prior periods instead of only the dates that happened to
 * be present.
 *
 * Everything is deterministic and hand-computable — the tests pin exact
 * numbers on tiny fixtures (see __tests__/unit/dax-multi.test.ts).
 */

import {
  DaxError,
  evaluateMeasure,
  evaluateMeasureByCategory,
  type DaxFilter,
  type DaxModel,
  type DaxValue,
} from "@/lib/engine/dax";
import { buildDateDimension } from "@/lib/engine/semantic-model";

/** A many→one dimension attached to the fact table. */
export interface MultiDimensionInput {
  /** Table name, e.g. "DimCustomer" — used to qualify its columns. */
  name: string;
  model: DaxModel;
  /** Fact (many side) key column the dimension joins on. */
  fromColumn: string;
  /** Dimension (one side) key column. */
  toColumn: string;
  role?: "dimension" | "date";
}

export interface StarModelInput {
  /** The fact table — its rows define the row set of the model. */
  fact: DaxModel;
  /** Dimensions to materialize (each must refer to a valid fact key column). */
  dimensions?: MultiDimensionInput[];
  /**
   * Auto-wire a contiguous DimDate table over the fact's first ISO date
   * column so time intelligence works on sparse facts (ROADMAP 2.4).
   * Default true.
   */
  autoDateDimension?: boolean;
  /** Expand the calendar to full years around the data (default true). */
  calendarFullYears?: boolean;
  /** The name the auto-generated date table uses (default "DimDate"). */
  dateTableName?: string;
}

export interface StarModel {
  /** The flat, evaluation-ready model (columns + rows + aliases + calendar). */
  model: DaxModel;
  /** Plain fact column names (they are never renamed). */
  factColumns: string[];
  /** The plain fact date column the calendar is wired to, if any. */
  dateColumn: string | null;
  /** Unambiguous plain-name → qualified-column alias map. */
  colAliases: Record<string, string>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: DaxValue): v is string {
  return typeof v === "string" && ISO_DATE.test(v);
}

function isBlank(v: DaxValue): boolean {
  return v === null || v === undefined || v === "";
}

/** First fact column of ISO dates; other values must be blank/int-keys ignored. */
function detectDateColumn(fact: DaxModel): string | null {
  for (const col of fact.columns) {
    const idx = fact.columns.indexOf(col);
    let sawDate = false;
    let isValid = true;
    for (const row of fact.rows) {
      const v = row[idx] ?? null;
      if (isBlank(v)) continue;
      if (isIsoDate(v)) {
        sawDate = true;
        continue;
      }
      isValid = false;
      break;
    }
    if (sawDate && isValid) return col;
  }
  return null;
}

function minMaxDate(col: string, fact: DaxModel): [string, string] {
  const idx = fact.columns.indexOf(col);
  let min = "";
  let max = "";
  for (const row of fact.rows) {
    const v = row[idx] ?? null;
    if (!isIsoDate(v)) continue;
    const d = v.slice(0, 10);
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  if (!min || !max) throw new DaxError(`No valid ISO dates found in “[${col}]”.`);
  return [min, max];
}

/**
 * Flatten the star model into one evaluation-ready row set. Dimension columns
 * are appended per fact row through the join (BLANK on orphans); a contiguous
 * date calendar is wired when `autoDateDimension` finds an ISO date column.
 */
export function materializeStarModel(input: StarModelInput): StarModel {
  const fact = input.fact;
  const dims = input.dimensions ?? [];
  if (dims.length === 0 && !input.autoDateDimension) {
    return {
      model: fact,
      factColumns: [...fact.columns],
      dateColumn: null,
      colAliases: {},
    };
  }

  // Validate fact columns referenced by dimensions.
  const factColumns = [...fact.columns];
  const seenDimNames = new Set<string>();
  const mm: { name: string; model: DaxModel; fromColumn: string; toColumn: string }[] = [];
  for (const d of dims) {
    if (seenDimNames.has(d.name)) throw new DaxError(`Duplicate dimension table name “${d.name}”.`);
    seenDimNames.add(d.name);
    if (!factColumns.includes(d.fromColumn)) {
      throw new DaxError(`Dimension “${d.name}” joins on “[${d.fromColumn}]” which is not a column of the fact table.`);
    }
    if (!d.model.columns.includes(d.toColumn)) {
      throw new DaxError(`Dimension “${d.name}” key column “[${d.toColumn}]” does not exist on its table.`);
    }
    mm.push({ name: d.name, model: d.model, fromColumn: d.fromColumn, toColumn: d.toColumn });
  }

  // Auto date dimension (ROADMAP 2.4).
  let dateColumn: string | null = null;
  let calendarDates: string[] | null = null;
  const fullYears = input.calendarFullYears ?? true;
  const dateTableName = input.dateTableName ?? "DimDate";
  if (input.autoDateDimension !== false) {
    dateColumn = detectDateColumn(fact);
    if (dateColumn) {
      const [lo, hi] = minMaxDate(dateColumn, fact);
      const start = fullYears ? `${Number(lo.slice(0, 4)) - 1}-01-01` : lo;
      const end = fullYears ? `${hi.slice(0, 4)}-12-31` : hi;
      const dim = buildDateDimension({ start, end });
      mm.push({ name: dateTableName, model: dim.model, fromColumn: dateColumn, toColumn: "date" });
      calendarDates = dim.model.rows.map((r) => String(r[1]));
    }
  }

  // Column layout + plain-name aliases.
  const columns = [...factColumns];
  const aliases: Record<string, string> = {};
  const aliasTaken = new Set<string>();
  for (const d of mm) {
    for (const c of d.model.columns) {
      const qualified = `${d.name}.${c}`;
      columns.push(qualified);
      // A plain dimension name that collides with a fact column (or another
      // dimension) must be table-qualified — never alias silently.
      if (factColumns.includes(c) || aliasTaken.has(c)) {
        delete aliases[c];
        continue;
      }
      aliasTaken.add(c);
      aliases[c] = qualified;
    }
  }

  // Row propagation: one output row per fact row, dimension values looked up
  // through each relationship (BLANK for orphans).
  const lookups = mm.map((d) => {
    const keyIdx = d.model.columns.indexOf(d.toColumn);
    const idx = factColumns.indexOf(d.fromColumn);
    const map = new Map<string, DaxValue[]>();
    for (const row of d.model.rows) map.set(String(row[keyIdx] ?? ""), row);
    return { d, keyIdx, map, factKeyIdx: idx, valueIdxs: d.model.columns.map((_, i) => i) };
  });

  const rows: DaxValue[][] = fact.rows.map((factRow) => {
    const out: DaxValue[] = [...factRow];
    for (const l of lookups) {
      const key = String(factRow[l.factKeyIdx] ?? "");
      const dimRow = key === "" ? undefined : l.map.get(key);
      for (const vi of l.valueIdxs) {
        out.push(dimRow ? (dimRow[vi] ?? null) : null);
      }
    }
    return out;
  });

  const model: DaxModel = {
    columns,
    rows,
    ...(Object.keys(aliases).length ? { colAliases: aliases } : {}),
    ...(dateColumn && calendarDates ? { calendar: { dateColumn, dates: calendarDates } } : {}),
  };

  return { model, factColumns, dateColumn, colAliases: aliases };
}

/** Resolve a plain column name to its materialized qualified name. */
export function resolveColumnName(star: StarModel, name: string): string {
  return star.colAliases[name] ?? name;
}

/**
 * Evaluate a full DAX measure over the star model. Filters reference columns
 * by their plain (or qualified) names; the engine resolves aliases.
 */
export function evaluateMultiMeasure(input: StarModelInput, dax: string, filters: DaxFilter[] = []): DaxValue {
  const { model } = materializeStarModel(input);
  return evaluateMeasure(model, dax, filters);
}

/** Evaluate a measure broken out by a category column (fact or dimension). */
export function evaluateMultiMeasureByCategory(
  input: StarModelInput,
  dax: string,
  categoryColumn: string,
  filters: DaxFilter[] = [],
): { category: string; value: DaxValue }[] {
  const star = materializeStarModel(input);
  const resolved = resolveColumnName(star, categoryColumn);
  if (!star.model.columns.includes(resolved)) {
    throw new DaxError(
      `Column “[${categoryColumn}]” is not part of the model. Available: ${star.model.columns.join(", ")}`,
    );
  }
  return evaluateMeasureByCategory(star.model, dax, resolved, filters);
}

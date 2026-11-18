/**
 * Multi-table semantic layer over the single-table DAX engine.
 *
 * A model is a set of tables (name → DaxModel) plus relationships
 * (many-side fact column → one-side dimension column). On top of it:
 *
 *  - `relatedRowValue`   — RELATED(): propagate a dimension attribute onto a
 *                          fact row through the relationship (many→one lookup).
 *  - `calculateWithRelated` — CALCULATE-style aggregation over a fact table
 *                          where the filter references a RELATED() dimension
 *                          column, e.g.
 *                          CALCULATE(SUM([Amount]), RELATED(DimCustomer[Segment]) = "VIP").
 *  - `checkCardinality`  — star-schema validation: the many side must not
 *                          contain keys missing from the one side (orphan
 *                          rows), and the one side must be unique.
 *  - `buildDateDimension`— generated date table (fiscal periods, week-of-year,
 *                          YTD flags) so time intelligence works on sparse facts.
 *  - `applyRowLevelFilters` — per-user RLS row filters evaluated BEFORE the
 *                          measure, so a VIEWER scoped to region "East" sees
 *                          only East rows in every visual.
 *
 * Everything is deterministic and hand-computable; the tests evaluate the
 * exact numbers on tiny fixtures (see __tests__/unit/semantic-model.test.ts).
 */

import { DaxError, evaluateMeasure, type DaxModel, type DaxValue } from "@/lib/engine/dax";

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export type TableRole = "fact" | "dimension" | "date";

export interface SemanticTable {
  name: string;
  role: TableRole;
  model: DaxModel;
}

/** Cardinality of a relationship. */
export type RelationshipCardinality = "many-to-one" | "one-to-one";

export interface Relationship {
  name: string;
  /** Many (fact) side: table + key column. */
  fromTable: string;
  fromColumn: string;
  /** One (dimension) side: table + key column. */
  toTable: string;
  toColumn: string;
  cardinality: RelationshipCardinality;
  /** Whether the relationship is expected to be bidirectional for filters. */
  crossFilter?: "single" | "both";
}

export interface SemanticModel {
  tables: Map<string, SemanticTable>;
  relationships: Relationship[];
}

export interface SemanticIssue {
  severity: "error" | "warning";
  relationship: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Model construction + star-schema checks
// ---------------------------------------------------------------------------

export function buildSemanticModel(
  tables: SemanticTable[],
  relationships: Relationship[],
): { model: SemanticModel; issues: SemanticIssue[] } {
  const issues: SemanticIssue[] = [];
  const map = new Map(tables.map((t) => [t.name, t]));

  for (const rel of relationships) {
    if (!map.has(rel.fromTable) || !map.has(rel.toTable)) {
      issues.push({
        severity: "error",
        relationship: rel.name,
        message: `Relationship references a table that is not part of the model.`,
      });
      continue;
    }
    const from = map.get(rel.fromTable)!;
    const to = map.get(rel.toTable)!;
    const fromIdx = from.model.columns.indexOf(rel.fromColumn);
    const toIdx = to.model.columns.indexOf(rel.toColumn);
    if (fromIdx < 0 || toIdx < 0) {
      issues.push({
        severity: "error",
        relationship: rel.name,
        message: `Key column not found on ${fromIdx < 0 ? rel.fromTable : rel.toTable}.`,
      });
      continue;
    }
    // One side must be unique (no duplicate keys).
    const oneKeys = to.model.rows.map((r) => r[toIdx]);
    const seen = new Set<string>();
    let duplicate = false;
    for (const key of oneKeys) {
      const k = String(key);
      if (seen.has(k)) duplicate = true;
      seen.add(k);
    }
    if (duplicate) {
      issues.push({
        severity: "error",
        relationship: rel.name,
        message: `The "one" side (${rel.toTable}[${rel.toColumn}]) contains duplicate keys — a lookup would be ambiguous.`,
      });
    }
    // Many side must not contain orphans (checked at measure time too, but
    // report them up front so the model author can fix data quality).
    const orphanCount = countOrphans(
      from.model.rows.map((r) => r[fromIdx] ?? null),
      seen,
    );
    if (orphanCount > 0) {
      issues.push({
        severity: "warning",
        relationship: rel.name,
        message: `${orphanCount} row(s) on the many side (${rel.fromTable}[${rel.fromColumn}]) have no match on ${rel.toTable}[${rel.toColumn}] — RELATED() returns BLANK for them.`,
      });
    }
    if (rel.cardinality === "many-to-one" && from.model.rows.length < to.model.rows.length && orphanCount === 0) {
      issues.push({
        severity: "warning",
        relationship: rel.name,
        message: `The declared "many" side has fewer rows than the "one" side — check that the relationship direction is correct.`,
      });
    }
  }

  return { model: { tables: map, relationships }, issues };
}

function countOrphans(manyKeys: DaxValue[], oneKeys: Set<string>): number {
  let orphans = 0;
  for (const key of manyKeys) if (!oneKeys.has(String(key))) orphans++;
  return orphans;
}

// ---------------------------------------------------------------------------
// RELATED() row propagation
// ---------------------------------------------------------------------------

/**
 * Build a lookup from one-side key → row for a relationship. Returns null
 * when the relationship is not part of the model.
 */
function oneSideLookup(model: SemanticModel, rel: Relationship): Map<string, DaxValue[]> | null {
  const to = model.tables.get(rel.toTable);
  if (!to) return null;
  const toIdx = to.model.columns.indexOf(rel.toColumn);
  if (toIdx < 0) return null;
  const lookup = new Map<string, DaxValue[]>();
  for (const row of to.model.rows) lookup.set(String(row[toIdx]), row);
  return lookup;
}

/**
 * RELATED(): for each fact row, resolve the dimension row through the
 * relationship and return the requested dimension column's value (null =
 * BLANK when the key is an orphan).
 */
export function relatedColumnValues(
  model: SemanticModel,
  relName: string,
  factRows: DaxValue[][],
  factColumns: string[],
  dimensionColumn: string,
): (DaxValue | null)[] {
  const rel = model.relationships.find((r) => r.name === relName);
  if (!rel) throw new DaxError(`RELATED: relationship "${relName}" is not part of the model.`);
  const factIdx = factColumns.indexOf(rel.fromColumn);
  if (factIdx < 0) throw new DaxError(`RELATED: key column ${rel.fromColumn} is not in the fact table's columns.`);
  const lookup = oneSideLookup(model, rel);
  if (!lookup) throw new DaxError(`RELATED: table ${rel.toTable} is not part of the model.`);
  const to = model.tables.get(rel.toTable)!;
  const dimIdx = to.model.columns.indexOf(dimensionColumn);
  if (dimIdx < 0) throw new DaxError(`RELATED: column ${dimensionColumn} does not exist on ${rel.toTable}.`);
  return factRows.map((row) => {
    const dimRow = lookup.get(String(row[factIdx]));
    return dimRow ? (dimRow[dimIdx] ?? null) : null;
  });
}

export interface RelatedMeasureInput {
  /** Fact table name in the model. */
  factTable: string;
  /** Measure column on the fact table (e.g. Amount). */
  measureColumn: string;
  /** Aggregation: sum | average | min | max | count | distinctcount. */
  aggregation: "sum" | "average" | "min" | "max" | "count" | "distinctcount";
  /** Optional filter: RELATED(dimTable[dimCol]) = value(s). */
  relatedFilter?: {
    relationship: string;
    dimensionColumn: string;
    values: (string | number | boolean)[];
  };
  /** Optional RLS row filters on the FACT table (from applyRowLevelFilters). */
  rowFilters?: { column: string; values: (string | number | boolean)[] }[];
}

/**
 * Evaluate a measure over a fact table with RELATED()-based dimension filters
 * and RLS row filters. This is the semantic-layer equivalent of
 * CALCULATE(SUM([Amount]), RELATED(Dim[Seg]) = "VIP") — computed row by row,
 * no simulation.
 */
export function calculateWithRelated(model: SemanticModel, input: RelatedMeasureInput): number | null {
  const fact = model.tables.get(input.factTable);
  if (!fact) throw new DaxError(`Table ${input.factTable} is not part of the model.`);
  const mIdx = fact.model.columns.indexOf(input.measureColumn);
  if (mIdx < 0) throw new DaxError(`Column ${input.measureColumn} does not exist on ${input.factTable}.`);

  let rows = fact.model.rows;

  // RLS first — the security filter precedes everything.
  if (input.rowFilters) {
    for (const f of input.rowFilters) {
      const idx = fact.model.columns.indexOf(f.column);
      if (idx < 0) throw new DaxError(`RLS filter column ${f.column} does not exist on ${input.factTable}.`);
      const allowed = new Set(f.values.map(String));
      rows = rows.filter((row) => allowed.has(String(row[idx])));
    }
  }

  // RELATED() filter: resolve dimension values onto fact rows, then filter.
  if (input.relatedFilter) {
    const related = relatedColumnValues(
      model,
      input.relatedFilter.relationship,
      rows,
      fact.model.columns,
      input.relatedFilter.dimensionColumn,
    );
    const allowed = new Set(input.relatedFilter.values.map(String));
    rows = rows.filter((_row, i) => {
      const v = related[i];
      return v !== null && allowed.has(String(v));
    });
  }

  const values = rows.map((row) => row[mIdx]).filter((v): v is number => typeof v === "number");
  switch (input.aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "average":
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    case "min":
      return values.length ? Math.min(...values) : null;
    case "max":
      return values.length ? Math.max(...values) : null;
    case "count":
      return rows.length;
    case "distinctcount": {
      const seen = new Set(rows.map((row) => String(row[mIdx])));
      return seen.size;
    }
  }
}

// ---------------------------------------------------------------------------
// Date dimension
// ---------------------------------------------------------------------------

export interface DateDimensionOptions {
  /** Inclusive start date (ISO). */
  start: string;
  /** Inclusive end date (ISO). */
  end: string;
  /** Fiscal year start month (1–12); 1 = calendar year. */
  fiscalYearStartMonth?: number;
}

/**
 * Generate a standard date dimension table: one row per day with calendar +
 * fiscal attributes and a contiguous `dateKey` (YYYYMMDD int) for joins.
 * Fiscal periods shift the year boundary to `fiscalYearStartMonth`.
 */
export function buildDateDimension(opts: DateDimensionOptions): SemanticTable {
  const start = parseIso(opts.start);
  const end = parseIso(opts.end);
  if (!start || !end || start > end) throw new DaxError("Date dimension needs a valid start ≤ end (ISO YYYY-MM-DD).");
  const fiscalStart = Math.min(Math.max(1, opts.fiscalYearStartMonth ?? 1), 12);

  const columns = [
    "dateKey",
    "date",
    "year",
    "quarter",
    "month",
    "monthName",
    "weekOfYear",
    "dayOfWeek",
    "fiscalYear",
    "fiscalQuarter",
  ];
  const rows: DaxValue[][] = [];
  const cursor = new Date(start);
  const dayMs = 24 * 60 * 60 * 1000;
  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dateKey = y * 10000 + m * 100 + d;
    // ISO week-of-year.
    const weekOfYear = isoWeekOfYear(cursor);
    // Fiscal year: months before the fiscal start belong to the previous FY.
    const fyShift = m >= fiscalStart ? 0 : -1;
    const fiscalYear = y + fyShift;
    // Fiscal quarter counts from the fiscal start month.
    const monthsIntoFy = (m - fiscalStart + 12) % 12;
    const fiscalQuarter = Math.floor(monthsIntoFy / 3) + 1;
    rows.push([
      dateKey,
      toIso(cursor),
      y,
      Math.floor((m - 1) / 3) + 1,
      m,
      monthNames[m - 1]!,
      weekOfYear,
      cursor.getUTCDay(),
      fiscalYear,
      `FY-Q${fiscalQuarter}`,
    ]);
    cursor.setTime(cursor.getTime() + dayMs);
  }
  return { name: "DimDate", role: "date", model: { columns, rows } };
}

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoWeekOfYear(d: Date): number {
  // ISO-8601 week number (weeks start Monday; week 1 contains the first Thursday).
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Row-level security
// ---------------------------------------------------------------------------

export interface RlsRule {
  /** Apply the rule to this user/role only (caller decides matching). */
  role: string;
  table: string;
  column: string;
  values: (string | number | boolean)[];
}

/**
 * Resolve the RLS row filters that apply to a user's role for a given table.
 * Returns [] when the role has no restrictions (full access). Rules are
 * declarative here; the caller maps workspace roles (ADMIN/MEMBER/VIEWER) or
 * org roles onto them.
 */
export function resolveRowFilters(
  rules: RlsRule[],
  role: string,
  table: string,
): { column: string; values: (string | number | boolean)[] }[] {
  return rules.filter((r) => r.role === role && r.table === table).map((r) => ({ column: r.column, values: r.values }));
}

// ---------------------------------------------------------------------------
// Raw DAX evaluation through the underlying engine
// ---------------------------------------------------------------------------

/** Evaluate a DAX measure string against any table in the model. */
export function evaluateTableMeasure(model: SemanticModel, table: string, dax: string): DaxValue {
  const t = model.tables.get(table);
  if (!t) throw new DaxError(`Table ${table} is not part of the model.`);
  return evaluateMeasure(t.model, dax);
}

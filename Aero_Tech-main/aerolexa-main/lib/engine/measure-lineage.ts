/**
 * Measure & column lineage (ROADMAP 2.3) — pure, serializable.
 *
 * Parses a DAX measure expression into its dependency graph:
 *   - table columns it references, as `'Table'[Column]` or `[Column]`;
 *   - measures it calls (bare `MeasureName(` when the name is a known
 *     measure — built-in DAX functions are never treated as measures);
 *   - tables it references explicitly (`'Table'` in ALL/FILTER/VALUES/
 *     RELATEDTABLE/COUNTROWS/LOOKUPVALUE…).
 *
 * Disambiguation rules (mirror DAX authoring):
 *   - `'T'[C]` is always a column of table `T` (measures cannot be
 *     table-qualified);
 *   - `[C]` is a measure when `C` names another known measure, else a
 *     column; a name that matches neither is reported as an unknown/ambiguous
 *     column reference so the UI can surface it honestly instead of guessing.
 *   - identifiers followed by `(` that are not DAX built-ins and match a
 *     known measure are measure calls.
 *
 * Everything is deterministic over the expression text — no execution, no
 * browser, hand-computable in tests.
 */

/** Every built-in function the DAX engine implements (and the DAX canonical
 *  families a measure name may never shadow). A call to one of these is never
 *  a measure reference. */
export const DAX_FUNCTIONS: ReadonlySet<string> = new Set([
  "ABS",
  "ALL",
  "ALLEXCEPT",
  "AND",
  "AVERAGE",
  "AVERAGEX",
  "BLANK",
  "CALCULATE",
  "CALCULATETABLE",
  "CEILING",
  "COALESCE",
  "CONCATENATE",
  "CONCATENATEX",
  "CONTAINSSTRING",
  "COUNT",
  "COUNTBLANK",
  "COUNTROWS",
  "COUNTX",
  "DATEADD",
  "DATESBETWEEN",
  "DATESINPERIOD",
  "DATESMTD",
  "DATESQTD",
  "DATESYTD",
  "DISTINCTCOUNT",
  "DISTINCTCOUNTNOBLANK",
  "DIVIDE",
  "EXP",
  "FILTER",
  "FLOOR",
  "HASONEVALUE",
  "IF",
  "INT",
  "ISBLANK",
  "ISLOGICAL",
  "ISNUMBER",
  "ISTEXT",
  "LEFT",
  "LEN",
  "LN",
  "LOG",
  "LOOKUPVALUE",
  "LOWER",
  "MAX",
  "MAXX",
  "MEDIAN",
  "MID",
  "MIN",
  "MINX",
  "MOD",
  "NEXTDAY",
  "NEXTMONTH",
  "NEXTQUARTER",
  "NEXTYEAR",
  "NOT",
  "OR",
  "PARALLELPERIOD",
  "PI",
  "POWER",
  "PREVIOUSMONTH",
  "PREVIOUSQUARTER",
  "PREVIOUSYEAR",
  "PRODUCT",
  "RANKX",
  "RELATED",
  "RIGHT",
  "ROUND",
  "ROUNDDOWN",
  "ROUNDUP",
  "SAMEPERIODLASTYEAR",
  "SELECTEDVALUE",
  "SIGN",
  "SQRT",
  "STDEV.P",
  "STDEV.S",
  "SUBSTITUTE",
  "SUM",
  "SUMX",
  "SWITCH",
  "TOPN",
  "TOTALMTD",
  "TOTALQTD",
  "TOTALYTD",
  "TREATAS",
  "TRIM",
  "TRUNC",
  "UPPER",
  "VALUES",
  "VAR.P",
  "VAR.S",
  "XOR",
]);

export interface ColumnRef {
  /** Column name (plain, without brackets). */
  name: string;
  /** The referencing table when written table-qualified (`'T'[C]`); null when only `[C]`. */
  table: string | null;
  /**
   * True when `[C]` matched neither a known measure nor a known column — the
   * reference is ambiguous (could be a measure yet to be defined, or a column
   * on a table not in the model). Never guessed.
   */
  ambiguous?: boolean;
}

/** One measure's dependency set. */
export interface MeasureDependencies {
  /** Referenced columns in first-seen order (deduped). */
  columns: ColumnRef[];
  /** Referenced measures in first-seen order (deduped). */
  measures: string[];
  /** Explicitly referenced tables (`'Table'` without a column) deduped. */
  tables: string[];
}

const QUALIFIED_COL = /'([^']+)'\s*\[\s*([^\]]+)\s*\]/g;
const TABLE_TOKEN = /'([^']+)'/g;
const PLAIN_COL = /\[\s*([^\]]+)\s*\]/g;
const CALL = /([A-Za-z_][A-Za-z0-9_. ]*?)\s*\(/g;

/** Normalize + dedupe preserving first-seen order. */
function orderedUnique<T extends string>(values: Iterable<T>): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function orderedUniqueRefs(refs: Iterable<ColumnRef>): ColumnRef[] {
  const out: ColumnRef[] = [];
  const byName = new Map<string, ColumnRef>();
  for (const r of refs) {
    const key = r.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      const copy = { ...r };
      out.push(copy);
      byName.set(key, copy);
      continue;
    }
    // A qualified occurrence is authoritative: upgrade a table-less entry
    // (and clear its ambiguity — the qualified form settles the reference).
    if (existing.table === null && r.table !== null) {
      existing.table = r.table;
      existing.ambiguous = undefined;
    }
  }
  return out;
}

/**
 * Extract a measure expression's dependencies.
 *
 * @param expression  the DAX measure body, e.g. `CALCULATE(SUM('Sales'[Amount]), 'Dim'[Segment] = "VIP")`.
 * @param opts.knownMeasures  names of other measures in the model (their `[Name]` references resolve to measures).
 * @param opts.knownColumns   column names across the model (resolve plain `[Name]` references to columns).
 */
export function extractMeasureDependencies(
  expression: string,
  opts?: { knownMeasures?: Iterable<string>; knownColumns?: Iterable<string> },
): MeasureDependencies {
  const knownMeasures = new Set([...(opts?.knownMeasures ?? [])].map((m) => m.toLowerCase()));
  const knownColumns = new Set([...(opts?.knownColumns ?? [])].map((c) => c.toLowerCase()));

  const columns: ColumnRef[] = [];
  const measures: string[] = [];
  const tables: string[] = [];

  // 1. `'Table'[Column]` — always a table column. The consumed [start, end)
  //    ranges are recorded so step 3 never re-processes the bracket half of a
  //    qualified reference as a plain `[Column]`.
  const qualifiedRanges: { start: number; end: number }[] = [];
  QUALIFIED_COL.lastIndex = 0;
  for (const m of expression.matchAll(QUALIFIED_COL)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    qualifiedRanges.push({ start, end });
    const table = m[1]!.trim();
    const col = m[2]!.trim();
    columns.push({ name: col, table });
    tables.push(table);
  }

  // 2. Standalone `'Table'` tokens (table references in ALL/FILTER/VALUES/…).
  TABLE_TOKEN.lastIndex = 0;
  const plainColMatches: { start: number; end: number; name: string }[] = [];
  PLAIN_COL.lastIndex = 0;
  for (const m of expression.matchAll(PLAIN_COL)) {
    plainColMatches.push({ start: m.index ?? 0, end: m.index! + m[0]!.length, name: m[1]!.trim() });
  }
  for (const m of expression.matchAll(TABLE_TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // The text right after 'T' may be `[`: that's a qualified column — skip.
    const zoom = expression.slice(end).replace(/^\s+/, "");
    const followedByCol = zoom.startsWith("[");
    if (!followedByCol) tables.push(m[1]!.trim());
  }

  // 3. Plain `[ColumnOrMeasure]` references — but never the bracket half of a
  //    qualified `'T'[C]` reference (those were consumed in step 1).
  const inQualifiedRange = (idx: number) => qualifiedRanges.some((r) => idx >= r.start && idx < r.end);
  for (const c of plainColMatches) {
    if (inQualifiedRange(c.start)) continue;
    const name = c.name;
    const lower = name.toLowerCase();
    if (knownMeasures.has(lower)) {
      measures.push(name);
      continue;
    }
    // Not a known measure: a column. Ambiguous when also not a known column.
    const ambiguous = !knownColumns.has(lower);
    columns.push({ name, table: null, ...(ambiguous ? { ambiguous: true } : {}) });
  }

  // 4. Bare `MeasureName(` calls that are not DAX built-ins and match a
  //    known measure.
  CALL.lastIndex = 0;
  for (const m of expression.matchAll(CALL)) {
    const id = m[1]!.trim();
    if (!id) continue;
    if (DAX_FUNCTIONS.has(id.toUpperCase())) continue;
    if (knownMeasures.has(id.toLowerCase())) measures.push(id);
  }

  return {
    columns: orderedUniqueRefs(columns),
    measures: orderedUnique(measures),
    tables: orderedUnique(tables),
  };
}

/**
 * Build the full lineage for a set of measures: `map[name]` → dependencies.
 * Dependency names run through the same resolution as extraction (measures
 * before columns), so a name shared by a measure and a column resolves to the
 * measure — exactly how DAX binds `[X]` when both exist.
 */
export function buildMeasureLineage(
  measures: { name: string; expression: string }[],
  knownColumns?: Iterable<string>,
): Map<string, MeasureDependencies> {
  const names = measures.map((m) => m.name);
  const out = new Map<string, MeasureDependencies>();
  for (const m of measures) {
    out.set(m.name, extractMeasureDependencies(m.expression, { knownMeasures: names, knownColumns }));
  }
  return out;
}

/**
 * Reverse dependency: which measures transitively read a given column or
 * measure? Used by the deletion guard ("deleting this breaks X, Y, Z") and
 * the lineage pane. Depth-limited against pathological recursion.
 */
export function measuresReading(
  lineage: Map<string, MeasureDependencies>,
  target: { name: string; table?: string | null },
): string[] {
  const lower = target.name.toLowerCase();
  const hits = (deps: MeasureDependencies): boolean => {
    if (deps.measures.some((m) => m.toLowerCase() === lower)) return true;
    if (target.table) {
      const t = target.table.toLowerCase();
      return deps.columns.some((c) => c.name.toLowerCase() === lower && c.table?.toLowerCase() === t);
    }
    return deps.columns.some((c) => c.name.toLowerCase() === lower);
  };

  const out: string[] = [];

  // Direct readers: a measure whose own dependencies reference the target.
  for (const [measureName, deps] of lineage) {
    if (hits(deps)) out.push(measureName);
  }

  // A measure target also gains TRANSITIVE readers: X reads the target when X
  // references it directly or through other measures. (Column targets stay
  // direct-only — the deletion guard answers "which measures compute from
  // this column", not "which measures call a measure that does".)
  const isMeasureTarget = [...lineage.keys()].some((k) => k.toLowerCase() === lower);
  if (isMeasureTarget) {
    const seen = new Set(out.map((n) => n.toLowerCase()));
    const queue: string[] = [target.name, ...out];
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i]!.toLowerCase();
      for (const [measureName, deps] of lineage) {
        if (!deps.measures.some((m) => m.toLowerCase() === x)) continue;
        const key = measureName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(measureName);
        queue.push(measureName);
      }
    }
  }
  return orderedUnique(out);
}

/**
 * The columns of one table that a measure reads — the per-table dependency
 * slice the model panel shows next to a relationship (e.g. relationship
 * uses `[CustomerID]` which measure "Revenue" reads).
 */
export function columnsForTable(deps: MeasureDependencies, table: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const wanted = table.toLowerCase();
  const qualified = deps.columns.filter((c) => (c.table ?? "").toLowerCase() === wanted);
  // When the table has qualified references they are authoritative — plain
  // (table-less) columns are attributed only to tables with no qualified
  // refs, where "unknown" is the honest answer.
  const matches = qualified.length > 0 ? qualified : deps.columns.filter((c) => c.table === null);
  for (const c of matches) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.name);
  }
  return out;
}

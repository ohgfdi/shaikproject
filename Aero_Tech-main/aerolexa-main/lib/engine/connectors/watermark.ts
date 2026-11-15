import type { ColType } from "@/lib/types";

/**
 * Incremental sync watermark (Gap ④).
 *
 * A watermark sync re-pulls only rows whose watermark column (an auto-increment
 * id or an updated-at timestamp) has advanced past the last sync. The WHERE
 * fragment is built here so the SQL injection story is testable in one place:
 *
 *   - identifiers are quoted with the engine's own quoting rules,
 *   - the watermark VALUE is ALWAYS a bound parameter ($1 for Postgres, ?
 *     for MySQL) — never string-interpolated,
 *   - the value's JS type matches the column's declared Ledgerly type
 *     (numbers bind as numbers, timestamps as ISO strings), so index usage
 *     and comparisons are correct.
 *
 * Engines without a safe parameterized pull (Snowflake/BigQuery go through
 * query text) deliberately do NOT get watermark SQL here — they keep full
 * pulls rather than accept an interpolated value. Honest degradation, no
 * injection surface.
 */

/**
 * Engines with a safe incremental path:
 *  - postgres/mysql: bound-parameter pulls (the value never touches SQL text).
 *  - snowflake/bigquery: query text goes through a session token, so the
 *    watermark VALUE must be rendered into the statement — allowed only for
 *    numbers (typed by the JS compiler, not by user text) and for string
 *    values matching a strict ISO-8601 regex. Anything else falls back to a
 *    full pull rather than interpolate unvalidated text.
 *  - mongodb: native { [column]: { $gt } } filter — no SQL surface at all.
 */
export type WatermarkEngine = "postgres" | "mysql" | "snowflake" | "bigquery" | "mongodb";

export interface WatermarkFilter {
  column: string;
  /** Strictly greater than the last synced value (the common, safe default). */
  value: string | number;
  valueType: "number" | "string";
}

/** Quote a MySQL identifier (backticks, doubled inside). */
function quoteMySqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * Build the incremental WHERE fragment for an engine that supports bound
 * parameters. Returns the SQL text (WITHOUT the leading WHERE) plus the
 * parameter to bind, in engine-specific placeholder style.
 */
export function buildWatermarkWhere(
  engine: "postgres" | "mysql",
  filter: WatermarkFilter,
): { sql: string; param: string | number } {
  if (!filter.column.trim()) throw new Error("Watermark column is empty.");
  if (filter.value === "" || filter.value === null || filter.value === undefined) {
    throw new Error("Watermark value is empty.");
  }
  const param = filter.valueType === "number" ? Number(filter.value) : String(filter.value);
  if (filter.valueType === "number" && !Number.isFinite(param)) {
    throw new Error("Watermark value is not a finite number.");
  }

  switch (engine) {
    case "postgres":
      return { sql: `"${filter.column.replace(/"/g, '""')}" > $1`, param };
    case "mysql":
      return { sql: `${quoteMySqlIdent(filter.column)} > ?`, param };
  }
}

/** ISO-8601 calendar date or timestamp, optionally with Z / ±HH:MM offset. */
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Render the watermark filter into SQL TEXT for engines whose driver API is
 * query-string-only (Snowflake REST, BigQuery jobs.query). Returns null unless
 * the value provably safe: a JS number, or a strict ISO-8601 timestamp string.
 * A null return is the caller's signal to fall back to a full pull.
 */
export function buildWatermarkSqlText(filter: WatermarkFilter, dialect: "snowflake" | "bigquery"): string | null {
  if (!filter.column.trim()) return null;
  const ident = dialect === "snowflake" || dialect === "bigquery" ? `"${filter.column.replace(/"/g, '""')}"` : null;
  if (!ident) return null;
  if (filter.valueType === "number") {
    const n = Number(filter.value);
    if (!Number.isFinite(n)) return null;
    return `${ident} > ${n}`;
  }
  const s = String(filter.value);
  if (!ISO_TIMESTAMP_RE.test(s)) return null;
  const lit = s.replace(" ", "T");
  return `${ident} > TIMESTAMP '${lit}'`;
}

/**
 * MongoDB native filter for incremental pulls. Returns null when the column
 * name would collide with Mongo's operator syntax or the value is unusable.
 */
export function buildWatermarkMongoFilter(
  column: string,
  value: string | number,
  valueType: "number" | "string",
): Record<string, unknown> | null {
  if (!column.trim() || column.startsWith("$")) return null;
  if (valueType === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return { [column]: { $gt: n } };
  }
  const s = String(value);
  if (!ISO_TIMESTAMP_RE.test(s)) return null;
  return { [column]: { $gt: new Date(s) } };
}

/** Best-effort coercion of a stored watermark string into a bound value. */
export function watermarkFilterFromStored(column: string, storedValue: string, colType: ColType): WatermarkFilter {
  if (colType === "number") {
    const n = Number(storedValue);
    return { column, value: Number.isFinite(n) ? n : storedValue, valueType: "number" };
  }
  return { column, value: String(storedValue), valueType: "string" };
}

/**
 * Track the watermark across a sync: the largest value seen in the pulled
 * rows becomes the next sync's floor. Numbers compare numerically; strings
 * (ISO timestamps) compare lexically, which is correct for ISO-8601.
 */
export function advanceWatermark(
  rows: (string | number | boolean | null)[][],
  columnIndex: number,
  current: string,
): string {
  let max = current;
  for (const row of rows) {
    const cell = row[columnIndex];
    if (cell === null || cell === undefined) continue;
    if (typeof cell === "number") {
      const cur = Number(max);
      if (!Number.isFinite(cur) || cell > cur) max = String(cell);
    } else if (typeof cell === "string" && cell > max) {
      max = cell;
    }
  }
  return max;
}

/**
 * Merge strategy for incremental syncs: APPEND. New rows are concatenated
 * after the stored rows; column sets must match exactly (names + order), or
 * the caller must fall back to a full pull — schema drift is not silently
 * merged. Returns null when the merge is not safe.
 */
export function appendIncrementalRows(
  previousColumns: { name: string; type: string }[],
  newColumns: { name: string; type: string }[],
  previousRows: (string | number | boolean | null)[][],
  newRows: (string | number | boolean | null)[][],
): { columns: { name: string; type: string }[]; rows: (string | number | boolean | null)[][] } | null {
  const a = previousColumns.map((c) => `${c.name}:${c.type}`).join("|");
  const b = newColumns.map((c) => `${c.name}:${c.type}`).join("|");
  if (a !== b || a === "") return null;
  return { columns: previousColumns, rows: [...previousRows, ...newRows] };
}

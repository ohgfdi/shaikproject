/**
 * Shared, environment-agnostic helpers for the DuckDB query path.
 *
 * Both the server-side engine (node:worker_threads + duckdb-node bundle) and
 * the in-browser engine (Web Worker + duckdb-wasm) load a dataset's rows as a
 * typed CSV buffer, create a TEMP table, and run the user's read-only SELECT
 * wrapped in a window-count + LIMIT so `totalMatched` and `truncated` are exact
 * without a second query.
 *
 * Nothing in this file touches node or browser globals — it can be unit-tested
 * in isolation and reused by both runtimes.
 */
import { Type } from "apache-arrow";

import type { ColType, SqlColumn, SqlResultSet, SqlValue } from "@/lib/types";

/** DuckDB is unavailable for execution (init failure). Callers fall back. */
export class DuckDbUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? `DuckDB engine unavailable (${cause.message}).` : "DuckDB engine unavailable.");
    this.name = "DuckDbUnavailableError";
  }
}

/** Internal column used to carry the exact matched-row count in the wrapper. */
export const TOTAL_COLUMN = "__aerolexa_total";

/** Quote an identifier for use in a CREATE TEMP TABLE statement. */
export function quotedIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** DuckDB type names used for the typed read_csv_auto column map. */
export function duckDbType(colType: ColType): string {
  switch (colType) {
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    default:
      // Strings and dates stay VARCHAR so values are preserved verbatim.
      return "VARCHAR";
  }
}

/**
 * Serialize rows to typed CSV so `read_csv_auto` can load them without the JSON
 * extension (which requires external access we intentionally disable).
 * - null/undefined/"" → empty field → NULL in DuckDB
 * - strings are quoted only when they contain a separator, quote or newline
 */
export function buildDatasetCsv(columns: { name: string; type: ColType }[], rows: SqlValue[][]): string {
  const esc = (v: string) =>
    v.includes(",") || v.includes('"') || /[\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const header = columns.map((c) => esc(c.name)).join(",");
  const lines = new Array<string>(rows.length + 1);
  lines[0] = header;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as SqlValue[];
    const cells = new Array<string>(columns.length);
    for (let c = 0; c < columns.length; c++) {
      const v = row[c];
      if (v === null || v === undefined) {
        cells[c] = "";
        continue;
      }
      if (typeof v === "boolean") {
        cells[c] = v ? "true" : "false";
        continue;
      }
      if (typeof v === "number") {
        cells[c] = Number.isFinite(v) ? String(v) : "";
        continue;
      }
      cells[c] = esc(String(v));
    }
    lines[i + 1] = cells.join(",");
  }
  return lines.join("\n");
}

/** Build the `columns={...}` option for read_csv_auto from typed metadata. */
export function buildCsvColumns(columns: { name: string; type: ColType }[]): string {
  return "{" + columns.map((c) => `'${c.name.replace(/'/g, "''")}': '${duckDbType(c.type)}'`).join(", ") + "}";
}

/**
 * One row of a DuckDB `DESCRIBE <select>` result (column_name + column_type).
 */
export interface DescribeColumn {
  name: string;
  type: string;
}

/** Parse a DESCRIBE arrow result (rows keyed by column name) into column defs. */
export function describeToColumns(rows: Record<string, unknown>[]): DescribeColumn[] {
  const out: DescribeColumn[] = [];
  for (const row of rows) {
    const name = row.column_name;
    const type = row.column_type;
    if (typeof name === "string" && typeof type === "string") out.push({ name, type });
  }
  return out;
}

/**
 * DuckDB types whose Arrow representation is numeric and JSON-serializable as
 * a plain number after casting to DOUBLE. BIGINT/HUGEINT/UBIGINT map to JS
 * BigInt and DECIMAL to BigInt in arrow-js, which the node worker's result
 * serializer cannot transfer — casting avoids the boundary entirely.
 */
const NUMERIC_DUCKDB_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "DECIMAL",
]);

/** True when the DESCRIBE type must be cast to DOUBLE before transfer. */
export function isNumericDuckDbType(type: string): boolean {
  return NUMERIC_DUCKDB_TYPES.has(type.trim().toUpperCase());
}

/**
 * True when the type is a nested/composite type that must be flattened to
 * text. DuckDB renders lists as `INTEGER[]` and maps as `MAP(...)`, hence the
 * bracket check in addition to the named composite keywords.
 */
export function isCompositeDuckDbType(type: string): boolean {
  return /(LIST|STRUCT|MAP|ARRAY|ENUM|\[\])/i.test(type);
}

/**
 * Build the final wrapper for a user SELECT so one execution yields exact
 * totals, a hard row cap AND only transfer-safe columns:
 *
 *   SELECT <cast cols>, CAST("__aerolexa_total" AS DOUBLE) AS "__aerolexa_total"
 *   FROM (SELECT *, COUNT(*) OVER () AS "__aerolexa_total" FROM (<sql>) __b) __c
 *   LIMIT <rowCap + 1>
 *
 * `columns` comes from `DESCRIBE <sql>` (planning only — the query itself is
 * never executed twice). Numeric types (incl. BIGINT aggregates like COUNT)
 * are cast to DOUBLE; composite types (LIST/STRUCT/…) are flattened to text;
 * everything else passes through untouched so aliases and types surface
 * correctly. The +1 row lets callers detect truncation truthfully.
 */
export function buildCastSelect(sql: string, columns: DescribeColumn[], rowCap: number): string {
  const clean = sql.replace(/;+\s*$/, "").trim();
  const projections = columns.map((c) => {
    const q = quotedIdentifier(c.name);
    if (isNumericDuckDbType(c.type)) return `CAST(${q} AS DOUBLE) AS ${q}`;
    if (isCompositeDuckDbType(c.type)) return `CAST(${q} AS VARCHAR) AS ${q}`;
    return q;
  });
  projections.push(`CAST("${TOTAL_COLUMN}" AS DOUBLE) AS "${TOTAL_COLUMN}"`);
  const inner = `SELECT *, COUNT(*) OVER () AS "${TOTAL_COLUMN}" FROM (${clean}) __b`;
  return `SELECT ${projections.join(", ")} FROM (${inner}) __c LIMIT ${rowCap + 1}`;
}

/**
 * Turn a raw DuckDB error into a user-facing one-liner. DuckDB appends a
 * "LINE 1: <echoed query>" pointer plus (in dev builds) a stack trace — those
 * reference the internal wrapper, not the user's query, so we keep only the
 * readable head (e.g. `Binder Error: Referenced column "nope" not found…`).
 */
export function duckDbErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const head = raw.split(/\nLINE /)[0]?.trim() ?? "";
  return head || "The query could not be executed by the DuckDB engine.";
}

/** Map an Apache Arrow type id to Ledgerly ColType for result columns. */
export function arrowToColType(typeId: number | undefined): ColType {
  switch (typeId) {
    case Type.Int:
    case Type.Float:
    case Type.Decimal:
      return "number";
    case Type.Bool:
      return "boolean";
    case Type.Date:
    case Type.DateDay:
    case Type.DateMillisecond:
    case Type.Time:
    case Type.Timestamp:
      return "date";
    default:
      return "string";
  }
}

/**
 * Convert an Arrow RecordBatch row into plain SqlValue[] honoring column order
 * from the schema, stripping the wrapper's total column. BigInt values are
 * coerced to Number (safe below 2^53 — row caps keep us far under that).
 */
export function arrowRowToValues(
  row: Record<string, unknown>,
  fields: { name: string; type: { typeId?: number } }[],
  totalIndex: number,
): SqlValue[] {
  const out: SqlValue[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (i === totalIndex) continue;
    const v = row[fields[i]?.name ?? ""];
    if (typeof v === "bigint") out.push(Number(v));
    else if (v instanceof Date) out.push(v.toISOString().slice(0, 10));
    else if (v === null || v === undefined) out.push(null);
    else out.push(v as SqlValue);
  }
  return out;
}

/** Shape of the arrow table result exposed by both engines. */
export interface DuckDbArrowResult {
  /** schema fields (including the total column) */
  fields: { name: string; type: { typeId?: number } }[];
  /** rows as plain objects keyed by field name */
  rows: Record<string, unknown>[];
}

/**
 * Build the final SqlResultSet from an Arrow result + timing.
 * Result columns come from the query's own schema (not the dataset), so
 * aliases and aggregates surface correctly, with names + inferred types.
 */
export function toSqlResultSet(
  r: DuckDbArrowResult,
  rowCap: number,
  executionMs: number,
  coverageNote: string,
): SqlResultSet {
  const totalIndex = r.fields.findIndex((f) => f.name === TOTAL_COLUMN);
  const total =
    totalIndex >= 0 && r.rows.length > 0 ? Number((r.rows[0] as Record<string, unknown>)[TOTAL_COLUMN] ?? 0) : 0;

  const resultColumns: SqlColumn[] = [];
  for (let i = 0; i < r.fields.length; i++) {
    if (i === totalIndex) continue;
    const f = r.fields[i] as { name: string; type: { typeId?: number } };
    resultColumns.push({ name: f.name, type: arrowToColType(f.type?.typeId) });
  }

  const rows = r.rows.map((row) => arrowRowToValues(row, r.fields, totalIndex));
  const truncated = rows.length > rowCap;
  const limited = truncated ? rows.slice(0, rowCap) : rows;

  return {
    columns: resultColumns,
    rows: limited,
    rowCount: limited.length,
    totalMatched: total,
    truncated,
    engine: "duckdb",
    note: `DuckDB (vectorized, in-memory) executed the query over the dataset rows${coverageNote ? ` — ${coverageNote}` : ""}. Read-only SELECT only; external file access is disabled.`,
    executionMs,
  };
}

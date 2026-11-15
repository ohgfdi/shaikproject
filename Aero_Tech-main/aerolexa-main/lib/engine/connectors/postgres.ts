/**
 * Real PostgreSQL connector (node-postgres over TCP — no socket hacks).
 *
 * Connections are opened read-only at the protocol level
 * (`default_transaction_read_only=on`), time-boxed on connect and per-query,
 * and every failure is translated by `friendlyPgError` into the app's
 * "What happened / How to fix" pattern. Schema introspection reads
 * information_schema; samples and imports use quoted identifiers so table
 * names with spaces or reserved words work.
 */
import { Client, type QueryResultRow } from "pg";

import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

import type { PostgresConfig } from "./config";
import { ConnectorError, friendlyPgError } from "./errors";

export const CONNECTOR_CONNECT_TIMEOUT_MS = 10_000;
export const CONNECTOR_QUERY_TIMEOUT_MS = 30_000;
export const MAX_SAMPLE_ROWS = 5000;

export interface PgColumnInfo {
  name: string;
  dataType: string; // declared type from information_schema (e.g. "timestamp without time zone")
  nullable: boolean;
}

export interface PgTableInfo {
  schema: string;
  name: string;
  columns: PgColumnInfo[];
}

export interface PgSampleResult {
  columns: { name: string; type: string; colType: ColType }[];
  rows: SqlValue[][];
  /** Total rows in the table (before LIMIT). */
  rowCount: number;
}

export interface PgTableRows {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
  totalRows: number;
  truncated: boolean;
}

export interface PgConnectionMeta {
  serverVersion: string;
  latencyMs: number;
  database: string;
}

function clientOptions(config: PostgresConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECTOR_CONNECT_TIMEOUT_MS,
    query_timeout: CONNECTOR_QUERY_TIMEOUT_MS,
    statement_timeout: CONNECTOR_QUERY_TIMEOUT_MS,
    // Protocol-level read-only: any accidental write attempt fails server-side.
    options: "-c default_transaction_read_only=on",
  };
}

/** Open a read-only client, run `fn`, always close. Errors are mapped cleanly. */
export async function withPgClient<T>(config: PostgresConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(clientOptions(config));
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw friendlyPgError(err, `${config.host}:${config.port}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Verify the connection answers `SELECT version()` and report latency. */
export async function testPostgresConnection(config: PostgresConfig): Promise<PgConnectionMeta> {
  const started = Date.now();
  return withPgClient(config, async (client) => {
    const result = await client.query<{ version: string }>("SELECT version() AS version");
    const version = result.rows[0]?.version ?? "";
    return {
      serverVersion: version.split(" ")[1] ?? (version.slice(0, 40) || "unknown"),
      latencyMs: Date.now() - started,
      database: config.database,
    };
  });
}

/** Quote a single PostgreSQL identifier (schema, table, or column). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * List base tables and their columns from information_schema — real
 * introspection, never a hardcoded list. `pg_catalog` / `information_schema`
 * are excluded; the connected user only sees what they have privileges on.
 */
export async function listPostgresTables(client: Client): Promise<PgTableInfo[]> {
  const tables = await client.query<{ schema: string; name: string }>(
    `SELECT table_schema AS schema, table_name AS name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name`,
  );
  const columns = await client.query<{ schema: string; name: string; column: string; type: string; nullable: string }>(
    `SELECT table_schema AS schema, table_name AS name, column_name AS column, data_type AS type, is_nullable AS nullable
       FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position`,
  );
  const byKey = new Map<string, PgTableInfo>();
  for (const table of tables.rows) {
    byKey.set(`${table.schema}.${table.name}`, { schema: table.schema, name: table.name, columns: [] });
  }
  for (const column of columns.rows) {
    byKey.get(`${column.schema}.${column.name}`)?.columns.push({
      name: column.column,
      dataType: column.type,
      nullable: column.nullable === "YES",
    });
  }
  return tables.rows.map((table) => byKey.get(`${table.schema}.${table.name}`)!);
}

/** Pull up to `limit` sample rows (row order is the source's natural order). */
export async function samplePostgresRows(
  client: Client,
  schema: string,
  table: string,
  limit: number,
): Promise<PgSampleResult> {
  const source = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const safeLimit = Math.max(1, Math.min(limit, MAX_SAMPLE_ROWS));
  const countResult = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${source}`);
  const rowCount = Number(countResult.rows[0]?.n ?? 0);
  const sample = await client.query(`SELECT * FROM ${source} LIMIT $1`, [safeLimit]);
  const columns = await declaredColumns(
    client,
    schema,
    table,
    sample.fields.map((f) => f.name),
  );
  const rows = sample.rows.map((row) => columns.map((column) => pgToCell(row[column.name])));
  return { columns, rows, rowCount };
}

/**
 * Fetch up to `limit` rows for import into a Dataset. Columns are typed for
 * Ledgerly's profiler (ColType) so imported data flows through the exact same
 * pipeline as CSV uploads.
 */
export async function fetchPostgresTableRows(
  client: Client,
  schema: string,
  table: string,
  limit: number,
): Promise<PgTableRows> {
  const source = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const countResult = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${source}`);
  const totalRows = Number(countResult.rows[0]?.n ?? 0);
  const data = await client.query(`SELECT * FROM ${source} LIMIT $1`, [Math.max(1, limit)]);
  const declared = await declaredColumns(
    client,
    schema,
    table,
    data.fields.map((f) => f.name),
  );
  const columns = declared.map((column) => ({ name: column.name, type: column.colType }));
  const rows = data.rows.map((row) => columns.map((column) => pgToCell(row[column.name])));
  return { columns, rows, totalRows, truncated: totalRows > rows.length };
}

/**
 * Incremental (watermark) pull: rows of `schema.table` whose `column` is
 * strictly greater than the bound `since` value, up to `limit` rows. The
 * watermark value is ALWAYS a bound parameter — never interpolated.
 */
export async function fetchPostgresTableRowsIncremental(
  client: Client,
  schema: string,
  table: string,
  column: string,
  since: string | number,
  limit: number,
): Promise<PgTableRows> {
  const source = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const where = `"${column.replace(/"/g, '""')}" > $1`;
  const countResult = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${source} WHERE ${where}`, [
    since,
  ]);
  const totalRows = Number(countResult.rows[0]?.n ?? 0);
  const data = await client.query(`SELECT * FROM ${source} WHERE ${where} ORDER BY ${where.split(" > ")[0]} LIMIT $2`, [
    since,
    Math.max(1, limit),
  ]);
  const declared = await declaredColumns(
    client,
    schema,
    table,
    data.fields.map((f) => f.name),
  );
  const columns = declared.map((column) => ({ name: column.name, type: column.colType }));
  const rows = data.rows.map((row) => columns.map((c) => pgToCell(row[c.name])));
  return { columns, rows, totalRows, truncated: totalRows > rows.length };
}

async function declaredColumns(
  client: Client,
  schema: string,
  table: string,
  fieldNames: string[],
): Promise<{ name: string; type: string; colType: ColType }[]> {
  const declared = await client.query<{ column: string; type: string }>(
    `SELECT column_name AS column, data_type AS type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  const byName = new Map(declared.rows.map((row) => [row.column, row.type]));
  return fieldNames.map((name) => {
    const dataType = byName.get(name) ?? "text";
    return { name, type: dataType, colType: pgTypeToColType(dataType) };
  });
}

/** Map a PostgreSQL declared data type to Ledgerly's ColType. */
export function pgTypeToColType(dataType: string): ColType {
  const t = dataType.toLowerCase();
  if (t === "boolean") return "boolean";
  if (t.startsWith("date") || t.startsWith("time") || t.includes("timestamp")) return "date";
  if (
    t === "smallint" ||
    t === "integer" ||
    t === "bigint" ||
    t === "decimal" ||
    t === "numeric" ||
    t === "real" ||
    t === "double precision" ||
    t === "smallserial" ||
    t === "serial" ||
    t === "bigserial" ||
    t === "money" ||
    /^(int|float|double|numeric|decimal|real|serial|money)/.test(t)
  ) {
    return "number";
  }
  return "string";
}

/** Convert a node-postgres cell to a serializable SqlValue. */
export function pgToCell(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "object") return JSON.stringify(value as QueryResultRow);
  return String(value);
}

/** Run a read-only SELECT query against a PostgreSQL connector config. */
export async function runPostgresQuery(
  config: PostgresConfig,
  sql: string,
  opts: { rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  const rowCap = opts.rowCap ?? 5000;
  const coverageNote = opts.coverageNote ?? "";
  const client = new Client(clientOptions(config));
  const startedAt = Date.now();
  try {
    await client.connect();
    const safeLimit = Math.max(1, Math.min(rowCap, MAX_SAMPLE_ROWS));
    const countResult = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM (${sql}) subq`);
    const rowCount = Number(countResult.rows[0]?.n ?? 0);
    // Run the actual query with LIMIT
    const sample = await client.query(`SELECT * FROM (${sql}) subq LIMIT $1`, [safeLimit]);
    // Type every output column from the field OID (server-reported type of
    // the SELECT's actual output) — reliable for expressions, CASE and joins,
    // unlike an information_schema probe that only works for bare columns.
    const columns = sample.fields.map((field) => ({
      name: field.name,
      type: pgTypeToColType(oidToTypeName(field.dataTypeID)),
    }));
    const rows = sample.rows.map((row) => columns.map((column) => pgToCell(row[column.name])));
    const truncated = rowCount > rowCap;
    return {
      columns,
      rows,
      rowCount,
      totalMatched: rowCount,
      truncated,
      engine: "postgres-connector",
      executionMs: Date.now() - startedAt,
      note: `PostgreSQL connector — read-only SELECT over connected database “${config.database}”. Results capped at ${rowCap.toLocaleString()} rows${truncated ? " (truncated)" : ""}. ${coverageNote}`.trim(),
    };
  } catch (err) {
    throw friendlyPgError(err, `${config.host}:${config.port}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Map the subset of PostgreSQL type OIDs the analyzer needs to type names. */
const PG_TYPE_OIDS: Record<number, string> = {
  16: "boolean",
  17: "bytea",
  18: "char",
  19: "name",
  20: "bigint",
  21: "smallint",
  23: "integer",
  25: "text",
  26: "oid",
  114: "json",
  142: "xml",
  700: "real",
  701: "double precision",
  705: "unknown",
  1042: "character",
  1043: "character varying",
  1082: "date",
  1083: "time without time zone",
  1114: "timestamp without time zone",
  1184: "timestamp with time zone",
  1186: "interval",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
};

/** Resolve a field's type OID to a human type name (falls back to "text"). */
export function oidToTypeName(oid: number): string {
  return PG_TYPE_OIDS[oid] ?? "text";
}

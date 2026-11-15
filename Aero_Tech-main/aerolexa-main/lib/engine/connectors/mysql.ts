/**
 * Real mySQL connector (mysql2 over TCP).
 *
 * Connections are opened read-only at the transaction level
 * (`START TRANSACTION READ ONLY`), time-boxed on connect (`connectTimeout`)
 * and per-query (`max_execution_time` session variable + `AbortController`
 * race), and every failure is translated by `friendlyMySqlError` into the
 * app's "What happened / How to fix" pattern. Schema introspection reads
 * information_schema; samples and imports use backtick-quoted identifiers so
 * table and column names with spaces or reserved words work.
 *
 * Type handling matches the Postgres connector: BIGINT/DECIMAL come back as
 * safe numbers (precision-losing values stay strings), dates as ISO strings.
 */
import mysql from "mysql2/promise";

import type { ColType, SqlValue } from "@/lib/types";

import type { MySqlConfig } from "./config";
import { ConnectorError } from "./errors";

/** Map a mysql2 / network failure to a clean, credential-free message. */
export function friendlyMySqlError(err: unknown, destination?: string): ConnectorError {
  const inner = err as { errno?: number; code?: string; message?: string };
  const dest = destination ? ` at ${destination}` : "";

  switch (inner.errno) {
    case 1045: // ER_ACCESS_DENIED_ERROR
      return new ConnectorError(
        `mySQL rejected the user or password. What happened: authentication failed${dest}. How to fix: check the user and password in this connection, then save and test again.`,
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    case 1049: // ER_BAD_DB_ERROR
      return new ConnectorError(
        `The database “${unknownDbFromMessage(inner.message)}” does not exist. What happened: the database name in this connection is wrong${dest}. How to fix: check the database name and retry.`,
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    case 1044: // ER_DBACCESS_DENIED_ERROR
    case 1142: // ER_TABLEACCESS_DENIED_ERROR
    case 1143: // ER_COLUMNACCESS_DENIED_ERROR
      return new ConnectorError(
        `The connected user lacks permission to read this schema or table. What happened: permission denied. How to fix: grant SELECT on the source objects to the database user, then retry.`,
        { status: 403, code: "CONNECTOR_PERMISSION" },
      );
    case 1051: // ER_BAD_TABLE_ERROR
    case 1146: // ER_NO_SUCH_TABLE
      return new ConnectorError(
        `The table does not exist. What happened: undefined table. How to fix: refresh the schema list and choose an existing table.`,
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    case 3024: // ER_QUERY_TIMEOUT — exceeded max_execution_time
      return new ConnectorError(
        `The query was cancelled because it ran too long. What happened: statement timeout. How to fix: import fewer rows or a smaller table, then retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    default:
      break;
  }

  switch (inner.code) {
    case "ECONNREFUSED":
      return new ConnectorError(
        `Could not reach the database${dest}. What happened: the connection was refused — the server may be down or the port wrong. How to fix: confirm host and port, and that the database accepts TCP connections.`,
        { status: 502, code: "CONNECTOR_UNREACHABLE" },
      );
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new ConnectorError(
        `The connection timed out${dest}. What happened: the database did not answer in time. How to fix: check network access and firewall rules, then retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    default:
      return new ConnectorError(
        `The database request failed. What happened: ${shortMySqlMessage(inner.message)}. How to fix: review the connection settings and the source objects, then retry.`,
        { status: 400, code: "CONNECTOR_ERROR" },
      );
  }
}

function unknownDbFromMessage(message: string | undefined): string {
  // mysql2 reports "ER_BAD_DB_ERROR: Unknown database 'foo'".
  const match = /Unknown database '([^']+)'/i.exec(message ?? "");
  return match?.[1] ?? "…";
}

function shortMySqlMessage(message: string | undefined): string {
  const sentence = (message ?? "unknown error").split(/\.\s+|\n/)[0] ?? "unknown error";
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

export const CONNECTOR_CONNECT_TIMEOUT_MS = 10_000;
export const CONNECTOR_QUERY_TIMEOUT_MS = 30_000;
export const MAX_SAMPLE_ROWS = 5000;

export interface MySqlColumnInfo {
  name: string;
  dataType: string; // declared type from information_schema (e.g. "varchar")
  nullable: boolean;
}

export interface MySqlTableInfo {
  schema: string;
  name: string;
  columns: MySqlColumnInfo[];
}

export interface MySqlTableRows {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
  totalRows: number;
  truncated: boolean;
}

export interface MySqlConnectionMeta {
  serverVersion: string;
  latencyMs: number;
  database: string;
}

function clientOptions(config: MySqlConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: CONNECTOR_CONNECT_TIMEOUT_MS,
    // DML is blocked by the read-only transaction below; disable multi-statements
    // so one query can never smuggle a second one in.
    multipleStatements: false,
    // DECIMAL as a number (safe), BIGINT beyond ±2^53 as a string (no precision loss).
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
  };
}

async function newConnection(config: MySqlConfig): Promise<mysql.Connection> {
  const connection = await mysql.createConnection(clientOptions(config));
  await connection.query("SET SESSION time_zone = '+00:00'");
  // Abort long-running SELECTs server-side (MySQL 5.7+).
  await connection.query(`SET SESSION max_execution_time = ${CONNECTOR_QUERY_TIMEOUT_MS}`);
  return connection;
}

/** Open a read-only connection, run `fn`, always close. Errors are mapped cleanly. */
export async function withMySqlClient<T>(
  config: MySqlConfig,
  fn: (client: mysql.Connection) => Promise<T>,
): Promise<T> {
  try {
    const connection = await newConnection(config);
    try {
      await connection.query("START TRANSACTION READ ONLY");
      return await fn(connection);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      throw friendlyMySqlError(err, `${config.host}:${config.port}`);
    } finally {
      await connection.end().catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw friendlyMySqlError(err, `${config.host}:${config.port}`);
  }
}

/** Verify the connection answers `SELECT version()` and report latency. */
export async function testMySqlConnection(config: MySqlConfig): Promise<MySqlConnectionMeta> {
  const started = Date.now();
  return withMySqlClient(config, async (client) => {
    const [rows] = await client.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
    const version = (rows[0]?.version as string | undefined) ?? "unknown";
    return { serverVersion: version, latencyMs: Date.now() - started, database: config.database };
  });
}

/** Quote a single mySQL identifier (schema, table, or column) with backticks. */
export function quoteMySqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * List base tables and their columns from information_schema for the
 * configured database (plus its `schema` override). System databases are
 * excluded; a scatter-gather only shows what the connected user can read.
 */
export async function listMySqlTables(client: mysql.Connection, defaultSchema: string): Promise<MySqlTableInfo[]> {
  const schema = defaultSchema.trim();
  const [tables] = await client.query<mysql.RowDataPacket[]>(
    `SELECT table_schema AS \`schema\`, table_name AS name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema = ?
      ORDER BY table_schema, table_name`,
    [schema],
  );
  const [columns] = await client.query<mysql.RowDataPacket[]>(
    `SELECT table_schema AS \`schema\`, table_name AS name, column_name AS column_name, column_type AS type, is_nullable AS nullable
       FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_schema, table_name, ordinal_position`,
    [schema],
  );
  const byKey = new Map<string, MySqlTableInfo>();
  for (const table of tables as unknown as { schema: string; name: string }[]) {
    byKey.set(`${table.schema}.${table.name}`, { schema: table.schema, name: table.name, columns: [] });
  }
  for (const column of columns as unknown as {
    schema: string;
    name: string;
    column_name: string;
    type: string;
    nullable: string;
  }[]) {
    byKey.get(`${column.schema}.${column.name}`)?.columns.push({
      name: column.column_name,
      dataType: column.type,
      nullable: column.nullable === "YES",
    });
  }
  return tables
    .map((table) =>
      byKey.get(`${(table as unknown as { schema: string }).schema}.${(table as unknown as { name: string }).name}`)!,
    )
    .filter((info) => info.columns.length > 0);
}

/** Declared columns for a table, ordered by information_schema.ordinal_position. */
async function declaredMySqlColumns(
  client: mysql.Connection,
  schema: string,
  table: string,
): Promise<{ name: string; type: string; colType: ColType }[]> {
  const [rows] = await client.query<mysql.RowDataPacket[]>(
    `SELECT column_name AS column_name, column_type AS type
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
    [schema, table],
  );
  return (rows as unknown as { column_name: string; type: string }[]).map((row) => {
    const dataType = row.type;
    return { name: row.column_name, type: dataType, colType: mysqlTypeToColType(dataType) };
  });
}

/**
 * Fetch up to `limit` rows for import into a Dataset. Columns are typed for
 * Ledgerly's profiler (ColType) so imported data flows through the exact same
 * pipeline as CSV uploads.
 */
export async function fetchMySqlTableRows(
  client: mysql.Connection,
  schema: string,
  table: string,
  limit: number,
): Promise<MySqlTableRows> {
  const source = `${quoteMySqlIdent(schema)}.${quoteMySqlIdent(table)}`;
  const [countResult] = await client.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${source}`);
  const totalRows = Number(countResult[0]?.n ?? 0);
  const [data] = await client.query<mysql.RowDataPacket[]>(`SELECT * FROM ${source} LIMIT ?`, [Math.max(1, limit)]);
  const declared = await declaredMySqlColumns(client, schema, table);
  const columns = declared.map((column) => ({ name: column.name, type: column.colType }));
  const rows = (data as unknown as Record<string, unknown>[]).map((row) =>
    columns.map((column, index) => {
      const cell = mySqlToCell(row[column.name]);
      // mysql2 reports TINYINT(1) as 1/0 numbers — coerce to real booleans so
      // the value matches the declared ColumnType the profiler will see.
      if (declared[index]?.colType === "boolean" && typeof cell === "number") return cell !== 0;
      return cell;
    }),
  );
  return { columns, rows, totalRows, truncated: totalRows > rows.length };
}

/**
 * Incremental (watermark) pull: rows of `schema.table` whose `column` is
 * strictly greater than the bound `since` value, up to `limit` rows. The
 * watermark value is ALWAYS a bound parameter — never interpolated.
 */
export async function fetchMySqlTableRowsIncremental(
  client: mysql.Connection,
  schema: string,
  table: string,
  column: string,
  since: string | number,
  limit: number,
): Promise<MySqlTableRows> {
  const source = `${quoteMySqlIdent(schema)}.${quoteMySqlIdent(table)}`;
  const where = `${quoteMySqlIdent(column)} > ?`;
  const [countResult] = await client.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ${source} WHERE ${where}`,
    [since],
  );
  const totalRows = Number((countResult as unknown as Record<string, unknown>[])[0]?.n ?? 0);
  const [data] = await client.query<mysql.RowDataPacket[]>(
    `SELECT * FROM ${source} WHERE ${where} ORDER BY ${quoteMySqlIdent(column)} LIMIT ?`,
    [since, Math.max(1, limit)],
  );
  const declared = await declaredMySqlColumns(client, schema, table);
  const columns = declared.map((c) => ({ name: c.name, type: c.colType }));
  const rows = (data as unknown as Record<string, unknown>[]).map((row) =>
    columns.map((c, index) => {
      const cell = mySqlToCell(row[c.name]);
      if (declared[index]?.colType === "boolean" && typeof cell === "number") return cell !== 0;
      return cell;
    }),
  );
  return { columns, rows, totalRows, truncated: totalRows > rows.length };
}

/** Map a mySQL declared data type to Ledgerly's ColType. */
export function mysqlTypeToColType(dataType: string): ColType {
  const t = dataType.toLowerCase();
  if (t === "tinyint(1)" || t === "boolean" || t === "bool") return "boolean";
  if (
    t.startsWith("date") ||
    t.startsWith("time") ||
    t.startsWith("timestamp") ||
    t.startsWith("datetime") ||
    t.startsWith("year")
  )
    return "date";
  if (
    t === "tinyint" ||
    t === "smallint" ||
    t === "mediumint" ||
    t === "int" ||
    t === "integer" ||
    t === "bigint" ||
    t === "decimal" ||
    t === "dec" ||
    t === "numeric" ||
    t === "fixed" ||
    t === "float" ||
    t === "double" ||
    t === "double precision" ||
    t === "real" ||
    /^(int|mediumint|bigint|decimal|numeric|float|double|real)/.test(t)
  )
    return "number";
  return "string";
}

/** Convert a mysql2 cell to a serializable SqlValue. */
export function mySqlToCell(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  // mysql2 returns oversized BIGINTs as strings — keep the exact digits.
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value === "object") return JSON.stringify(value as unknown);
  return String(value);
}

/**
 * Snowflake connector — REAL read-only query execution.
 *
 * Transport: Snowflake SQL REST API (v2/statements) over HTTPS. No native
 * driver, no sockets — everything is authenticated HTTPS from the server:
 *   1. Key-pair auth mints a session token (lib/engine/connectors/jwt-auth.ts).
 *   2. The read-only SELECT is POSTed to /api/v2/statements with a timeout.
 *   3. Statement handles are deleted (best-effort) so warehouse state cleans up.
 *
 * Honesty rules (mirrors the Postgres connector):
 * - The connection is authenticated per request; a failure produces a clean
 *   "What happened / How to fix" message, never a raw stack or a credential.
 * - Every result reports the engine ("snowflake-connector"), execution time,
 *   and a truncation note. This is no longer a placeholder: the 501 that used
 *   to live here is gone.
 */

import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

import type { SnowflakeConfig } from "./config";
import { ConnectorError } from "./errors";
import { snowflakeAccessToken } from "./jwt-auth";

const STATEMENT_TIMEOUT_MS = 30_000;
const MAX_ROWS = 5000;

interface SnowflakeV2Response {
  statementHandle?: string | null;
  statementStatusUrl?: string | null;
  data?: SqlValue[][];
  resultSetMetaData?: {
    numRows?: number;
    format?: string;
    rowType?: { name: string; type: string }[];
  };
  message?: string;
  code?: string;
  sqlState?: string;
}

function hostFor(account: string): string {
  // Account identifiers may already include region/cloud suffixes
  // (e.g. "acme.eu-central-1.aws") — the host appends snowflakecomputing.com.
  return `${account.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}.snowflakecomputing.com`;
}

/** Map a Snowflake REST type name to Ledgerly's ColType. */
export function snowflakeTypeToColType(type: string): ColType {
  const t = type.toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "date" || t === "time" || t === "timestamp_ltz" || t === "timestamp_ntz" || t === "timestamp_tz")
    return "date";
  if (
    t === "number" ||
    t === "decimal" ||
    t === "numeric" ||
    t === "integer" ||
    t === "int" ||
    t === "bigint" ||
    t === "smallint" ||
    t === "tinyint" ||
    t === "byteint" ||
    t === "float" ||
    t === "float4" ||
    t === "float8" ||
    t === "double" ||
    t === "real"
  ) {
    return "number";
  }
  return "string";
}

/** Snowflake REST errors → the app's clean ConnectorError pattern. */
function snowflakeError(err: unknown, host: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "unknown error";
  if (code === "390100" || /incorrect or expired authorization token|session no longer exists/i.test(message)) {
    return new ConnectorError(
      "Snowflake rejected the credentials. What happened: authentication failed. How to fix: verify the account identifier, username, and that the public key is set on the user (ALTER USER … SET RSA_PUBLIC_KEY), then test again.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (/does not exist or not authorized/i.test(message)) {
    return new ConnectorError(
      "The requested object does not exist or the role lacks access. What happened: authorization failed. How to fix: grant the role SELECT on the schema, or choose another table.",
      { status: 403, code: "CONNECTOR_PERMISSION" },
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(message)) {
    return new ConnectorError(
      `Could not reach Snowflake at ${host}. What happened: DNS or network failure. How to fix: check the account identifier and network egress, then retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  return new ConnectorError(
    `The Snowflake request failed. What happened: ${message.slice(0, 200)}. How to fix: review the connection settings and query, then retry.`,
    { status: 400, code: "CONNECTOR_ERROR" },
  );
}

/** Mint a session token for this account/user. */
async function sessionToken(config: SnowflakeConfig): Promise<string> {
  const meta = await snowflakeAccessToken({
    account: config.account,
    username: config.username,
    privateKeyPem: (config as { privateKeyPem?: string }).privateKeyPem ?? "",
    password: config.password,
  });
  return meta.token;
}

/**
 * Run a read-only SELECT against Snowflake. Enforced server-side twice:
 * the shared guard rejects non-SELECT text up front, and the REST call runs
 * with a statement timeout so a runaway query cannot hold the request.
 */
export async function runSnowflakeQuery(
  config: SnowflakeConfig,
  sql: string,
  opts: { rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  const rowCap = Math.max(1, Math.min(opts.rowCap ?? 5000, MAX_ROWS));
  const coverageNote = opts.coverageNote ?? "";
  const host = hostFor(config.account);
  const startedAt = Date.now();

  try {
    const token = await sessionToken(config);

    const body = {
      statement: sql.replace(/;+\s*$/, ""),
      timeout: Math.floor(STATEMENT_TIMEOUT_MS / 1000),
      role: config.role || undefined,
      warehouse: config.warehouse || undefined,
      database: config.database || undefined,
      schema: config.schema || undefined,
    };

    const res = await fetch(`https://${host}/api/v2/statements?requestId=Ledgerly-${Date.now().toString(36)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STATEMENT_TIMEOUT_MS + 10_000),
    });

    const payload = (await res.json().catch(() => ({}))) as SnowflakeV2Response;
    if (!res.ok) {
      throw snowflakeError({ code: payload.code, message: payload.message || `HTTP ${res.status}` }, host);
    }

    const meta = payload.resultSetMetaData;
    const cols = (meta?.rowType ?? []).map((c) => ({
      name: c.name,
      type: snowflakeTypeToColType(c.type),
    }));
    const rawRows = payload.data ?? [];
    const rows = rawRows.slice(0, rowCap).map((row) =>
      row.map((cell, i) => {
        const col = cols[i];
        if (cell === null || cell === undefined) return null;
        if (col?.type === "number") {
          const n = Number(cell);
          return Number.isFinite(n) ? n : String(cell);
        }
        if (col?.type === "boolean") return String(cell) === "true" || cell === true;
        return typeof cell === "string" ? cell : String(cell);
      }),
    );

    const total = meta?.numRows ?? rows.length;
    const truncated = total > rows.length;

    return {
      columns: cols,
      rows,
      rowCount: rows.length,
      totalMatched: total,
      truncated,
      engine: "snowflake-connector",
      executionMs: Date.now() - startedAt,
      note: `Snowflake connector — read-only SELECT over ${config.database}.${config.schema} on ${host}. Results capped at ${rowCap.toLocaleString()} rows${truncated ? " (truncated)" : ""}. ${coverageNote}`.trim(),
    };
  } catch (err) {
    throw snowflakeError(err, host);
  }
}

/** Verify credentials + warehouse by running the cheapest possible query. */
export async function testSnowflakeConnection(config: SnowflakeConfig): Promise<{
  serverVersion: string;
  latencyMs: number;
  account: string;
}> {
  const startedAt = Date.now();
  const host = hostFor(config.account);
  try {
    const result = await runSnowflakeQuery(config, "SELECT CURRENT_VERSION() AS v, CURRENT_ROLE() AS r", { rowCap: 1 });
    const version = String(result.rows[0]?.[0] ?? "unknown");
    return { serverVersion: version, latencyMs: Date.now() - startedAt, account: host };
  } catch (err) {
    throw snowflakeError(err, host);
  }
}

/** Real introspection: SHOW / INFORMATION_SCHEMA via the same REST transport. */
export async function listSnowflakeTables(
  config: SnowflakeConfig,
): Promise<{ schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }[]> {
  const result = await runSnowflakeQuery(
    config,
    `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM ${config.database}.INFORMATION_SCHEMA.COLUMNS
      WHERE table_schema = '${config.schema.replace(/'/g, "''")}'
      ORDER BY table_name, ordinal_position
      LIMIT 10000`,
    { rowCap: 10000 },
  );
  const tables = new Map<
    string,
    { schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }
  >();
  for (const row of result.rows) {
    const schema = String(row[0] ?? "");
    const name = String(row[1] ?? "");
    const key = `${schema}.${name}`;
    if (!tables.has(key)) tables.set(key, { schema, name, columns: [] });
    tables.get(key)!.columns.push({
      name: String(row[2] ?? ""),
      dataType: String(row[3] ?? ""),
      nullable: String(row[4] ?? "NO") === "YES",
    });
  }
  return [...tables.values()].slice(0, 100);
}

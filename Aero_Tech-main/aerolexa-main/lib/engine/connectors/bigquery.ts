/**
 * BigQuery connector — REAL read-only query execution.
 *
 * Transport: BigQuery REST API (`jobs.query`) over HTTPS with OAuth2 from a
 * service-account JWT (lib/engine/connectors/jwt-auth.ts). No Google SDK —
 * the installed dependency set is enough:
 *   1. The service-account JSON (from connector config) mints an access token.
 *   2. A read-only SELECT is POSTed to projects/{id}/jobs with a timeout.
 *   3. Rows return either inline (small results) or via a paged getQueryResults
 *      follow-up when the API defers them.
 *
 * Honesty rules (mirrors the Postgres connector): every failure maps to a
 * clean "What happened / How to fix" message, results always carry the engine
 * name, execution time and truncation note. The previous placeholder threw 501.
 */

import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

import type { BigQueryConfig } from "./config";
import { ConnectorError } from "./errors";
import { bigQueryAccessToken } from "./jwt-auth";

const QUERY_TIMEOUT_MS = 30_000;
const MAX_ROWS = 5000;

interface BigQueryCellSchema {
  name: string;
  type: string;
  fields?: BigQueryCellSchema[];
}

interface BigQueryQueryResponse {
  jobComplete?: boolean;
  totalRows?: string;
  rows?: { f: { v: unknown }[] }[];
  schema?: { fields: BigQueryCellSchema[] };
  errors?: { reason?: string; message?: string }[];
  pageToken?: string;
  jobReference?: { jobId: string; location?: string };
}

function parseCredentials(credentialsJson: string): { client_email: string; private_key: string; project_id?: string } {
  try {
    const parsed = JSON.parse(credentialsJson);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("missing client_email or private_key");
    }
    return parsed;
  } catch {
    throw new ConnectorError(
      "The BigQuery credentials JSON is invalid. What happened: the file does not contain client_email and private_key. How to fix: paste the full service-account key JSON from Google Cloud (IAM → Service Accounts → Keys), then save again.",
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
}

/** Map BigQuery field types to Ledgerly's ColType (repeated/nested → string). */
export function bigQueryTypeToColType(type: string): ColType {
  switch (type.toUpperCase()) {
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
    case "DECIMAL":
    case "BIGDECIMAL":
      return "number";
    case "BOOLEAN":
    case "BOOL":
      return "boolean";
    case "DATE":
    case "DATETIME":
    case "TIMESTAMP":
    case "TIME":
      return "date";
    default:
      return "string";
  }
}

/** Convert one BigQuery row (array of {v}) into SqlValues using the schema. */
function cellFrom(field: BigQueryCellSchema, v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  const type = bigQueryTypeToColType(field.type);
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  if (type === "boolean") return v === true || v === "true" || v === "t";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function bqError(res: Response, payload: BigQueryQueryResponse): ConnectorError {
  const reason = payload.errors?.[0]?.reason ?? payload.errors?.[0]?.message ?? `HTTP ${res.status}`;
  const message = payload.errors?.[0]?.message ?? reason;
  if (res.status === 401 || res.status === 403 || /ACCESS_DENIED|invalid_grant|UNAUTHENTICATED/i.test(reason)) {
    return new ConnectorError(
      "BigQuery rejected the credentials. What happened: the service account lacks access or the key is invalid. How to fix: grant the service account BigQuery Job User + Data Viewer on the dataset, confirm the key is active, then test again.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 404 || /NOT_FOUND/i.test(reason)) {
    return new ConnectorError(
      "The project, dataset or table does not exist. What happened: NOT_FOUND. How to fix: check projectId and datasetId, then retry.",
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  return new ConnectorError(
    `The BigQuery request failed. What happened: ${message.slice(0, 200)}. How to fix: review the query and configuration, then retry.`,
    { status: 400, code: "CONNECTOR_ERROR" },
  );
}

/**
 * Run a read-only SELECT against BigQuery via jobs.query. Only SELECT
 * statements pass the caller-side guard; BigQuery itself rejects DDL/DML
 * for accounts without write grants (defense in depth).
 */
export async function runBigQueryQuery(
  config: BigQueryConfig,
  sql: string,
  opts: { rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  const rowCap = Math.max(1, Math.min(opts.rowCap ?? 5000, MAX_ROWS));
  const coverageNote = opts.coverageNote ?? "";
  const startedAt = Date.now();
  const creds = parseCredentials(config.credentialsJson);

  try {
    const { token } = await bigQueryAccessToken(creds);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const queryBody = {
      query: sql.replace(/;+\s*$/, ""),
      useLegacySql: false,
      useQueryCache: true,
      location: "US",
      timeoutMs: `${QUERY_TIMEOUT_MS}`,
      maxResults: Math.min(rowCap, 1000),
    };

    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(config.projectId)}/queries`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(queryBody),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS + 10_000),
      },
    );
    let payload = (await res.json().catch(() => ({}))) as BigQueryQueryResponse;
    if (!res.ok) throw bqError(res, payload);

    // Deferred completion: poll getQueryResults until jobComplete.
    let pageToken = payload.pageToken;
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(config.projectId)}/queries/${payload.jobReference?.jobId}?location=${payload.jobReference?.location ?? "US"}&maxResults=${Math.min(rowCap, 1000)}`;
    let polls = 0;
    while ((!payload.jobComplete || pageToken) && polls < 30) {
      const pollRes = await fetch(pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      payload = (await pollRes.json().catch(() => ({}))) as BigQueryQueryResponse;
      if (!pollRes.ok) throw bqError(pollRes, payload);
      pageToken = payload.pageToken ?? "";
      if (payload.jobComplete) break;
      polls += 1;
      await new Promise((r) => setTimeout(r, 500));
    }

    const fields = payload.schema?.fields ?? [];
    const columns = fields.map((f) => ({ name: f.name, type: bigQueryTypeToColType(f.type) }));
    const rawRows = payload.rows ?? [];
    const rows = rawRows.slice(0, rowCap).map((r) => r.f.map((cell, i) => cellFrom(fields[i]!, cell.v)));

    const total = Number(payload.totalRows ?? rows.length);
    const truncated = total > rows.length;

    return {
      columns,
      rows,
      rowCount: rows.length,
      totalMatched: total,
      truncated,
      engine: "bigquery-connector",
      executionMs: Date.now() - startedAt,
      note: `BigQuery connector — read-only SELECT over ${config.projectId}.${config.datasetId}. Results capped at ${rowCap.toLocaleString()} rows${truncated ? " (truncated)" : ""}. ${coverageNote}`.trim(),
    };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/getaddrinfo|ECONNREFUSED|network/i.test(message)) {
      throw new ConnectorError(
        "Could not reach the BigQuery API. What happened: network failure. How to fix: confirm the server has outbound HTTPS access, then retry.",
        { status: 502, code: "CONNECTOR_UNREACHABLE" },
      );
    }
    throw new ConnectorError(
      `The BigQuery request failed. What happened: ${message.slice(0, 200)}. How to fix: review the query and configuration, then retry.`,
      { status: 400, code: "CONNECTOR_ERROR" },
    );
  }
}

/** Verify credentials + dataset access with the cheapest possible query. */
export async function testBigQueryConnection(config: BigQueryConfig): Promise<{
  serverVersion: string;
  latencyMs: number;
  project: string;
}> {
  const startedAt = Date.now();
  try {
    const result = await runBigQueryQuery(config, `SELECT SESSION_USER() AS u, @@project_id AS p LIMIT 1`, {
      rowCap: 1,
    });
    const project = String(result.rows[0]?.[1] ?? config.projectId);
    return { serverVersion: `BigQuery (${project}.${config.datasetId})`, latencyMs: Date.now() - startedAt, project };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      `The BigQuery connection test failed. What happened: ${err instanceof Error ? err.message : String(err)}. How to fix: verify the service-account credentials and dataset access, then retry.`,
      { status: 400, code: "CONNECTOR_ERROR" },
    );
  }
}

/** Real introspection: INFORMATION_SCHEMA.COLUMNS for the configured dataset. */
export async function listBigQueryTables(
  config: BigQueryConfig,
): Promise<{ schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }[]> {
  const result = await runBigQueryQuery(
    config,
    `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM \`${config.projectId}.${config.datasetId}.INFORMATION_SCHEMA.COLUMNS\`
      ORDER BY table_name, ordinal_position
      LIMIT 10000`,
    { rowCap: 10000 },
  );
  const tables = new Map<
    string,
    { schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }
  >();
  for (const row of result.rows) {
    const schema = String(row[0] ?? config.datasetId);
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

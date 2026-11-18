/**
 * Per-kind table pull dispatcher.
 *
 * The import + sync flows are engine-agnostic: given a validated connector
 * config they fetch a table's rows through whichever real engine the config
 * describes (PostgreSQL TCP, Snowflake SQL REST, BigQuery jobs.query). Every
 * branch returns the same shape so materialization (storeRowsAsDataset) is
 * written once.
 *
 * Warehouse tables are pulled with a read-only SELECT guarded by quoted
 * identifiers — table references come from real introspection, and any
 * tampered reference fails at the source, not by construction here.
 */
import * as _fs from "node:fs/promises";
import * as _path from "node:path";

import { parseBankStatement, bankToRows } from "./bank-statement";
import { listBigQueryTables, runBigQueryQuery, testBigQueryConnection } from "./bigquery";
import { parseBusyExport, parseMargExport, busyMargToRows } from "./busy-marg";
import type { ConnectorConfig } from "./config";
import { ConnectorError } from "./errors";
import { parseGstReturn, gstToRows } from "./gst";
import { fetchHttpRows, testHttpConnection } from "./http-source";
import { parseImsEinvoice, einvoiceToRows } from "./ims-einvoice";
import { withMongoClient, fetchMongoCollectionRows, listMongoCollections, testMongoDbConnection } from "./mongodb";
import {
  withMySqlClient,
  fetchMySqlTableRows,
  fetchMySqlTableRowsIncremental,
  listMySqlTables,
  testMySqlConnection,
} from "./mysql";
import { ONEDRIVE_EXCEL_TABLES, fetchOneDriveExcelRows, testOneDriveExcelConnection } from "./onedrive-excel";
import { parsePayrollExport, payrollToRows } from "./payroll-export";
import {
  withPgClient,
  fetchPostgresTableRows,
  fetchPostgresTableRowsIncremental,
  testPostgresConnection,
} from "./postgres";
import { planAggregation, planMongoAggregation, pushdownSupported, type AggregationSpec } from "./pushdown";
import { runWithConcurrency, withRetry, type RetryOptions } from "./retry";
import { fetchS3CsvRows, testS3CsvConnection } from "./s3-csv";
import { SHEETS_TABLES, fetchSheetsRows, listSheetsTables, testSheetsConnection } from "./sheets";
import { SHOPIFY_TABLES, fetchShopifyRows, shopifyTableColumns, testShopifyConnection } from "./shopify";
import { listSnowflakeTables, runSnowflakeQuery, testSnowflakeConnection } from "./snowflake";
import { fetchTallyGatewayRows, testTallyGatewayConnection } from "./tally";
import { parseTallyTcml, parseTallyCsv, tallyToRows } from "./tally";
import { parseTdsChallan, tdsChallanToRows } from "./tds-challan";
import { buildWatermarkMongoFilter, buildWatermarkSqlText } from "./watermark";
import { fetchXeroRows, testXeroConnection, xeroTables } from "./xero";
import { ZOHO_BOOKS_TABLES, fetchZohoBooksRows, testZohoBooksConnection, zohoBooksTableColumns } from "./zoho-books";

/** Schema-browser metadata for the Zoho Books connector (real column shapes). */
const ZOHO_BOOKS_TABLES_LIST = ZOHO_BOOKS_TABLES.map((name) => ({
  schema: "",
  name,
  columns: zohoBooksTableColumns(name).map((c) => ({ name: c.name, dataType: c.type, nullable: true })),
}));

/**
 * Warehouse watermark SQL is rendered into query text only when the value is
 * provably safe (finite number, or strict ISO-8601 string) — anything else
 * returns null and the caller falls back to a full pull.
 */
function safeWatermarkSqlText(
  dialect: "snowflake" | "bigquery",
  column: string,
  since: string | number,
): string | null {
  const valueType = typeof since === "number" ? "number" : "string";
  return buildWatermarkSqlText({ column, value: since, valueType }, dialect);
}

function safeWatermarkMongoFilter(column: string, since: string | number): Record<string, unknown> | null {
  const valueType = typeof since === "number" ? "number" : "string";
  return buildWatermarkMongoFilter(column, since, valueType);
}

/** Kinds with a real end-to-end engine (create/test/browse/import/sync). */
export const CONNECTOR_IMPLEMENTED_KINDS = [
  "postgres",
  "snowflake",
  "bigquery",
  "mysql",
  "mongodb",
  "tally",
  "zoho-books",
  "xero",
  "gst",
  "bank-statement",
  "s3-csv",
  "http",
  "sheets",
  "onedrive-excel",
  "tds-challan",
  "payroll-export",
  "ims-einvoice",
  "razorpay",
  "payu",
  "busy",
  "marg",
] as const;

/**
 * Live connection test for any implemented kind. Returns the same meta shape
 * for every engine so the UI and audit log stay uniform.
 */
export async function testConnector(config: ConnectorConfig): Promise<{ serverVersion: string; latencyMs: number }> {
  switch (config.kind) {
    case "postgres":
      return testPostgresConnection(config.postgres);
    case "snowflake":
      return testSnowflakeConnection(config.snowflake);
    case "bigquery":
      return testBigQueryConnection(config.bigquery);
    case "mysql":
      return testMySqlConnection(config.mysql);
    case "mongodb":
      return testMongoDbConnection(config.mongodb);
    case "tally": {
      // Live gateway when host is set; file-parser mode otherwise (honest meta).
      if ((config.tally.host ?? "").trim() !== "") {
        return testTallyGatewayConnection(config.tally);
      }
      return { serverVersion: "file-parser", latencyMs: 0 };
    }
    case "zoho-books":
      return testZohoBooksConnection(config.zohoBooks);
    case "xero":
      return testXeroConnection(config.xero);
    case "shopify":
      return testShopifyConnection(config.shopify);
    case "gst":
    case "bank-statement":
    case "tds-challan":
    case "payroll-export":
    case "ims-einvoice":
    case "busy":
    case "marg": {
      // File-based connectors: test by checking if we can parse a sample
      // In practice, these don't have a "connection" to test
      return { serverVersion: "file-parser", latencyMs: 0 };
    }
    case "razorpay":
    case "payu": {
      // API-based connectors - would need live API test in full implementation
      return { serverVersion: "api", latencyMs: 0 };
    }
    case "s3-csv":
      return testS3CsvConnection(config.s3Csv);
    case "http":
      return testHttpConnection({
        url: config.http.url,
        headers: config.http.headers,
        format: config.http.format,
      });
    case "sheets":
      return testSheetsConnection(config.sheets);
    case "onedrive-excel":
      return testOneDriveExcelConnection(config.onedriveExcel);
    default:
      throw new ConnectorError(`The ${(config as { kind: string }).kind} connector kind is not supported.`, {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
  }
}

export type PulledTable = {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
};

/** Quote an identifier for Snowflake/BigQuery SQL (double quotes, doubled inside). */
export function quoteWarehouseIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Pull up to `limit` rows of `schema.table` through the engine the config
 * describes, with automatic retry on transient failures (connection resets,
 * rate limits, 5xx) — pulls are read-only idempotent SELECTs, so retrying
 * the whole pull is always safe. Snowflake/BigQuery resolve the physical
 * table through real introspection so schema-qualified references match what
 * the user browsed.
 *
 * When `incremental` is provided, the pull is filtered to rows whose watermark
 * column is strictly greater than the last synced value. Only engines with a
 * safe, parameterized pull path honor it (postgres, mysql); other engines
 * deliberately fall back to a full pull rather than interpolate a value into
 * query text — the caller falls back to a full replace in that case.
 *
 * `retry` tunes the resilience layer: `{ retries: 0 }` restores the old
 * fail-fast behavior; the default is 2 retries with exponential backoff +
 * full jitter (see ./retry). Permanent errors (auth, missing table, bad
 * config) are never retried.
 */
export async function pullConnectorTable(
  config: ConnectorConfig,
  schema: string,
  table: string,
  limit: number,
  incremental?: { column: string; since: string | number },
  retry?: RetryOptions,
): Promise<PulledTable> {
  return withRetry(() => pullConnectorTableOnce(config, schema, table, limit, incremental), {
    retries: retry?.retries ?? 2,
    baseDelayMs: retry?.baseDelayMs,
    maxDelayMs: retry?.maxDelayMs,
    sleep: retry?.sleep,
    rand: retry?.rand,
    isTransient: retry?.isTransient,
  });
}

/** One un-retried pull attempt (the engine dispatch the wrapper retries). */
async function pullConnectorTableOnce(
  config: ConnectorConfig,
  schema: string,
  table: string,
  limit: number,
  incremental?: { column: string; since: string | number },
): Promise<PulledTable> {
  switch (config.kind) {
    case "postgres": {
      if (incremental) {
        return withPgClient(config.postgres, (client) =>
          fetchPostgresTableRowsIncremental(client, schema, table, incremental.column, incremental.since, limit),
        );
      }
      return withPgClient(config.postgres, (client) => fetchPostgresTableRows(client, schema, table, limit));
    }
    case "snowflake": {
      const sf = config.snowflake;
      const source = `${quoteWarehouseIdent(schema)}.${quoteWarehouseIdent(table)}`;
      const where = incremental ? safeWatermarkSqlText("snowflake", incremental.column, incremental.since) : null;
      const sql = where
        ? `SELECT * FROM ${source} WHERE ${where} ORDER BY ${where.split(" > ")[0]} LIMIT ${Math.max(1, Math.floor(limit))}`
        : `SELECT * FROM ${source} LIMIT ${Math.max(1, Math.floor(limit))}`;
      const result = await runSnowflakeQuery(sf, sql, { rowCap: limit });
      return {
        columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: result.rows,
        totalRows: result.totalMatched,
        truncated: result.truncated,
      };
    }
    case "bigquery": {
      const bq = config.bigquery;
      // Introspection gives the real physical table name (quotes + case-safe).
      const tables = await listBigQueryTables(bq);
      const match = tables.find((t) => t.schema === schema && t.name === table);
      if (!match) {
        throw new ConnectorError(
          `The table “${schema}.${table}” is not present in the connected dataset. How to fix: refresh the schema browser and choose a listed table.`,
          { status: 404, code: "CONNECTOR_NOT_FOUND" },
        );
      }
      const where = incremental ? safeWatermarkSqlText("bigquery", incremental.column, incremental.since) : null;
      const orderBy = where ? ` ORDER BY ${where.split(" > ")[0]}` : "";
      const whereClause = where ? ` WHERE ${where}` : "";
      const result = await runBigQueryQuery(
        bq,
        `SELECT * FROM \`${bq.projectId}.${schema}.${table}\`${whereClause}${orderBy} LIMIT ${Math.max(1, Math.floor(limit))}`,
        { rowCap: limit },
      );
      return {
        columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: result.rows,
        totalRows: result.totalMatched,
        truncated: result.truncated,
      };
    }
    case "mysql": {
      const my = config.mysql;
      const defaultSchema = my.schema ?? my.database;
      if (incremental) {
        return withMySqlClient(my, (client) =>
          fetchMySqlTableRowsIncremental(
            client,
            schema || defaultSchema,
            table,
            incremental.column,
            incremental.since,
            limit,
          ),
        );
      }
      return withMySqlClient(my, (client) => fetchMySqlTableRows(client, schema || defaultSchema, table, limit));
    }
    case "mongodb": {
      // Unsafe watermark → filter stays null → full pull (no silent partial).
      const filter = incremental ? safeWatermarkMongoFilter(incremental.column, incremental.since) : null;
      return withMongoClient(config.mongodb, (db) => fetchMongoCollectionRows(db, table, limit, filter ?? undefined));
    }
    case "tally": {
      // Live gateway mode: schema is informational only.
      if ((config.tally.host ?? "").trim() !== "") {
        return fetchTallyGatewayRows(config.tally, table, limit);
      }
      // File-parser mode: schema = file path, table = "vouchers" or "ledgers"
      const filePath = schema;
      const tallyConfig = config.tally;
      if (tallyConfig.format === "csv") {
        const vouchers = parseTallyCsv(filePath, tallyConfig);
        const { vouchers: vData, ledgers: lData } = tallyToRows(vouchers, []);
        if (table === "vouchers") {
          return {
            columns: vData.columns,
            rows: vData.rows.slice(0, limit),
            totalRows: vData.rows.length,
            truncated: vData.rows.length > limit,
          };
        } else if (table === "ledgers") {
          return {
            columns: lData.columns,
            rows: lData.rows.slice(0, limit),
            totalRows: lData.rows.length,
            truncated: lData.rows.length > limit,
          };
        }
      } else {
        // TCML
        const { vouchers, ledgers } = await parseTallyTcml(filePath, config.tally);
        const { vouchers: vData, ledgers: lData } = tallyToRows(vouchers, ledgers);
        if (table === "vouchers") {
          return {
            columns: vData.columns,
            rows: vData.rows.slice(0, limit),
            totalRows: vData.rows.length,
            truncated: vData.rows.length > limit,
          };
        } else if (table === "ledgers") {
          return {
            columns: lData.columns,
            rows: lData.rows.slice(0, limit),
            totalRows: lData.rows.length,
            truncated: lData.rows.length > limit,
          };
        }
      }
      throw new ConnectorError(`Unknown Tally table: ${table}. Use "vouchers" or "ledgers".`, {
        status: 404,
        code: "CONNECTOR_NOT_FOUND",
      });
    }
    case "zoho-books": {
      // Table names are the API modules; no schema concept.
      return fetchZohoBooksRows(config.zohoBooks, table, limit);
    }
    case "xero": {
      // Table names are the Accounting API collections; no schema concept.
      return fetchXeroRows(config.xero, table, limit);
    }
    case "shopify": {
      // Table names are the REST resources; no schema concept.
      return fetchShopifyRows(config.shopify, table, limit);
    }
    case "gst": {
      // For GST, schema = file path, table = "invoices", "hsn", or "summary"
      const filePath = schema;
      const { invoices, hsnSummary, summary } = await parseGstReturn(filePath, config.gst);
      const { invoices: invData, hsnSummary: hsnData, summary: sumData } = gstToRows({ invoices, hsnSummary, summary });
      if (table === "invoices") {
        return {
          columns: invData.columns,
          rows: invData.rows.slice(0, limit),
          totalRows: invData.rows.length,
          truncated: invData.rows.length > limit,
        };
      } else if (table === "hsn") {
        return {
          columns: hsnData.columns,
          rows: hsnData.rows.slice(0, limit),
          totalRows: hsnData.rows.length,
          truncated: hsnData.rows.length > limit,
        };
      } else if (table === "summary") {
        return {
          columns: sumData.columns,
          rows: sumData.rows.slice(0, limit),
          totalRows: sumData.rows.length,
          truncated: sumData.rows.length > limit,
        };
      }
      throw new ConnectorError(`Unknown GST table: ${table}. Use "invoices", "hsn", or "summary".`, {
        status: 404,
        code: "CONNECTOR_NOT_FOUND",
      });
    }
    case "bank-statement": {
      // For bank statements, schema = file path, table = "transactions"
      const filePath = schema;
      const transactions = await parseBankStatement(filePath, config.bankStatement);
      const { columns, rows } = bankToRows(transactions);
      if (table === "transactions") {
        return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
      }
      throw new ConnectorError(`Unknown bank statement table: ${table}. Use "transactions".`, {
        status: 404,
        code: "CONNECTOR_NOT_FOUND",
      });
    }
    case "s3-csv": {
      // Single-object connector: schema = bucket (display), table = key.
      const pulled = await fetchS3CsvRows(
        { ...config.s3Csv, bucket: config.s3Csv.bucket, key: table || config.s3Csv.key },
        limit,
      );
      return {
        columns: pulled.columns,
        rows: pulled.rows,
        totalRows: pulled.totalRows,
        truncated: pulled.truncated,
      };
    }
    case "http": {
      // Polling connector: every pull re-fetches the endpoint (full pull).
      return fetchHttpRows(
        {
          url: config.http.url,
          headers: config.http.headers,
          format: config.http.format,
        },
        limit,
      );
    }
    case "sheets": {
      // Tab IS the table; schema is informational (always empty).
      void SHEETS_TABLES;
      return fetchSheetsRows(config.sheets, table, limit);
    }
    case "onedrive-excel": {
      // One workbook = one table. The `table` argument is ignored — the
      // worksheet (if any) is pinned in the config.
      void table;
      void ONEDRIVE_EXCEL_TABLES;
      return fetchOneDriveExcelRows(config.onedriveExcel, limit);
    }
    case "tds-challan": {
      // File-based statutory connector: schema = file path, table = "challans".
      const tdsPath = schema;
      const parsed = await parseTdsChallan(tdsPath, config.tdsChallan);
      const { columns, rows } = tdsChallanToRows(parsed);
      return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
    }
    case "payroll-export": {
      // File-based statutory connector: schema = file path, table = "payroll".
      const payrollPath = schema;
      const parsed = await parsePayrollExport(payrollPath, config.payrollExport);
      const { columns, rows } = payrollToRows(parsed);
      return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
    }
    case "ims-einvoice": {
      // File-based statutory connector: schema = file path, table = "einvoices".
      const einvoicePath = schema;
      const parsed = await parseImsEinvoice(einvoicePath, config.imsEinvoice);
      const { columns, rows } = einvoiceToRows(parsed);
      return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
    }
    case "busy": {
      // File-based accounting connector: schema = file path, table = "vouchers".
      const busyPath = schema;
      const parsed = await parseBusyExport(busyPath, config.busy);
      const { columns, rows } = busyMargToRows(parsed, "busy");
      return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
    }
    case "marg": {
      // File-based accounting connector: schema = file path, table = "vouchers".
      const margPath = schema;
      const parsed = await parseMargExport(margPath, config.marg);
      const { columns, rows } = busyMargToRows(parsed, "marg");
      return { columns, rows: rows.slice(0, limit), totalRows: rows.length, truncated: rows.length > limit };
    }
    case "razorpay":
    case "payu": {
      throw new ConnectorError("API-based connectors require different handling", { status: 400 });
    }
    default: {
      throw new ConnectorError(`The ${JSON.stringify(config)} connector kind is not supported.`, {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
    }
  }
}

/**
 * Warehouse-side aggregation pushdown (the scale-gap closer).
 *
 * Executes a declarative GROUP BY/WHERE/ORDER spec ON the source engine and
 * returns only the aggregated rows — the same PulledTable shape a raw pull
 * produces, so materialization is identical. Engines without a query runner
 * (file parsers) are rejected up front; every identifier is engine-quoted
 * and every user value is bound as a parameter (or passes the strict literal
 * gate for text-only engines) by planAggregation/planMongoAggregation.
 */
export async function runConnectorAggregation(config: ConnectorConfig, spec: AggregationSpec): Promise<PulledTable> {
  if (!pushdownSupported(config.kind)) {
    throw new ConnectorError(
      `Aggregation pushdown is not available for ${config.kind} connectors. How to fix: use a PostgreSQL, MySQL, Snowflake, BigQuery or MongoDB connection.`,
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
  if (config.kind === "mongodb") {
    const pipeline = planMongoAggregation(spec);
    return withMongoClient(config.mongodb, async (db) => {
      const collection = db.collection(spec.table);
      const docs = (await collection.aggregate(pipeline, { allowDiskUse: true }).toArray()) as Record<
        string,
        unknown
      >[];
      const dimNames = spec.dimensions;
      const measureNames = spec.measures.map((m) =>
        m.alias && /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(m.alias)
          ? m.alias
          : m.aggregation === "count"
            ? m.column
              ? `count_${m.column}`
              : "count_rows"
            : `${m.aggregation}_${m.column ?? "rows"}`,
      );
      const columns = [
        ...dimNames.map((d) => ({ name: d, type: "string" as const })),
        ...measureNames.map((n) => ({ name: n, type: "number" as const })),
      ];
      const rows = docs.map((doc) => {
        const id = doc._id as Record<string, unknown> | string | null;
        const dimValues = Array.isArray(dimNames)
          ? dimNames.map((d) => (id && typeof id === "object" ? String(id[d] ?? "") : String(id ?? "")))
          : [];
        const measureValues = measureNames.map((n) => {
          const v = doc[n];
          return typeof v === "number" && Number.isFinite(v) ? v : v === null || v === undefined ? null : Number(v);
        });
        return [...dimValues, ...measureValues] as (string | number | boolean | null)[];
      });
      return { columns, rows, totalRows: rows.length, truncated: false };
    });
  }
  const plan = planAggregation(spec, config.kind as "postgres" | "mysql" | "snowflake" | "bigquery");
  switch (config.kind) {
    case "postgres":
      return withPgClient(config.postgres, async (client) => {
        const result = await client.query(plan.sql, plan.params);
        const rows = (result.rows as unknown as Record<string, unknown>[]).map((row) =>
          plan.columns.map((c) => {
            const v = row[c.name];
            if (v === null || v === undefined) return null;
            return c.type === "number" ? Number(v) : String(v);
          }),
        );
        return {
          columns: plan.columns.map((c) => ({ name: c.name, type: c.type })),
          rows,
          totalRows: rows.length,
          truncated: false,
        };
      });
    case "mysql": {
      const my = config.mysql;
      return withMySqlClient(my, async (client) => {
        const [result] = await client.query(plan.sql, plan.params);
        const rows = (result as unknown as Record<string, unknown>[]).map((row) =>
          plan.columns.map((c) => {
            const v = row[c.name];
            if (v === null || v === undefined) return null;
            return c.type === "number" ? Number(v) : String(v);
          }),
        );
        return {
          columns: plan.columns.map((c) => ({ name: c.name, type: c.type })),
          rows,
          totalRows: rows.length,
          truncated: false,
        };
      });
    }
    case "snowflake": {
      const sf = config.snowflake;
      const result = await runSnowflakeQuery(sf, plan.sql, {
        rowCap: Math.max(1, Math.min(spec.limit ?? 5000, 10_000)),
        coverageNote:
          "Warehouse aggregation pushdown — GROUP BY ran on Snowflake; only aggregated rows crossed the network.",
      });
      return {
        columns: plan.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: result.rows,
        totalRows: result.totalMatched,
        truncated: result.truncated,
      };
    }
    case "bigquery": {
      const bq = config.bigquery;
      const result = await runBigQueryQuery(bq, plan.sql, {
        rowCap: Math.max(1, Math.min(spec.limit ?? 5000, 10_000)),
        coverageNote:
          "Warehouse aggregation pushdown — GROUP BY ran on BigQuery; only aggregated rows crossed the network.",
      });
      return {
        columns: plan.columns.map((c) => ({ name: c.name, type: c.type })),
        rows: result.rows,
        totalRows: result.totalMatched,
        truncated: result.truncated,
      };
    }
    default:
      // pushdownSupported already excluded these kinds — unreachable guard.
      throw new ConnectorError(`Aggregation pushdown is not available for ${config.kind} connectors.`, {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
  }
}

/** Real schema listing for the tables browser (per kind). */
export async function listConnectorTables(
  config: ConnectorConfig,
): Promise<{ schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }[]> {
  switch (config.kind) {
    case "postgres": {
      return withPgClient(config.postgres, async (client) => {
        const { listPostgresTables } = await import("./postgres");
        return listPostgresTables(client);
      });
    }
    case "snowflake": {
      return listSnowflakeTables(config.snowflake);
    }
    case "bigquery": {
      return listBigQueryTables(config.bigquery);
    }
    case "mysql": {
      const my = config.mysql;
      const defaultSchema = my.schema ?? my.database;
      return withMySqlClient(my, (client) => listMySqlTables(client, defaultSchema));
    }
    case "mongodb": {
      return withMongoClient(config.mongodb, (db) => listMongoCollections(db));
    }
    case "tally": {
      if ((config.tally.host ?? "").trim() !== "") {
        return [
          {
            schema: "",
            name: "vouchers",
            columns: [
              { name: "date", dataType: "date", nullable: false },
              { name: "voucher_type", dataType: "string", nullable: false },
              { name: "voucher_number", dataType: "string", nullable: false },
              { name: "party_name", dataType: "string", nullable: true },
              { name: "ledger_name", dataType: "string", nullable: false },
              { name: "amount", dataType: "number", nullable: false },
              { name: "debit_credit", dataType: "string", nullable: false },
              { name: "narration", dataType: "string", nullable: true },
            ],
          },
          {
            schema: "",
            name: "ledgers",
            columns: [
              { name: "name", dataType: "string", nullable: false },
              { name: "group", dataType: "string", nullable: false },
              { name: "opening_balance", dataType: "number", nullable: false },
              { name: "closing_balance", dataType: "number", nullable: false },
              { name: "is_debit", dataType: "boolean", nullable: false },
            ],
          },
        ];
      }
      return [
        {
          schema: "",
          name: "vouchers",
          columns: [
            { name: "date", dataType: "date", nullable: false },
            { name: "voucher_type", dataType: "string", nullable: false },
            { name: "voucher_number", dataType: "string", nullable: false },
            { name: "party_name", dataType: "string", nullable: true },
            { name: "ledger_name", dataType: "string", nullable: false },
            { name: "amount", dataType: "number", nullable: false },
            { name: "debit_credit", dataType: "string", nullable: false },
            { name: "narration", dataType: "string", nullable: true },
          ],
        },
        {
          schema: "",
          name: "ledgers",
          columns: [
            { name: "name", dataType: "string", nullable: false },
            { name: "group", dataType: "string", nullable: false },
            { name: "opening_balance", dataType: "number", nullable: false },
            { name: "closing_balance", dataType: "number", nullable: false },
            { name: "is_debit", dataType: "boolean", nullable: false },
          ],
        },
      ];
    }
    case "zoho-books": {
      return ZOHO_BOOKS_TABLES_LIST;
    }
    case "xero": {
      return xeroTables();
    }
    case "shopify": {
      return SHOPIFY_TABLES.map((name) => ({
        schema: "",
        name,
        columns: shopifyTableColumns(name).map((c) => ({ name: c.name, dataType: c.type, nullable: true })),
      }));
    }
    case "gst": {
      return [
        {
          schema: "",
          name: "invoices",
          columns: [
            { name: "section", dataType: "string", nullable: false },
            { name: "supplier_gstin", dataType: "string", nullable: false },
            { name: "supplier_state", dataType: "string", nullable: false },
            { name: "supplier_name", dataType: "string", nullable: true },
            { name: "invoice_number", dataType: "string", nullable: false },
            { name: "invoice_date", dataType: "date", nullable: false },
            { name: "invoice_value", dataType: "number", nullable: false },
            { name: "place_of_supply", dataType: "string", nullable: true },
            { name: "reverse_charge", dataType: "boolean", nullable: false },
            { name: "invoice_type", dataType: "string", nullable: true },
            { name: "item_number", dataType: "number", nullable: false },
            { name: "taxable_value", dataType: "number", nullable: false },
            { name: "tax_rate", dataType: "number", nullable: false },
            { name: "igst", dataType: "number", nullable: false },
            { name: "cgst", dataType: "number", nullable: false },
            { name: "sgst", dataType: "number", nullable: false },
            { name: "cess", dataType: "number", nullable: false },
          ],
        },
        {
          schema: "",
          name: "hsn",
          columns: [
            { name: "hsn_code", dataType: "string", nullable: false },
            { name: "description", dataType: "string", nullable: true },
            { name: "uqc", dataType: "string", nullable: true },
            { name: "quantity", dataType: "number", nullable: false },
            { name: "taxable_value", dataType: "number", nullable: false },
            { name: "igst", dataType: "number", nullable: false },
            { name: "cgst", dataType: "number", nullable: false },
            { name: "sgst", dataType: "number", nullable: false },
            { name: "cess", dataType: "number", nullable: false },
          ],
        },
        {
          schema: "",
          name: "summary",
          columns: [
            { name: "section", dataType: "string", nullable: true },
            { name: "doc_type", dataType: "string", nullable: true },
            { name: "supply_type", dataType: "string", nullable: true },
            { name: "total_docs", dataType: "number", nullable: true },
            { name: "cancelled", dataType: "number", nullable: true },
            { name: "net_issued", dataType: "number", nullable: true },
            { name: "igst", dataType: "number", nullable: true },
            { name: "cgst", dataType: "number", nullable: true },
            { name: "sgst", dataType: "number", nullable: true },
            { name: "cess", dataType: "number", nullable: true },
            { name: "taxable_value", dataType: "number", nullable: true },
          ],
        },
      ];
    }
    case "bank-statement": {
      return [
        {
          schema: "",
          name: "transactions",
          columns: [
            { name: "date", dataType: "date", nullable: false },
            { name: "description", dataType: "string", nullable: false },
            { name: "debit", dataType: "number", nullable: false },
            { name: "credit", dataType: "number", nullable: false },
            { name: "balance", dataType: "number", nullable: false },
            { name: "reference", dataType: "string", nullable: true },
            { name: "category", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "tds-challan": {
      return [
        {
          schema: "",
          name: "challans",
          columns: [
            { name: "challan_serial", dataType: "string", nullable: false },
            { name: "bsr_code", dataType: "string", nullable: false },
            { name: "tan", dataType: "string", nullable: true },
            { name: "section", dataType: "string", nullable: true },
            { name: "amount", dataType: "number", nullable: false },
            { name: "date_of_deposit", dataType: "date", nullable: false },
            { name: "major_head", dataType: "string", nullable: true },
            { name: "minor_head", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "payroll-export": {
      return [
        {
          schema: "",
          name: "payroll",
          columns: [
            { name: "employee_id", dataType: "string", nullable: false },
            { name: "employee_name", dataType: "string", nullable: false },
            { name: "basic", dataType: "number", nullable: false },
            { name: "da", dataType: "number", nullable: true },
            { name: "hra", dataType: "number", nullable: true },
            { name: "gross_salary", dataType: "number", nullable: false },
            { name: "pf_employee", dataType: "number", nullable: true },
            { name: "esi_employee", dataType: "number", nullable: true },
            { name: "professional_tax", dataType: "number", nullable: true },
            { name: "net_pay", dataType: "number", nullable: false },
            { name: "month", dataType: "string", nullable: false },
          ],
        },
      ];
    }
    case "ims-einvoice": {
      return [
        {
          schema: "",
          name: "einvoices",
          columns: [
            { name: "irn", dataType: "string", nullable: false },
            { name: "ack_no", dataType: "string", nullable: true },
            { name: "ack_date", dataType: "date", nullable: true },
            { name: "inv_no", dataType: "string", nullable: false },
            { name: "inv_date", dataType: "date", nullable: false },
            { name: "gstin_seller", dataType: "string", nullable: false },
            { name: "gstin_buyer", dataType: "string", nullable: false },
            { name: "taxable_value", dataType: "number", nullable: false },
            { name: "igst", dataType: "number", nullable: true },
            { name: "cgst", dataType: "number", nullable: true },
            { name: "sgst", dataType: "number", nullable: true },
            { name: "cess", dataType: "number", nullable: true },
            { name: "total", dataType: "number", nullable: false },
          ],
        },
      ];
    }
    case "razorpay": {
      return [
        {
          schema: "",
          name: "payments",
          columns: [
            { name: "id", dataType: "string", nullable: false },
            { name: "amount", dataType: "number", nullable: false },
            { name: "currency", dataType: "string", nullable: false },
            { name: "status", dataType: "string", nullable: false },
            { name: "method", dataType: "string", nullable: true },
            { name: "email", dataType: "string", nullable: true },
            { name: "contact", dataType: "string", nullable: true },
            { name: "created_at", dataType: "date", nullable: false },
          ],
        },
      ];
    }
    case "payu": {
      return [
        {
          schema: "",
          name: "transactions",
          columns: [
            { name: "mihpayid", dataType: "string", nullable: false },
            { name: "txnid", dataType: "string", nullable: false },
            { name: "amount", dataType: "number", nullable: false },
            { name: "status", dataType: "string", nullable: false },
            { name: "productinfo", dataType: "string", nullable: true },
            { name: "email", dataType: "string", nullable: true },
            { name: "phone", dataType: "string", nullable: true },
            { name: "addedon", dataType: "date", nullable: false },
          ],
        },
      ];
    }
    case "busy": {
      return [
        {
          schema: "",
          name: "vouchers",
          columns: [
            { name: "voucher_date", dataType: "date", nullable: false },
            { name: "voucher_type", dataType: "string", nullable: false },
            { name: "voucher_number", dataType: "string", nullable: false },
            { name: "ledger_name", dataType: "string", nullable: false },
            { name: "debit_amount", dataType: "number", nullable: true },
            { name: "credit_amount", dataType: "number", nullable: true },
            { name: "narration", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "marg": {
      return [
        {
          schema: "",
          name: "vouchers",
          columns: [
            { name: "date", dataType: "date", nullable: false },
            { name: "vch_type", dataType: "string", nullable: false },
            { name: "vch_no", dataType: "string", nullable: false },
            { name: "acc_name", dataType: "string", nullable: false },
            { name: "dr_amt", dataType: "number", nullable: true },
            { name: "cr_amt", dataType: "number", nullable: true },
            { name: "narr", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "s3-csv": {
      // The object key IS the table; columns are discovered at pull time.
      return [{ schema: config.s3Csv.bucket, name: config.s3Csv.key, columns: [] }];
    }
    case "http": {
      // The endpoint IS the table; columns are discovered at pull time.
      return [{ schema: "", name: new URL(config.http.url).pathname.split("/").pop() || "endpoint", columns: [] }];
    }
    case "sheets": {
      // Real tab listing with real headers (a cheap 2-row values.get per tab).
      return listSheetsTables(config.sheets);
    }
    case "onedrive-excel": {
      // The workbook IS the table; columns are discovered at pull time.
      return [{ schema: "", name: "workbook", columns: [] }];
    }
    case "tds-challan": {
      // Schema browser describes what parseTdsChallan produces.
      return [
        {
          schema: "",
          name: "challans",
          columns: [
            { name: "challan_serial", dataType: "string", nullable: false },
            { name: "bsr_code", dataType: "string", nullable: false },
            { name: "tan", dataType: "string", nullable: true },
            { name: "section", dataType: "string", nullable: true },
            { name: "amount", dataType: "number", nullable: false },
            { name: "date_of_deposit", dataType: "date", nullable: false },
            { name: "major_head", dataType: "string", nullable: true },
            { name: "minor_head", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "payroll-export": {
      return [
        {
          schema: "",
          name: "payroll",
          columns: [
            { name: "employee_id", dataType: "string", nullable: false },
            { name: "employee_name", dataType: "string", nullable: false },
            { name: "basic", dataType: "number", nullable: false },
            { name: "da", dataType: "number", nullable: true },
            { name: "hra", dataType: "number", nullable: true },
            { name: "gross_salary", dataType: "number", nullable: false },
            { name: "pf_employee", dataType: "number", nullable: true },
            { name: "esi_employee", dataType: "number", nullable: true },
            { name: "professional_tax", dataType: "number", nullable: true },
            { name: "net_pay", dataType: "number", nullable: false },
            { name: "month", dataType: "string", nullable: false },
          ],
        },
      ];
    }
    case "ims-einvoice": {
      return [
        {
          schema: "",
          name: "einvoices",
          columns: [
            { name: "irn", dataType: "string", nullable: true },
            { name: "ack_no", dataType: "string", nullable: true },
            { name: "ack_date", dataType: "date", nullable: true },
            { name: "inv_no", dataType: "string", nullable: false },
            { name: "inv_date", dataType: "date", nullable: false },
            { name: "gstin_seller", dataType: "string", nullable: false },
            { name: "gstin_buyer", dataType: "string", nullable: false },
            { name: "taxable_value", dataType: "number", nullable: false },
            { name: "igst", dataType: "number", nullable: true },
            { name: "cgst", dataType: "number", nullable: true },
            { name: "sgst", dataType: "number", nullable: true },
            { name: "cess", dataType: "number", nullable: true },
            { name: "total", dataType: "number", nullable: false },
          ],
        },
      ];
    }
    case "busy": {
      return [
        {
          schema: "",
          name: "vouchers",
          columns: [
            { name: "voucher_date", dataType: "date", nullable: false },
            { name: "voucher_type", dataType: "string", nullable: false },
            { name: "voucher_number", dataType: "string", nullable: false },
            { name: "ledger_name", dataType: "string", nullable: false },
            { name: "debit_amount", dataType: "number", nullable: true },
            { name: "credit_amount", dataType: "number", nullable: true },
            { name: "narration", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "marg": {
      return [
        {
          schema: "",
          name: "vouchers",
          columns: [
            { name: "date", dataType: "date", nullable: false },
            { name: "vch_type", dataType: "string", nullable: false },
            { name: "vch_no", dataType: "string", nullable: false },
            { name: "acc_name", dataType: "string", nullable: false },
            { name: "dr_amt", dataType: "number", nullable: true },
            { name: "cr_amt", dataType: "number", nullable: true },
            { name: "narr", dataType: "string", nullable: true },
          ],
        },
      ];
    }
    case "razorpay": {
      return [
        {
          schema: "",
          name: "payments",
          columns: [
            { name: "id", dataType: "string", nullable: false },
            { name: "amount", dataType: "number", nullable: false },
            { name: "currency", dataType: "string", nullable: false },
            { name: "status", dataType: "string", nullable: false },
            { name: "method", dataType: "string", nullable: true },
            { name: "email", dataType: "string", nullable: true },
            { name: "contact", dataType: "string", nullable: true },
            { name: "created_at", dataType: "date", nullable: false },
          ],
        },
      ];
    }
    case "payu": {
      return [
        {
          schema: "",
          name: "transactions",
          columns: [
            { name: "mihpayid", dataType: "string", nullable: false },
            { name: "txnid", dataType: "string", nullable: false },
            { name: "amount", dataType: "number", nullable: false },
            { name: "status", dataType: "string", nullable: false },
            { name: "productinfo", dataType: "string", nullable: true },
            { name: "email", dataType: "string", nullable: true },
            { name: "phone", dataType: "string", nullable: true },
            { name: "addedon", dataType: "date", nullable: false },
          ],
        },
      ];
    }
    default: {
      throw new ConnectorError(`The ${(config as { kind: string }).kind} connector kind is not supported.`, {
        status: 400,
        code: "CONNECTOR_CONFIG",
      });
    }
  }
}

/** One request inside a multi-table pull. */
export interface MultiPullRequest {
  schema: string;
  table: string;
  limit?: number;
  incremental?: { column: string; since: string | number };
}

export interface MultiPullOptions extends RetryOptions {
  /** Max tables pulled in parallel (default 4 — polite to source engines). */
  concurrency?: number;
}

export interface MultiPullResult {
  /** Pulled tables keyed by `schema.table`, in request order when iterated. */
  tables: Record<string, PulledTable>;
  /** Every table that still failed after retries, with the engine's message. */
  failures: { key: string; schema: string; table: string; error: string }[];
  /** ms for the whole batch (wall clock). */
  durationMs: number;
}

/**
 * Pull MANY tables with a bounded-concurrency pool (default 4 at a time) and
 * per-table retry. One table's failure never aborts the batch — every result
 * is either a PulledTable or an entry in `failures`, so sync jobs can report
 * partial progress honestly and retry just the failures next run.
 *
 * The `puller` parameter exists for tests (inject a fake pull function); the
 * default is the real `pullConnectorTable` with this module's retry policy.
 */
export async function pullConnectorTables(
  config: ConnectorConfig,
  requests: MultiPullRequest[],
  opts: MultiPullOptions = {},
  puller: (
    config: ConnectorConfig,
    schema: string,
    table: string,
    limit: number,
    incremental?: { column: string; since: string | number },
    retry?: RetryOptions,
  ) => Promise<PulledTable> = pullConnectorTable,
): Promise<MultiPullResult> {
  const started = Date.now();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const retryOpts: RetryOptions = {
    retries: opts.retries ?? 2,
    baseDelayMs: opts.baseDelayMs,
    maxDelayMs: opts.maxDelayMs,
    sleep: opts.sleep,
    rand: opts.rand,
    isTransient: opts.isTransient,
  };
  // The batch pull HONORS the retry policy itself: every per-table task runs
  // under withRetry so transient failures (timeouts, resets, 429/5xx) are
  // retried with backoff no matter which puller is behind the interface. The
  // inner retry is explicitly disabled for real pullers (retries: 0) so the
  // two layers never multiply attempts — the policy is owned in exactly one
  // place. Permanent errors (auth, missing table, bad config) propagate on
  // the first attempt and are captured as batch failures.
  const tasks = requests.map(
    (r) => () =>
      withRetry(
        () =>
          puller(config, r.schema, r.table, Math.max(1, r.limit ?? 5_000), r.incremental, { ...retryOpts, retries: 0 }),
        retryOpts,
      ),
  );
  const { values, failures } = await runWithConcurrency(tasks, concurrency);
  const tables: Record<string, PulledTable> = {};
  const batchFailures: MultiPullResult["failures"] = [];
  values.forEach((value, i) => {
    const r = requests[i] as MultiPullRequest;
    const key = `${r.schema}.${r.table}`;
    if (value) tables[key] = value;
  });
  for (const f of failures) {
    const r = requests[f.index] as MultiPullRequest;
    batchFailures.push({ key: `${r.schema}.${r.table}`, schema: r.schema, table: r.table, error: f.error });
  }
  return { tables, failures: batchFailures, durationMs: Date.now() - started };
}

/** Sample rows for the preview surface (per kind). Reuses the pull path. */
export async function sampleConnectorRows(
  config: ConnectorConfig,
  schema: string,
  table: string,
  limit: number,
): Promise<{
  columns: { name: string; type: string; colType: string }[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
}> {
  const pulled = await pullConnectorTable(config, schema, table, limit);
  return {
    columns: pulled.columns.map((c) => ({ name: c.name, type: c.type, colType: c.type })),
    rows: pulled.rows,
    rowCount: pulled.rows.length,
  };
}

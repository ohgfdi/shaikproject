/**
 * In-browser DuckDB engine.
 *
 * Loads duckdb-wasm on first use (lazy, code-split), runs the same typed-CSV →
 * TEMP table → wrapped SELECT pipeline as the server engine, but entirely in
 * the user's browser. Queries never leave the page after the dataset rows have
 * been fetched once — the interactive win behind "chart updates < 100 ms".
 *
 * Assets (wasm + worker scripts) are copied to /duckdb/* at install/dev time;
 * no CDN is involved. Falls back to the caller (server API) on any failure via
 * DuckDbUnavailableError.
 *
 * Security posture: the engine only ever touches the CSV buffer this module
 * registers itself — real file access needs user grants and HTTP reads are
 * CORS-blocked, so user SQL cannot reach anything outside the page.
 */
// The duckdb-wasm runtime is imported lazily inside getEngine() so Next.js
// code-splits it into a separate chunk that is only downloaded when the
// in-browser engine first runs (the initial page load stays small).
import type * as duckdbTypes from "@duckdb/duckdb-wasm";

import {
  buildCastSelect,
  buildCsvColumns,
  buildDatasetCsv,
  describeToColumns,
  duckDbErrorMessage,
  DuckDbUnavailableError,
  quotedIdentifier,
  toSqlResultSet,
  type DuckDbArrowResult,
} from "@/lib/engine/duckdb/shared";
import { assertReadOnlySql, SqlError, sqlFromTable } from "@/lib/engine/sql";
import { publicEnv } from "@/lib/env-public";
import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

/** Asset URLs served from /public/duckdb (see scripts/copy-duckdb-assets.mjs). */
const MANUAL_BUNDLES: duckdbTypes.DuckDBBundles = {
  mvp: {
    mainModule: "/duckdb/duckdb-mvp.wasm",
    mainWorker: "/duckdb/duckdb-browser-mvp.worker.js",
  },
  eh: {
    mainModule: "/duckdb/duckdb-eh.wasm",
    mainWorker: "/duckdb/duckdb-browser-eh.worker.js",
  },
};

let enginePromise: Promise<{ db: duckdbTypes.AsyncDuckDB; conn: duckdbTypes.AsyncDuckDBConnection }> | null = null;

/** Capability probe: enable the in-browser engine only when it can actually run. */
export function isBrowserDuckDbSupported(): boolean {
  if (!publicEnv.NEXT_PUBLIC_DUCKDB_ENABLED) return false;
  if (typeof window === "undefined") return false;
  return typeof WebAssembly !== "undefined" && typeof Worker !== "undefined";
}

async function getEngine(): Promise<{ db: duckdbTypes.AsyncDuckDB; conn: duckdbTypes.AsyncDuckDBConnection }> {
  if (!enginePromise) {
    enginePromise = (async () => {
      try {
        // Lazy import: duckdb-wasm only loads (a separate ~1 MB chunk) the
        // first time an in-browser query runs.
        const duckdb = (await import("@duckdb/duckdb-wasm")) as typeof duckdbTypes;
        const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
        const worker = new Worker(bundle.mainWorker as string, { type: "module" });
        const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR), worker);
        await db.instantiate(bundle.mainModule as string, bundle.pthreadWorker as string | null);
        const conn = await db.connect();
        // NOTE: do NOT SET enable_external_access=false here — unlike the node
        // open-config flag, this statement disables the in-memory file buffer
        // that registerFileBuffer/read_csv_auto need, so every query would
        // fail. External access is already unreachable in the page: queries
        // run in a Web Worker against an in-memory temp table only, real file
        // reads need picker grants, and HTTP reads are blocked by CORS.
        return { db, conn };
      } catch (err) {
        enginePromise = null;
        throw new DuckDbUnavailableError(err);
      }
    })();
  }
  return enginePromise;
}

/**
 * Run a read-only SELECT entirely in the browser against the given rows.
 * Rows are loaded into a TEMP table on first call (buffered in memory); repeat
 * calls reuse the same table, so filters/re-runs are sub-100ms.
 */
export async function runBrowserSql(
  columns: { name: string; type: ColType }[],
  rows: SqlValue[][],
  sql: string,
  opts: { rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  return runBrowserSqlMany([{ name: sqlFromTable(sql) ?? "aerolexa_data", columns, rows }], { ...opts, sql });
}

export interface BrowserDuckDbDatasetSource {
  name: string;
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
}

export async function runBrowserSqlMany(
  sources: BrowserDuckDbDatasetSource[],
  opts: { sql?: string; rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  const started = Date.now();
  const sql = opts.sql ?? "";
  const rowCap = Math.max(1, opts.rowCap ?? 5000);
  if (sources.length === 0) throw new SqlError("No datasets were supplied. Choose at least one dataset.");
  assertReadOnlySql(sql);
  const { db, conn } = await getEngine();
  const buffers: string[] = [];
  try {
    for (const source of sources) {
      const bufferName = `aerolexa_browser_${Date.now().toString(36)}_${buffers.length}.csv`;
      buffers.push(bufferName);
      const csv = buildDatasetCsv(source.columns, source.rows);
      await db.registerFileBuffer(bufferName, new TextEncoder().encode(csv));
      const colsMap = buildCsvColumns(source.columns);
      await conn.query(
        `CREATE TEMP TABLE ${quotedIdentifier(source.name)} AS SELECT * FROM read_csv_auto('${bufferName}', header=true, columns=${colsMap})`,
      );
    }
    // Same DESCRIBE + cast wrapper as the server engine: exact totals, hard
    // row cap, and no transfer-unsafe BIGINT columns in the result.
    const describe = await conn.query(`DESCRIBE ${sql.replace(/;+\s*$/, "").trim()}`);
    const describeCols = describeToColumns(describe.toArray() as unknown as Record<string, unknown>[]);
    const wrapped = buildCastSelect(sql, describeCols, rowCap);
    const arrow = await conn.query(wrapped);
    const result: DuckDbArrowResult = {
      fields: arrow.schema.fields.map((f) => ({ name: f.name, type: { typeId: f.typeId } })),
      rows: arrow.toArray().map((r) => r as unknown as Record<string, unknown>),
    };
    return toSqlResultSet(result, rowCap, Date.now() - started, opts.coverageNote ?? "");
  } catch (err) {
    if (err instanceof SqlError || err instanceof DuckDbUnavailableError) throw err;
    throw new SqlError(duckDbErrorMessage(err));
  } finally {
    for (const bufferName of buffers) await db.dropFile(bufferName).catch(() => undefined);
  }
}

/**
 * Server-side DuckDB engine.
 *
 * Runs the same WASM core the browser uses, but inside a worker_threads shim so
 * DuckDB executes off the main Node event loop. A single long-lived database
 * instance is shared across requests; each call opens its own connection,
 * registers a typed CSV buffer, materializes a TEMP table and runs the user's
 * read-only SELECT wrapped with an exact row-count + cap. Connections are
 * closed after every call, so TEMP tables never leak between requests.
 *
 * Security posture: the database is opened with `enable_external_access=false`
 * (no ATTACH / file / HTTP access), only read-only SELECTs are accepted by the
 * shared SQL guard, and the worker is contained within this process.
 */
import type * as duckdbTypes from "@duckdb/duckdb-wasm";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker as RawWorker } from "node:worker_threads";

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
import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

/** Re-exported so callers can detect engine-unavailability and fall back. */
export { DuckDbUnavailableError } from "@/lib/engine/duckdb/shared";

/**
 * Minimal web-worker-shaped shim over node:worker_threads so DuckDB's
 * AsyncDuckDB can attach (it expects addEventListener/postMessage/terminate).
 * The node bundle spawns its binding worker through `workerData.mod`.
 */
class CompatWorker {
  private w: RawWorker;
  private em: EventEmitter;
  /** worker thread is unref'd so a warm DuckDB never blocks process exit. */
  constructor(entry: string, workerData: unknown) {
    this.w = new RawWorker(entry, { workerData });
    this.w.unref();
    this.em = new EventEmitter();
    this.w.on("message", (d) => this.em.emit("message", { data: d }));
    this.w.on("error", (e) => {
      this.em.emit("error", e);
    });
    this.w.on("exit", (c) => this.em.emit("close", { code: c }));
  }
  postMessage(data: unknown, transfer?: unknown[]) {
    this.w.postMessage(data, transfer as never);
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.em.on(type, fn);
  }
  removeEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.em.off(type, fn);
  }
  terminate() {
    return this.w.terminate();
  }
}

let dbPromise: Promise<duckdbTypes.AsyncDuckDB> | null = null;
let workerRef: CompatWorker | null = null;

/**
 * Resolve the duckdb-node bundle (dynamic import of the CJS entry).
 */
async function loadDuckDbModule(): Promise<typeof duckdbTypes> {
  const mod = (await import("@duckdb/duckdb-wasm/dist/duckdb-node.cjs")) as unknown as typeof duckdbTypes;
  return mod;
}

async function resolveDistDir(): Promise<string> {
  // Find the duckdb-wasm dist directory. Try multiple strategies because
  // process.cwd() may differ from the project root (e.g. tests run from a
  // monorepo root while node_modules lives inside the app directory).
  const candidates = [
    // 1. node_modules next to cwd (typical when running from the app dir)
    path.join(process.cwd(), "node_modules", "@duckdb", "duckdb-wasm", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // 2. Upward search from cwd (covers hoisted installs and monorepo roots,
  //    i.e. everything require.resolve would have walked, without a dynamic
  //    require webpack has to treat as an opaque expression).
  let dir = path.resolve(process.cwd());
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, "node_modules", "@duckdb", "duckdb-wasm", "dist");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new DuckDbUnavailableError(
    new Error("Could not locate @duckdb/duckdb-wasm dist directory. Ensure the package is installed."),
  );
}

/** Create the shared AsyncDuckDB instance (worker thread + wasm, in-memory). */
export async function getDuckDb(): Promise<duckdbTypes.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        const duckdb = await loadDuckDbModule();
        const dist = await resolveDistDir();
        const workerJs = path.join(dist, "duckdb-node-eh.worker.cjs");
        const wasm = path.join(dist, "duckdb-eh.wasm");
        const entry = path.join(dist, "duckdb-node.cjs");
        const worker = new CompatWorker(entry, { mod: workerJs });
        workerRef = worker;
        // CompatWorker is a duckdb-shaped Worker — cast through unknown since
        // it intentionally omits DOM-only members (dispatchEvent etc.).
        const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker as unknown as Worker);
        await db.instantiate(wasm);
        await db.open({
          path: ":memory:",
          // Runtime option; the published type lags the dev build.
          query: { enable_external_access: false } as unknown as duckdbTypes.DuckDBQueryConfig,
        });
        return db;
      } catch (err) {
        dbPromise = null;
        throw new DuckDbUnavailableError(err);
      }
    })();
  }
  return dbPromise;
}

async function newConnection(db: duckdbTypes.AsyncDuckDB): Promise<{
  conn: duckdbTypes.AsyncDuckDBConnection;
  close: () => Promise<void>;
}> {
  const conn = await db.connect();
  return { conn, close: () => conn.close() };
}

/** Run a read-only SELECT against DuckDB over the given rows. */
export async function runDuckDbSql(
  columns: { name: string; type: ColType }[],
  rows: SqlValue[][],
  sql: string,
  opts: { rowCap?: number; coverageNote?: string } = {},
): Promise<SqlResultSet> {
  return runDuckDbSqlMany([{ name: sqlFromTable(sql) ?? "aerolexa_data", columns, rows }], {
    sql,
    rowCap: opts.rowCap,
    coverageNote: opts.coverageNote,
  });
}

export interface DuckDbDatasetSource {
  name: string;
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
}

/** Run read-only SQL over multiple named datasets in one isolated connection. */
export async function runDuckDbSqlMany(
  sources: DuckDbDatasetSource[],
  opts: { sql: string; rowCap?: number; coverageNote?: string },
): Promise<SqlResultSet> {
  const started = Date.now();
  const sql = opts.sql;
  const rowCap = Math.max(1, opts.rowCap ?? 5000);
  if (sources.length === 0) throw new SqlError("No datasets were supplied. Choose at least one dataset.");
  assertReadOnlySql(sql);
  const db = await getDuckDb();
  const { conn, close } = await newConnection(db);
  const buffers: string[] = [];
  try {
    for (const source of sources) {
      const bufferName = `aerolexa_${Date.now().toString(36)}_${buffers.length}.csv`;
      buffers.push(bufferName);
      const csv = buildDatasetCsv(source.columns, source.rows);
      await db.registerFileBuffer(bufferName, new TextEncoder().encode(csv));
      const colsMap = buildCsvColumns(source.columns);
      await conn.query(
        `CREATE TEMP TABLE ${quotedIdentifier(source.name)} AS SELECT * FROM read_csv_auto('${bufferName}', header=true, columns=${colsMap})`,
      );
    }
    // DESCRIBE plans the query only — it never executes it — and tells us the
    // result types so we can cast transfer-unsafe ones (BIGINT aggregates like
    // COUNT(*) map to JS BigInt, which the node worker cannot serialize).
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
    // DuckDB binder/catalog/parser errors are readable — surface them as a
    // friendly SQL_INPUT 400 (the prototype parser's SqlError contract).
    throw new SqlError(duckDbErrorMessage(err));
  } finally {
    for (const bufferName of buffers) await db.dropFile(bufferName).catch(() => undefined);
    await close();
  }
}

/** Shut the shared engine down (tests / server shutdown). */
export async function disposeDuckDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    if (db) await db.terminate().catch(() => undefined);
    dbPromise = null;
  }
  if (workerRef) {
    workerRef.terminate();
    workerRef = null;
  }
}

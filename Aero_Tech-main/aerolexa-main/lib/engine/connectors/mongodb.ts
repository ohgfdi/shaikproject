/**
 * Real MongoDB connector (official mongodb driver over TCP).
 *
 * Connections are opened with `readPreference: secondaryPreferred` so reads
 * never load a primary, every read carries `maxTimeMS`, and the engine only
 * ever issues read primitives (listCollections / countDocuments / find) — no
 * write method exists in this module. Errors are translated into the app's
 * "What happened / How to fix" pattern.
 *
 * Row semantics: a MongoDB database is the connector "schema" and a collection
 * is the "table". Because documents are schema-free, the column list is
 * derived from the sampled documents (first-seen key order); object / array /
 * BSON values are flattened to JSON strings so the profiler pipeline is
 * unchanged.
 */
import { MongoClient, type Db, type Document } from "mongodb";
import os from "node:os";

import type { ColType, SqlValue } from "@/lib/types";

import type { MongoDbConfig } from "./config";
import { ConnectorError } from "./errors";

export const CONNECTOR_CONNECT_TIMEOUT_MS = 10_000;
export const CONNECTOR_QUERY_TIMEOUT_MS = 30_000;
export const MAX_SAMPLE_ROWS = 5000;
const LIST_COLLECTIONS_SCAN_LIMIT = 100;

export interface MongoTableRows {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
  totalRows: number;
  truncated: boolean;
}

export interface MongoConnectionMeta {
  serverVersion: string;
  latencyMs: number;
  database: string;
}

export interface MongoCollectionColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

/** Map a mongoDB / network failure to a clean, credential-free message. */
export function friendlyMongoError(err: unknown, destination?: string): ConnectorError {
  const inner = err as { name?: string; code?: string; message?: string };
  const dest = destination ? ` at ${destination}` : "";
  const message = inner.message ?? "";
  const name = inner.name ?? "";

  if (name === "MongoServerSelectionError" || name === "MongoNetworkError" || name === "MongoNetworkTimeoutError") {
    if (/timeout/i.test(message)) {
      return new ConnectorError(
        `The connection timed out${dest}. What happened: the database did not answer in time. How to fix: check network access and firewall rules, then retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    return new ConnectorError(
      `Could not reach the database${dest}. What happened: the MongoDB server could not be found or connected to. How to fix: confirm host and port, and that the database accepts TCP connections.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  if (name === "MongoAuthenticationError" || /authentication|bad auth|access denied/i.test(message)) {
    return new ConnectorError(
      `MongoDB rejected the user or password. What happened: authentication failed${dest}. How to fix: check the user, password and authSource in this connection, then save and test again.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (name === "MongoExceededTimeLimitError" || /exceeded time limit|maximum execution time/i.test(message)) {
    return new ConnectorError(
      `The query was cancelled because it ran too long. What happened: mongod interrupted the operation. How to fix: import a smaller collection or fewer documents, then retry.`,
      { status: 504, code: "CONNECTOR_TIMEOUT" },
    );
  }
  if (/not authorized|unauthorized/i.test(message)) {
    return new ConnectorError(
      `The connected user lacks permission to read this database or collection. What happened: permission denied. How to fix: grant the user read access on the target database, then retry.`,
      { status: 403, code: "CONNECTOR_PERMISSION" },
    );
  }
  if (inner.code === "ECONNREFUSED") {
    return new ConnectorError(
      `Could not reach the database${dest}. What happened: the connection was refused — the server may be down or the port wrong. How to fix: confirm host and port, and that the database accepts TCP connections.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  if (inner.code === "ETIMEDOUT" || inner.code === "EHOSTUNREACH" || inner.code === "ENETUNREACH") {
    return new ConnectorError(
      `The connection timed out${dest}. What happened: the database did not answer in time. How to fix: check network access and firewall rules, then retry.`,
      { status: 504, code: "CONNECTOR_TIMEOUT" },
    );
  }
  return new ConnectorError(
    `The MongoDB request failed. What happened: ${shortMongoMessage(message)}. How to fix: review the connection settings and the source objects, then retry.`,
    { status: 400, code: "CONNECTOR_ERROR" },
  );
}

function shortMongoMessage(message: string): string {
  const sentence = message.split(/\.\s+|\n/)[0] ?? "unknown error";
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

function clientOptions(config: MongoDbConfig) {
  return {
    directConnection: true,
    serverSelectionTimeoutMS: CONNECTOR_CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECTOR_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: CONNECTOR_QUERY_TIMEOUT_MS,
    tls: config.ssl,
    // Read from secondaries when present; combined with the read-only method
    // surface below, the engine cannot change data.
    readPreference: "secondaryPreferred" as const,
    // Pin the os adapter eagerly: the driver's default resolves it via a
    // dynamic `import("os")`, which jest intercepts and rejects unless run
    // with --experimental-vm-modules (breaking the client-metadata handshake).
    runtimeAdapters: { os },
    ...(config.user
      ? {
          auth: {
            username: config.user,
            password: config.password,
            source: config.authSource ?? config.database,
          },
        }
      : {}),
  };
}

/** Open a read-only client for `database`, run `fn`, always close. */
export async function withMongoClient<T>(config: MongoDbConfig, fn: (client: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(
    `mongodb://${config.host}:${config.port}/${encodeURIComponent(config.database)}`,
    clientOptions(config),
  );
  try {
    await client.connect();
    return await fn(client.db(config.database));
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw friendlyMongoError(err, `${config.host}:${config.port}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Verify the connection answers `ping` and report latency + MongoDB version. */
export async function testMongoDbConnection(config: MongoDbConfig): Promise<MongoConnectionMeta> {
  const started = Date.now();
  return withMongoClient(config, async (db) => {
    await db.command({ ping: 1 });
    let serverVersion = "MongoDB";
    try {
      const build = (await db.command({ buildInfo: 1 })) as { version?: string };
      if (typeof build.version === "string" && build.version) serverVersion = build.version;
    } catch {
      // buildInfo can be disabled for non-admin roles — reachability already proved.
    }
    return { serverVersion, latencyMs: Date.now() - started, database: config.database };
  });
}

/**
 * List collections in the configured database (they read as "tables") and the
 * field names seen in a single sampled document per collection. Sampling is
 * best-effort and time-boxed so a large or permission-restricted collection
 * still lists with an empty column set instead of failing the whole browse.
 */
export async function listMongoCollections(
  db: Db,
): Promise<{ schema: string; name: string; columns: MongoCollectionColumn[] }[]> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const out: { schema: string; name: string; columns: MongoCollectionColumn[] }[] = [];
  for (const collection of collections.slice(0, LIST_COLLECTIONS_SCAN_LIMIT)) {
    const name = collection.name;
    const columns = await sampleCollectionColumns(db, name);
    out.push({ schema: db.databaseName, name, columns });
  }
  return out;
}

async function sampleCollectionColumns(db: Db, collectionName: string): Promise<MongoCollectionColumn[]> {
  try {
    const docs = await db.collection(collectionName).find({}).limit(1).maxTimeMS(3000).toArray();
    const doc = docs[0];
    if (!doc) return [];
    return Object.keys(doc).map((name) => ({
      name,
      dataType: mongoDocTypeLabel(doc[name]),
      nullable: true,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch up to `limit` documents of a collection for import into a Dataset.
 * Columns are inferred from the sampled documents and typed for Ledgerly's
 * profiler (ColType) so imported data flows through the same pipeline as CSV.
 * `filter` is the incremental watermark predicate ({ col: { $gt: value } }),
 * built exclusively by buildWatermarkMongoFilter — never user text.
 */
export async function fetchMongoCollectionRows(
  db: Db,
  collectionName: string,
  limit: number,
  filter?: Record<string, unknown>,
): Promise<MongoTableRows> {
  const safeLimit = Math.max(1, Math.min(limit, MAX_SAMPLE_ROWS));
  const collection = db.collection(collectionName);
  const totalRows = await collection.countDocuments(filter ?? {}, { maxTimeMS: CONNECTOR_QUERY_TIMEOUT_MS });
  const docs = await collection
    .find(filter ?? {})
    .limit(safeLimit)
    .maxTimeMS(CONNECTOR_QUERY_TIMEOUT_MS)
    .toArray();

  const columnNames: string[] = [];
  for (const doc of docs) {
    for (const key of Object.keys(doc as Document)) {
      if (!columnNames.includes(key)) columnNames.push(key);
    }
  }
  const columns = columnNames.map((name) => ({ name, type: aggregateColType(docs, name) }));
  const rows = docs.map((doc) => columns.map((column) => mongoValueToCell((doc as Document)[column.name])));
  return { columns, rows, totalRows, truncated: totalRows > rows.length };
}

/** Union type across documents — number wins, then date, then boolean, else string. */
function aggregateColType(docs: Document[], name: string): ColType {
  let best: ColType = "string";
  const rank: Record<ColType, number> = { string: 0, boolean: 1, date: 2, number: 3 };
  for (const doc of docs) {
    const value = (doc as Document)[name];
    if (value === null || value === undefined) continue;
    const type = mongoValueColType(value);
    if (rank[type] > (rank[best] ?? 0)) best = type;
  }
  return best;
}

function mongoValueColType(value: unknown): ColType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  return "string";
}

/** Human label for a sampled field value (schema browser badges). */
function mongoDocTypeLabel(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (typeof value === "object") return "object";
  return "string";
}

/** Convert a BSON value to a serializable SqlValue. */
export function mongoValueToCell(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value !== null && typeof value === "object") {
    // ObjectId (and other BSON id types) flatten to their plain hex string.
    const oid = (value as { toHexString?: () => string }).toHexString;
    if (typeof oid === "function") return oid.call(value);
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value, mongoJsonReplacer);
  }
  return String(value);
}

/** JSON-safe serialization for BSON: ObjectId, Buffer, Date, BigInt. */
function mongoJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "bigint") return Number.isSafeInteger(value) ? Number(value) : value.toString();
  if (value !== null && typeof value === "object") {
    const oid = (value as { toHexString?: () => string }).toHexString;
    if (typeof oid === "function") return oid.call(value);
  }
  return value;
}

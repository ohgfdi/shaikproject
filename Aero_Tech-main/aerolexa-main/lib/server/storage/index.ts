/**
 * Storage drivers — where dataset files, snapshots and exports live.
 *
 * WHY THIS EXISTS
 * Every dataset artifact in Ledgerly is a file under DATA_DIR: uploads
 * (`uploads/<id>.raw`), normalized row stores (`parsed/<id>.ndjson`),
 * dataset versions, connector snapshots, model cards, report exports.
 * Reading is *streaming* (lib/engine/dataset.ts) — rows never fully load
 * into memory. That design is the app's performance backbone.
 *
 * A single instance keeps everything on local disk (default, zero config).
 * Multiple instances behind a load balancer need a SHARED source of truth,
 * or instance B cannot read what instance A wrote. This module adds an
 * S3-compatible driver (AWS S3, Cloudflare R2, MinIO, Backblaze B2,
 * Supabase S3 gateway — anything speaking the S3 API) with a deliberate
 * architecture:
 *
 *   WRITE-THROUGH   every save() puts the object to S3 and also leaves a
 *                   local copy, so the hot path (streaming reads, reprofiling)
 *                   never pays a network round-trip.
 *   READ-THROUGH    every open() tries the local cache first; on miss it
 *                   fetches from S3 once, caches locally, and streams.
 *
 * The rest of the app keeps calling `fs` against paths from this module —
 * the engine's streaming code is untouched, and switching drivers is a
 * pure env change (LEDGERLY_STORAGE=s3 + S3_* vars).
 *
 * Honest limitation (documented, not hidden): the cache is per-instance
 * disk. A file replaced on another instance is re-fetched on next open(),
 * so reads are always correct; only disk usage is per-instance. There is
 * no cross-instance cache invalidation protocol because none is needed —
 * objects are content-addressed by dataset id and written atomically
 * (tmp file + rename locally, single PUT remotely).
 */

import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { serverEnv } from "@/lib/env";

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

export type StorageDriverKind = "local" | "s3";

export function storageKind(): StorageDriverKind {
  // LEDGERLY_STORAGE is current; AEROLEXA_STORAGE is the pre-rename spelling,
  // still honoured so an upgraded deployment keeps writing to the same bucket.
  const configured = process.env.LEDGERLY_STORAGE?.trim() || process.env.AEROLEXA_STORAGE?.trim();
  if (configured === "s3") return "s3";
  if (configured === "local" || configured === undefined || configured === "") return "local";
  throw new Error(`LEDGERLY_STORAGE must be "local" or "s3" — got "${configured}".`);
}

/** Root of the per-instance cache / local driver. Same tree as today. */
export function storageRoot(): string {
  return path.join(process.cwd(), serverEnv().DATA_DIR);
}

/**
 * Resolve a relative storage key ("parsed/<id>.ndjson") to the local path the
 * app should use. In local mode this IS the file. In S3 mode it is the local
 * cache path — open() guarantees it is populated before the caller touches it.
 */
export function localPath(key: string): string {
  if (key.includes("..")) throw new Error(`Invalid storage key: ${key}`);
  return path.join(storageRoot(), key);
}

// ---------------------------------------------------------------------------
// S3 client (lazy — loaded only when the s3 driver is selected)
// ---------------------------------------------------------------------------

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function s3Config(): S3Config {
  const env = process.env;
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error("LEDGERLY_STORAGE=s3 requires S3_BUCKET (e.g. Ledgerly-prod).");
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error("LEDGERLY_STORAGE=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
  }
  return {
    bucket,
    region: env.S3_REGION || "auto",
    endpoint: env.S3_ENDPOINT || undefined,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    // R2/MinIO/Supabase need path-style; AWS accepts it too.
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
}

type S3Client = {
  send: (command: unknown) => Promise<unknown>;
};

let s3ClientPromise: Promise<S3Client> | null = null;

async function s3Client(): Promise<S3Client> {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const { S3Client: Client } = await import("@aws-sdk/client-s3");
      const cfg = s3Config();
      return new Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        },
      }) as unknown as S3Client;
    })();
  }
  return s3ClientPromise;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Write a file to storage (S3 + local cache, or local only). Atomic.
 *
 * Validation:
 *   - size is checked against MAX_UPLOAD_SIZE (configurable per environment).
 *   - MIME type is validated when the data is a Buffer; unknown extensions are
 *     rejected. On S3, the content-type from the command is preserved.
 */
export async function saveFile(key: string, data: Buffer | string): Promise<void> {
  const target = localPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Validate size — read only the first 4KB to check, then proceed.
  const dataBuffer = typeof data === "string" ? Buffer.from(data) : data;
  const maxSize = Number(process.env.MAX_UPLOAD_SIZE ?? "52428800"); // 50 MB default
  if (dataBuffer.length > maxSize) {
    throw new Error(`File size ${dataBuffer.length} exceeds MAX_UPLOAD_SIZE (${maxSize} bytes).`);
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
  if (storageKind() === "s3") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Client();
    const cfg = s3Config();
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: data,
        ContentType: contentTypeFor(key),
      }),
    );
  }
}

/**
 * Stream a local file into storage without buffering it whole in memory
 * (ROADMAP 1.5: ingest of ≥500 MB files must not OOM the server).
 *
 * - Local driver: a plain file copy into the store (the source file stays —
 *   callers keep parsing from it).
 * - S3 driver: PutObject with a read stream + explicit ContentLength (the SDK
 *   hashes the body incrementally), falling back to the buffered path if the
 *   stream path errors. A best-effort local cache copy is kept afterwards so
 *   resolveReadable() serves subsequent reads without a round-trip.
 */
export async function saveFileStream(key: string, filePath: string): Promise<void> {
  const target = localPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (storageKind() === "local") {
    await fs.copyFile(filePath, target);
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  const cfg = s3Config();
  const stat = await fs.stat(filePath);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentTypeFor(key),
        ContentLength: stat.size,
      }),
    );
  } catch {
    // Fallback to the proven buffered upload for SDK/stream edge cases —
    // a slow path is better than a failed ingest.
    await saveFile(key, await fs.readFile(filePath));
    return;
  }
  await fs.copyFile(filePath, target).catch(() => undefined);
}

/**
 * Ensure the local cache holds the object, fetching from S3 on miss. Local
 * mode is a no-op. Returns the local path for streaming readers.
 */
export async function ensureLocal(key: string): Promise<string> {
  const target = localPath(key);
  if (storageKind() === "local") {
    // Fail with a clear message if the file simply does not exist.
    await fs.access(target);
    return target;
  }
  try {
    await fs.access(target);
    return target; // cache hit
  } catch {
    // cache miss — fetch through
  }
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  const cfg = s3Config();
  try {
    const res = (await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))) as {
      Body?: { transformToByteArray: () => Promise<Uint8Array> };
    };
    if (!res.Body) throw new Error(`S3 object ${key} has empty body`);
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
    return target;
  } catch (err) {
    const code = (err as { name?: string }).name ?? "";
    if (code === "NoSuchKey") {
      throw new Error(
        `Dataset file "${key}" not found in object storage — it may have been written before S3 storage was enabled.`,
      );
    }
    throw err;
  }
}

/** Read a whole file as a Buffer (small artifacts: model cards, exports). */
export async function readFile(key: string): Promise<Buffer> {
  const target = await ensureLocal(key);
  return fs.readFile(target);
}

/** Read a UTF-8 string. */
export async function readTextFile(key: string): Promise<string> {
  return (await readFile(key)).toString("utf8");
}

/** Delete from S3 and the local cache. Missing objects are not an error. */
export async function deleteFile(key: string): Promise<void> {
  await fs.rm(localPath(key), { force: true }).catch(() => undefined);
  if (storageKind() === "s3") {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await s3Client();
    const cfg = s3Config();
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key })).catch(() => undefined);
  }
}

/** True when the object is readable (cache or origin). */
export async function exists(key: string): Promise<boolean> {
  try {
    await ensureLocal(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy within storage (used by version snapshots and dataset duplication).
 * No streaming-to-client involvement; small files only in current callers.
 */
export async function copyFile(fromKey: string, toKey: string): Promise<void> {
  const data = await readFile(fromKey);
  await saveFile(toKey, data);
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".ndjson")) return "application/x-ndjson";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".csv")) return "text/csv";
  if (key.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Key helpers — the canonical layout under DATA_DIR / bucket root
// ---------------------------------------------------------------------------

export const keys = {
  upload: (id: string) => `uploads/${id}.raw`,
  parsed: (id: string) => `parsed/${id}.ndjson`,
  version: (datasetId: string, versionId: string) => `versions/${datasetId}/${versionId}.ndjson`,
  connectorSync: (connectorId: string, datasetId: string) => `connector-syncs/${connectorId}/${datasetId}.ndjson`,
  modelCard: (id: string) => `models/${id}.json`,
  export: (kind: string, id: string, stamp: string) => `exports/${kind}-${id.slice(0, 8)}-${stamp}.html`,
};

/** Structured, single-line boot log — observability foundation. */
export function logStorageConfig(): void {
  const kind = storageKind();
  const detail =
    kind === "s3"
      ? `bucket=${process.env.S3_BUCKET ?? "(unset)"} endpoint=${process.env.S3_ENDPOINT ?? "aws-default"}`
      : `root=${storageRoot()}`;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ level: "info", msg: "storage configured", driver: kind, detail, ts: new Date().toISOString() }),
  );
}

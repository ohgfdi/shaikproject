/**
 * S3/CSV connector (ROADMAP 1.3).
 *
 * Reads a CSV object from any S3-compatible bucket (AWS S3, MinIO, R2,
 * Spaces) through the same @aws-sdk/client-s3 the app's storage driver uses.
 * The bucket credential lives in the connector config (encrypted at rest);
 * `getObject` streams the body with a size cap, and the CSV parser matches
 * the HTTP connector's dialect (numbers inferred, blank→null).
 *
 * Watermark: the object's ETag/LastModified is the natural change marker —
 * the sync orchestrator records it in the connector's changelog so a poll
 * that sees the same ETag can skip re-materializing (handled upstream; here
 * every pull is a full pull of the object).
 */

import { createHash } from "node:crypto";

import { assertSafeExternalUrl } from "@/lib/server/url-guard";

import { ConnectorError } from "./errors";
import { csvBodyToTable } from "./http-source";

const MAX_OBJECT_BYTES = 512 * 1024 * 1024; // 512 MB object cap

export interface S3CsvConfig {
  /** S3-compatible endpoint; omit for AWS. e.g. https://minio.internal:9000 */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Object key (prefix/name.csv). */
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional path-style addressing (MinIO/R2/Spaces). Default true for non-AWS. */
  forcePathStyle?: boolean;
  /** CSV has a header row. Default true. */
  headerRow?: boolean;
}

type S3Client = {
  send: (command: unknown) => Promise<{
    Body?: { transformToByteArray: () => Promise<Uint8Array> };
    ETag?: string;
    LastModified?: Date;
    ContentLength?: number;
  }>;
};

let clientCache: { sig: string; client: S3Client } | null = null;

/**
 * Cache signature for the S3 client. SEC-4: the secret itself must be part of
 * the signature (hashed, never stored raw) — the previous
 * `accessKeyId.length` bug made two connectors whose keys had the SAME LENGTH
 * share one client, so connector A silently read with connector B's
 * credentials (cross-tenant credential mixing).
 */
function clientSignature(cfg: S3CsvConfig): string {
  const secretFingerprint = createHash("sha256").update(cfg.secretAccessKey).digest("hex").slice(0, 16);
  return `${cfg.endpoint ?? "aws"}|${cfg.region}|${cfg.accessKeyId}|${secretFingerprint}|${cfg.forcePathStyle ? 1 : 0}`;
}

/**
 * SEC-4: the connector endpoint is user-supplied config — validate it with
 * the strict SSRF guard (literal URL + DNS resolution + private-range checks)
 * before an S3 client is pointed at it, unless the explicit self-hosted
 * escape hatch is set (MinIO on a LAN is a legitimate deployment).
 */
async function assertSafeS3Endpoint(cfg: S3CsvConfig): Promise<void> {
  if (!cfg.endpoint) return; // default AWS — no user URL involved
  if (process.env.CONNECTOR_ALLOW_PRIVATE_URLS === "true") return;
  try {
    await assertSafeExternalUrl(cfg.endpoint);
  } catch (err) {
    throw new ConnectorError(
      `${err instanceof Error ? err.message : "Unsafe S3 endpoint"}. What happened: the connector's S3 endpoint failed the SSRF guard. How to fix: use the publicly reachable endpoint URL, or set CONNECTOR_ALLOW_PRIVATE_URLS=true on the server for self-hosted MinIO/LAN endpoints.`,
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
}

async function s3For(cfg: S3CsvConfig): Promise<S3Client> {
  await assertSafeS3Endpoint(cfg);
  const sig = clientSignature(cfg);
  if (clientCache && clientCache.sig === sig) return clientCache.client;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  }) as unknown as S3Client;
  clientCache = { sig, client };
  return client;
}

/** Validate a bucket object key (exported for unit gating). */
export function assertSaneKey(key: string): string {
  const trimmed = key.replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..")) {
    throw new ConnectorError(`Invalid object key “${key}”. How to fix: use the full object path inside the bucket.`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  return trimmed;
}

/** Fetch the object and parse it as CSV into the standard table shape. */
export async function fetchS3CsvRows(
  cfg: S3CsvConfig,
  limit: number,
): Promise<{
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
  etag: string | null;
}> {
  const key = assertSaneKey(cfg.key);
  const client = await s3For(cfg);
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  let res: Awaited<ReturnType<S3Client["send"]>>;
  try {
    res = (await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))) as Awaited<
      ReturnType<S3Client["send"]>
    >;
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "NoSuchKey" || name === "404") {
      throw new ConnectorError(
        `Object “${key}” does not exist in bucket “${cfg.bucket}”. How to fix: check the key and bucket names.`,
        {
          status: 404,
          code: "CONNECTOR_NOT_FOUND",
        },
      );
    }
    if (name === "AccessDenied" || name === "403") {
      throw new ConnectorError(
        `Access denied for bucket “${cfg.bucket}”. How to fix: check the access key's read permission.`,
        {
          status: 403,
          code: "CONNECTOR_REMOTE",
        },
      );
    }
    throw new ConnectorError(
      `Could not read “${key}” from “${cfg.bucket}”: ${err instanceof Error ? err.message : "storage error"}. How to fix: verify endpoint, region and credentials.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  if (typeof res.ContentLength === "number" && res.ContentLength > MAX_OBJECT_BYTES) {
    throw new ConnectorError(
      `Object (${(res.ContentLength / 1024 / 1024).toFixed(0)} MB) exceeds the 512 MB connector cap.`,
      {
        status: 502,
        code: "CONNECTOR_REMOTE",
      },
    );
  }
  if (!res.Body) {
    throw new ConnectorError("The S3 object has an empty body.", { status: 502, code: "CONNECTOR_REMOTE" });
  }
  const bytes = await res.Body.transformToByteArray();
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new ConnectorError("Object exceeds the 512 MB connector cap.", { status: 502, code: "CONNECTOR_REMOTE" });
  }
  const text = Buffer.from(bytes).toString("utf8");

  const table = csvBodyToTable(cfg.headerRow === false ? `column_1\n${text}` : text);
  const truncated = table.rows.length > limit;
  return {
    ...table,
    rows: table.rows.slice(0, limit),
    totalRows: table.rows.length,
    truncated,
    etag: res.ETag ?? null,
  };
}

/** Connection test: HeadObject on the configured key (no body transfer). */
export async function testS3CsvConnection(cfg: S3CsvConfig): Promise<{ serverVersion: string; latencyMs: number }> {
  const key = assertSaneKey(cfg.key);
  const client = await s3For(cfg);
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const started = Date.now();
  try {
    await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "NoSuchKey" || name === "404") {
      throw new ConnectorError(
        `Object “${key}” does not exist in bucket “${cfg.bucket}”. How to fix: check the key and bucket names.`,
        {
          status: 404,
          code: "CONNECTOR_NOT_FOUND",
        },
      );
    }
    throw new ConnectorError(
      `Could not reach bucket “${cfg.bucket}”: ${err instanceof Error ? err.message : "storage error"}. How to fix: verify endpoint, region and credentials.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  return {
    serverVersion: `s3-compatible${cfg.endpoint ? ` (${new URL(cfg.endpoint).host})` : " (aws)"}`,
    latencyMs: Date.now() - started,
  };
}

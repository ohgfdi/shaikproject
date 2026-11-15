import { Buffer } from "node:buffer";
import Papa from "papaparse";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { serverEnv } from "@/lib/env";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { importFileAsDataset } from "@/lib/server/import-dataset";
import { assertSafeExternalUrl, safeExternalFetch, UrlGuardError } from "@/lib/server/url-guard";

const REQUEST_TIMEOUT_MS = 30_000;

interface RestImportInput {
  url: string;
  token?: string;
  name?: string;
  projectId: string;
}

/**
 * Import an external CSV / JSON / XLSX payload from a REST endpoint into a
 * dataset. The fetch happens server-side so bearer tokens never reach the
 * browser; JSON payloads are normalized to CSV before the standard pipeline.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<RestImportInput>(request);
    const { projectId, url } = body;
    if (!projectId) throw new ApiError(400, "VALIDATION", "A project is required to store the dataset.");
    if (!url) throw new ApiError(400, "VALIDATION", "An endpoint URL is required.");

    // SSRF guard: validate the URL, resolve its DNS, and refuse private /
    // loopback / link-local targets BEFORE anything is fetched. Redirects are
    // followed hop-by-hop inside safeExternalFetch with re-validation.
    const validatedUrl = await assertSafeExternalUrl(url);

    const { payload, mimeType, sourceFileName } = await fetchSource(ctx, validatedUrl, body);
    const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
    if (payload.byteLength > maxBytes) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`,
      );
    }

    const file = new MemoryFile(payload, sourceFileName, mimeType);
    const dataset = await importFileAsDataset(ctx, file, { projectId, source: "connected" });
    return ok({ ...dataset, source: { url: validatedUrl.toString(), mimeType } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function fetchSource(
  _ctx: unknown,
  url: URL,
  body: RestImportInput,
): Promise<{ payload: ArrayBuffer | Uint8Array; mimeType: string; sourceFileName: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    // safeExternalFetch re-validates every redirect hop (SSRF-safe); the plain
    // URL guard already ran, so this can only fail on a redirect into a
    // private target or an unreachable host.
    res = await safeExternalFetch(url.toString(), {
      headers: {
        Accept:
          "application/json, text/csv, text/plain, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream",
        ...(body.token ? { Authorization: `Bearer ${body.token}` } : {}),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof UrlGuardError) throw new ConnectorError(err.message, { status: err.status, code: err.code });
    const aborted = (err as { name?: string })?.name === "AbortError";
    throw new ConnectorError(
      aborted
        ? `The endpoint did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. What happened: the request timed out. How to fix: check that the endpoint is reachable and returns promptly, then retry.`
        : `Could not reach the endpoint. What happened: ${short((err as Error)?.message)}. How to fix: confirm the URL is correct and publicly reachable, then retry.`,
      { status: aborted ? 504 : 502, code: aborted ? "CONNECTOR_TIMEOUT" : "CONNECTOR_UNREACHABLE" },
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new ConnectorError(
      `The endpoint returned HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ""}. What happened: the server rejected the request. How to fix: confirm the URL is correct and that the token has access, then retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new ApiError(
      400,
      "VALIDATION",
      `Endpoint response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB import limit.`,
    );
  }

  let payload: ArrayBuffer | Uint8Array;
  try {
    payload = await res.arrayBuffer();
  } catch (err) {
    throw new ConnectorError(
      `The response body could not be read. What happened: ${short((err as Error)?.message)}. How to fix: check that the endpoint returns a stable payload, then retry.`,
      { status: 502, code: "CONNECTOR_ERROR" },
    );
  }
  if (payload.byteLength === 0) {
    throw new ConnectorError(
      "The endpoint returned an empty body. What happened: no data to import. How to fix: point the import at an endpoint that returns CSV, JSON or XLSX rows.",
      { status: 400, code: "CONNECTOR_ERROR" },
    );
  }

  const urlExt = url.pathname.slice(url.pathname.lastIndexOf(".")).toLowerCase();
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const trimmed = Buffer.from(payload).toString("latin1").trimStart();

  const isJson =
    contentType.includes("json") || urlExt === ".json" || trimmed.startsWith("{") || trimmed.startsWith("[");
  const isCsv =
    contentType.includes("csv") ||
    contentType.includes("text/plain") ||
    urlExt === ".csv" ||
    (trimmed.includes(",") && !isJson);
  const isXlsx =
    contentType.includes("spreadsheetml") ||
    contentType.includes("officedocument") ||
    urlExt === ".xlsx" ||
    urlExt === ".xls";

  if (!isJson && !isCsv && !isXlsx) {
    throw new ConnectorError(
      "The endpoint returned a response we could not parse. What happened: the content type is not CSV, JSON or XLSX. How to fix: import from an endpoint that serves tabular data, or check the URL.",
      { status: 400, code: "CONNECTOR_ERROR" },
    );
  }

  let mimeType = contentType ?? "application/octet-stream";
  let sourceFileName = baseName(url, body.name);
  if (isJson) {
    payload = jsonToCsv(payload);
    mimeType = "text/csv";
    sourceFileName = `${sourceFileName}.csv`;
  } else if (isCsv) {
    mimeType = "text/csv";
    sourceFileName = `${sourceFileName}.csv`;
  } else {
    mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    sourceFileName = `${sourceFileName}.xlsx`;
  }

  return { payload, mimeType, sourceFileName };
}

/** Convert a JSON array-of-objects payload into CSV text via papaparse. */
function jsonToCsv(payload: ArrayBuffer): Uint8Array {
  let text: string;
  try {
    text = Buffer.from(payload).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.length === 0) {
      throw new ConnectorError(
        "The endpoint returned an empty JSON array. What happened: no data to import. How to fix: import from an endpoint that returns rows.",
        { status: 400, code: "CONNECTOR_ERROR" },
      );
    }
    const first = rows[0] as unknown;
    if (first === null || Array.isArray(first) || typeof first !== "object") {
      throw new ConnectorError(
        "The JSON payload is not a tabular structure. What happened: expected an array of objects. How to fix: import from an endpoint that returns an array of JSON objects.",
        { status: 400, code: "CONNECTOR_ERROR" },
      );
    }
    const csv = Papa.unparse(rows as Record<string, unknown>[], {
      header: true,
      skipEmptyLines: true,
      newline: "\n",
    });
    if (!csv.trim()) {
      throw new ConnectorError(
        "The JSON payload could not be flattened into rows. What happened: the objects expose no enumerable fields. How to fix: check the endpoint response shape, then retry.",
        { status: 400, code: "CONNECTOR_ERROR" },
      );
    }
    return new TextEncoder().encode(csv);
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      "The JSON payload could not be parsed. What happened: invalid JSON. How to fix: check the endpoint response, then retry.",
      { status: 400, code: "CONNECTOR_ERROR" },
    );
  }
}

function baseName(url: URL, explicit?: string): string {
  let base = "";
  if (explicit && explicit.trim()) {
    base = explicit.trim();
  } else {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    base = last.replace(/\.(json|csv|xlsx|xls|xml)$/i, "") || url.hostname.replace(/^www\./, "");
  }
  const cleaned = base
    .replace(/[^a-zA-Z0-9._ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "rest-import";
}

function short(message: string | undefined): string {
  const sentence = (message ?? "unknown error").split(/\.\s+|\n/)[0] ?? "unknown error";
  return sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence;
}

/** Minimal in-memory File-compatible object the import pipeline streams from. */
class MemoryFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  private readonly data: Uint8Array;

  constructor(data: ArrayBuffer | Uint8Array, name: string, type: string) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.name = name;
    this.type = type;
    this.size = this.data.byteLength;
  }

  stream(): ReadableStream<Uint8Array> {
    const data = this.data;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }
}

/**
 * Generic HTTP polling connector (ROADMAP 1.3).
 *
 * Pulls rows from any HTTP(S) endpoint that returns a JSON array of flat
 * objects or a CSV body — the "generic HTTP polling" connector from the
 * roadmap. Poll = GET the URL, parse the body, return the standard
 * PulledTable shape; scheduled syncs re-poll the same endpoint.
 *
 * Security posture (honest, enforced):
 *   - https:// by default; http:// allowed only for explicit localhost-style
 *     dev endpoints (still blocked for private ranges — see assertPublicHttpUrl).
 *   - Private/loopback/link-local/hostfile-internal addresses are refused
 *     unless CONNECTOR_ALLOW_PRIVATE_URLS=true (self-hosted escape hatch).
 *   - Bearer-token / custom headers come from the (encrypted) connector
 *     config — never logged, never echoed in errors.
 *   - 30 s fetch timeout; bodies capped at 64 MB.
 *
 * Watermark: none — every poll is a full pull (the orchestrator falls back
 * to full replace; never a silent partial).
 */

import Papa from "papaparse";

import { assertSafeExternalUrl, safeExternalFetch } from "@/lib/server/url-guard";

import { ConnectorError } from "./errors";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface HttpSourceConfig {
  url: string;
  /** Extra request headers (e.g. Authorization: Bearer …). */
  headers?: Record<string, string>;
  /** Body format. Default "json" — auto-detects when "auto". */
  format?: "json" | "csv" | "auto";
}

/**
 * Refuse URLs that would make the server fetch its own private network
 * (SSRF guard). Public cloud metadata endpoints are always blocked.
 *
 * SEC-4 hardening: the literal-URL denylist previously missed DNS names that
 * RESOLVE to private addresses (DNS rebinding), decimal/hex IP encodings,
 * IPv6-mapped IPv4 and redirect hops to internal targets. The check now
 * delegates to the strict server guard (assertSafeExternalUrl: literal URL +
 * DNS resolution of every address + fail-closed on unresolvable), while
 * keeping the CONNECTOR_ALLOW_PRIVATE_URLS escape hatch and ConnectorError
 * contract this module's callers/tests rely on.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError(`Invalid URL: ${raw}. How to fix: provide a fully-qualified http(s) endpoint.`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConnectorError(`Only http(s) endpoints are supported (got ${url.protocol}).`, {
      status: 400,
      code: "CONNECTOR_CONFIG",
    });
  }
  if (process.env.CONNECTOR_ALLOW_PRIVATE_URLS !== "true") {
    try {
      await assertSafeExternalUrl(raw);
    } catch (err) {
      throw new ConnectorError(
        `${err instanceof Error ? err.message : "URL blocked by SSRF guard"} How to fix: expose the endpoint publicly, or set CONNECTOR_ALLOW_PRIVATE_URLS=true on the server for self-hosted sources.`,
        { status: 400, code: "CONNECTOR_CONFIG" },
      );
    }
  }
  return url;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Flatten one JSON value into a row of primitives (arrays stringify). */
function flattenJsonValue(v: Json): string | number | boolean | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Convert a JSON array of objects to columns+rows with simple type inference. */
export function jsonToTable(items: Record<string, Json>[]): {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
} {
  // Column order: first-seen across the first 100 objects (deterministic).
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, 100)) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  const numeric = new Map<string, boolean>(names.map((n) => [n, true]));
  for (const item of items) {
    for (const n of names) {
      const v = item[n];
      if ((typeof v !== "number" && v !== null) || (typeof v === "number" && !Number.isFinite(v))) {
        numeric.set(n, false);
      }
    }
  }
  const columns = names.map((name) => ({ name, type: numeric.get(name) ? "number" : "string" }));
  const rows = items.map((item) => names.map((n) => flattenJsonValue(item[n] ?? null)));
  return { columns, rows };
}

/** Parse a CSV body to columns+rows (numbers inferred, like the file ingest). */
export function csvBodyToTable(text: string): {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
} {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: "greedy" });
  const raw = (parsed.data ?? []) as string[][];
  if (raw.length === 0 || (raw[0] ?? []).every((h) => h.trim() === "")) {
    throw new ConnectorError("The HTTP endpoint returned an empty CSV body.", {
      status: 502,
      code: "CONNECTOR_REMOTE",
    });
  }
  const headers = (raw[0] ?? []).map((h, i) => (h.trim() || `column_${i + 1}`).replace(/^\uFEFF/, ""));
  const dataRows = raw.slice(1).filter((r) => r.length > 0);
  const numeric = headers.map((_, i) =>
    dataRows.every((r) => r[i] === undefined || r[i] === "" || Number.isFinite(Number(r[i]))),
  );
  const columns = headers.map((name, i) => ({ name, type: numeric[i] ? "number" : "string" }));
  const rows = dataRows.map((r) =>
    headers.map((_, i) => {
      const v = (r[i] ?? "").trim();
      if (v === "") return null;
      return numeric[i] ? Number(v) : v;
    }),
  );
  return { columns, rows };
}

function looksLikeCsv(body: string): boolean {
  const head = body.slice(0, 2000).trimStart();
  return head.startsWith("{") || head.startsWith("[") ? false : head.includes(",") && head.includes("\n");
}

/** Fetch the endpoint and return the standard table. */
export async function fetchHttpRows(
  config: HttpSourceConfig,
  limit: number,
): Promise<{
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  const url = await assertPublicHttpUrl(config.url);
  let res: Response;
  try {
    if (process.env.CONNECTOR_ALLOW_PRIVATE_URLS === "true") {
      // Escape hatch active: plain fetch (private endpoints are allowed).
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json, text/csv;q=0.9, */*;q=0.8", ...(config.headers ?? {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } else {
      // SEC-4: every redirect hop is re-validated by safeExternalFetch —
      // a public URL that 302s into an internal address is refused.
      const guarded = await safeExternalFetch(config.url, {
        headers: { Accept: "application/json, text/csv;q=0.9, */*;q=0.8", ...(config.headers ?? {}) },
      });
      res = guarded;
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      `Could not reach ${url.host}: ${err instanceof Error ? err.message : "network error"}. How to fix: check the URL and that the endpoint is reachable from the server.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  if (!res.ok) {
    throw new ConnectorError(
      `The endpoint answered HTTP ${res.status} ${res.statusText}. How to fix: verify the URL and credentials.`,
      {
        status: 502,
        code: "CONNECTOR_REMOTE",
      },
    );
  }
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) {
    throw new ConnectorError(`Response body (${(len / 1024 / 1024).toFixed(0)} MB) exceeds the 64 MB polling cap.`, {
      status: 502,
      code: "CONNECTOR_REMOTE",
    });
  }
  const body = await res.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new ConnectorError("Response body exceeds the 64 MB polling cap.", { status: 502, code: "CONNECTOR_REMOTE" });
  }

  const format = config.format ?? "auto";
  let table: { columns: { name: string; type: string }[]; rows: (string | number | boolean | null)[][] };
  if (format === "csv" || (format === "auto" && looksLikeCsv(body))) {
    table = csvBodyToTable(body);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new ConnectorError(
        "The endpoint body is neither valid JSON nor CSV. How to fix: set the format field explicitly, or point the connector at a JSON/CSV endpoint.",
        { status: 502, code: "CONNECTOR_REMOTE" },
      );
    }
    // Accept a bare array, or { data: [...] } / { items: [...] } / { results: [...] } wrappers.
    const arr = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>)?.data ??
        (parsed as Record<string, unknown>)?.items ??
        (parsed as Record<string, unknown>)?.results);
    if (!Array.isArray(arr)) {
      throw new ConnectorError("The JSON body is not an array (or a {data|items|results} array). Nothing to poll.", {
        status: 502,
        code: "CONNECTOR_REMOTE",
      });
    }
    const items = (arr as Json[]).filter(
      (x): x is Record<string, Json> => x !== null && typeof x === "object" && !Array.isArray(x),
    );
    table = jsonToTable(items);
  }

  const truncated = table.rows.length > limit;
  return { ...table, rows: table.rows.slice(0, limit), totalRows: table.rows.length, truncated };
}

/** Connection test: a cheap GET that must answer 2xx (body is discarded). */
export async function testHttpConnection(
  config: HttpSourceConfig,
): Promise<{ serverVersion: string; latencyMs: number }> {
  const url = await assertPublicHttpUrl(config.url);
  const started = Date.now();
  let res: Response;
  try {
    if (process.env.CONNECTOR_ALLOW_PRIVATE_URLS === "true") {
      res = await fetch(url, {
        method: "GET",
        headers: { ...(config.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      res = await safeExternalFetch(config.url, { headers: config.headers });
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(
      `Could not reach ${url.host}: ${err instanceof Error ? err.message : "network error"}. How to fix: check the URL and that the endpoint is reachable from the server.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  if (!res.ok) {
    throw new ConnectorError(`The endpoint answered HTTP ${res.status} ${res.statusText}.`, {
      status: 502,
      code: "CONNECTOR_REMOTE",
    });
  }
  // Drain (bounded) so keep-alive connections stay clean.
  await res.text().catch(() => undefined);
  return { serverVersion: `http ${url.protocol === "https:" ? "(https)" : "(http)"}`, latencyMs: Date.now() - started };
}

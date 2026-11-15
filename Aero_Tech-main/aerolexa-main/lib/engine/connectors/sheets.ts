/**
 * Google Sheets connector — REAL read-only pulls (replaces the status surface).
 *
 * Transport: Google Sheets REST API v4 over HTTPS with OAuth2 minted from a
 * service-account JWT (lib/engine/connectors/jwt-auth.ts). No Google SDK — the
 * installed dependency set is enough (the same pattern the BigQuery connector
 * uses):
 *   1. The service-account JSON (from connector config) mints an access token
 *      scoped to `spreadsheets.readonly`.
 *   2. `spreadsheets.get` lists the sheet tabs (the "tables" the user browses).
 *   3. `values.get` with a whole-tab A1 range returns the grid; the first
 *      non-empty row is the header and every row below is data (pasted down
 *      exactly like the Sheets UI shows it — trailing blanks are honest nulls,
 *      never silently dropped).
 *
 * Honesty rules (mirrors every other connector): failures map to clean
 * "What happened / How to fix" messages that never echo credentials; results
 * carry real column types inferred from the grid; row caps truncate with an
 * explicit `truncated` flag and a true `totalRows`.
 *
 * Share model: the service account's email must be granted Viewer on the
 * spreadsheet (the test error tells the operator exactly that).
 */

import type { ColType } from "@/lib/types";

import type { SheetsConfig } from "./config";
import { ConnectorError } from "./errors";
import { googleServiceAccountAccessToken } from "./jwt-auth";

const QUERY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** Hard cap on cells pulled in one request (Sheets allows ~10M per spread). */
const MAX_CELLS = 2_000_000;
/** Column letters (A…ZZ) — wider sheets are rare and rejected with a remedy. */
const MAX_COLUMNS = 702;

/* ------------------------------------------------------------------ */
/* Token (cached in-process for its lifetime)                          */
/* ------------------------------------------------------------------ */

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Parse the stored credentials JSON string (validated at config time). */
function parseCredentials(credentialsJson: string): { client_email: string; private_key: string } {
  try {
    const parsed = JSON.parse(credentialsJson) as { client_email?: unknown; private_key?: unknown };
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
      throw new Error("missing fields");
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch {
    throw new ConnectorError(
      "The Google Sheets credentials JSON is invalid. What happened: the file does not contain client_email and private_key. How to fix: paste the full service-account key JSON from Google Cloud (IAM → Service Accounts → Keys), then save again.",
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
}

async function sheetsAccessToken(privateKey: string, clientEmail: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const { token, expiresInSeconds } = await googleServiceAccountAccessToken(
    { client_email: clientEmail, private_key: privateKey },
    SHEETS_SCOPE,
  );
  cachedToken = { token, expiresAt: Date.now() + expiresInSeconds * 1000 };
  return token;
}

/* ------------------------------------------------------------------ */
/* Fetch plumbing                                                      */
/* ------------------------------------------------------------------ */

async function sheetsFetch<T>(config: SheetsConfig, path: string, params: Record<string, string> = {}): Promise<T> {
  const creds = parseCredentials(config.credentialsJson);
  const token = await sheetsAccessToken(creds.private_key, creds.client_email);
  const url = new URL(`${API_BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        `The Google Sheets request timed out (${path}). How to fix: retry; a sheet with millions of cells can take a while on the first pull.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      "Could not reach sheets.googleapis.com. What happened: a network or DNS failure. How to fix: confirm the server has outbound HTTPS access, then retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  if (res.status === 401) {
    throw new ConnectorError(
      "Google rejected the service-account token. What happened: the private key or client email is wrong, or the key was revoked. How to fix: paste fresh service-account JSON (Google Cloud → IAM → Service Accounts → Keys), then save and test again.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = body.error?.message ?? "";
    if (/PERMISSION_DENIED|The caller does not have permission/i.test(msg)) {
      throw new ConnectorError(
        "Google Sheets denied access (PERMISSION_DENIED). What happened: the spreadsheet is not shared with the service account. How to fix: open the sheet → Share → add the service account's client_email as a Viewer, then retry.",
        { status: 403, code: "CONNECTOR_PERMISSION" },
      );
    }
    if (/RATE_LIMIT|quota|429/i.test(msg) || res.headers.get("retry-after")) {
      throw new ConnectorError(
        "Google Sheets rate limit hit. What happened: too many requests in a short window. How to fix: retry in ~30 seconds; scheduled syncs stay well under the read quota.",
        { status: 429, code: "CONNECTOR_REMOTE" },
      );
    }
    throw new ConnectorError(
      `Google Sheets denied the request. What happened: ${msg.slice(0, 200) || `HTTP 403`}. How to fix: confirm the Sheets API is enabled for the service account's project, then retry.`,
      { status: 403, code: "CONNECTOR_PERMISSION" },
    );
  }
  if (res.status === 404) {
    throw new ConnectorError(
      "The spreadsheet was not found. What happened: the ID does not exist or the service account cannot see it. How to fix: copy the ID from the sheet URL (…/d/<ID>/edit) and share the sheet with the service account as Viewer.",
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ConnectorError(
      `The Google Sheets API answered HTTP ${res.status}. What happened: ${body.error?.message?.slice(0, 200) ?? "unexpected error"}. How to fix: retry; if it persists check status.cloud.google.com.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (data === null) {
    throw new ConnectorError("The Google Sheets API returned a non-JSON response. How to fix: retry.", {
      status: 502,
      code: "CONNECTOR_REMOTE",
    });
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Connection test                                                     */
/* ------------------------------------------------------------------ */

interface SheetsMeta {
  properties?: { title?: string };
  sheets?: { properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
}

export async function testSheetsConnection(
  config: SheetsConfig,
): Promise<{ serverVersion: string; latencyMs: number; database: string }> {
  const started = Date.now();
  const meta = await sheetsFetch<SheetsMeta>(config, `/${config.spreadsheetId}`, { fields: "properties.title" });
  return {
    serverVersion: "Google Sheets API v4",
    latencyMs: Date.now() - started,
    database: meta.properties?.title ?? config.spreadsheetId,
  };
}

/* ------------------------------------------------------------------ */
/* Table (tab) listing                                                 */
/* ------------------------------------------------------------------ */

export interface SheetsTable {
  schema: string;
  name: string;
  columns: { name: string; dataType: string; nullable: boolean }[];
}

/**
 * List the spreadsheet's tabs. Column metadata comes from `values.get` of the
 * first rows (real headers), so the schema browser shows actual columns —
 * bounded to 2 metadata rows per tab to keep listing cheap.
 */
export async function listSheetsTables(config: SheetsConfig): Promise<SheetsTable[]> {
  const meta = await sheetsFetch<SheetsMeta>(config, `/${config.spreadsheetId}`, {
    fields: "sheets.properties.title",
  });
  const tabs = (meta.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => !!t && t.trim() !== "");
  if (tabs.length === 0) {
    throw new ConnectorError(
      "The spreadsheet has no visible tabs. How to fix: unhide the tabs you want to import, then refresh the schema browser.",
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }

  const tables: SheetsTable[] = [];
  for (const tab of tabs) {
    let columns: SheetsTable["columns"] = [];
    try {
      const preview = await fetchTabGrid(config, tab, 2);
      columns = headerColumnsFromRows(preview.rows);
    } catch {
      // A tab may be hidden/empty — list it with no columns rather than failing
      // the whole browse; the pull path reports the real error when chosen.
      columns = [];
    }
    tables.push({ schema: "", name: tab, columns });
  }
  return tables;
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

interface GridValue {
  rows: (string | number | boolean | null)[][];
  header: string[];
}

/**
 * Read a whole tab (or a bounded prefix) as a grid of primitives.
 * `majorDimension=ROWS`, `valueRenderOption=UNFORMATTED_VALUE` (real numbers
 * and booleans, not locale strings) with FORMULA fallback handled by the API.
 */
async function fetchTabGrid(config: SheetsConfig, tab: string, rowLimit?: number): Promise<GridValue> {
  const safeTab = tab.replace(/'/g, "''");
  const range = rowLimit ? `'${safeTab}'!A1:ZZ${rowLimit}` : `'${safeTab}'`;
  const data = await sheetsFetch<{ values?: unknown[][] }>(
    config,
    `/${config.spreadsheetId}/values/${encodeURIComponent(range)}`,
    {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    },
  );

  const raw = data.values ?? [];
  if (raw.length === 0) {
    throw new ConnectorError(
      `The tab “${tab}” is empty. How to fix: choose a tab that contains a header row and data.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }

  // Cell-count guard (memory contract): header + data must stay under MAX_CELLS.
  const width = Math.min(
    MAX_COLUMNS,
    raw.reduce((max, row) => Math.max(max, (row as unknown[]).length), 0),
  );
  const approxCells = width * raw.length;
  if (approxCells > MAX_CELLS) {
    throw new ConnectorError(
      `The tab “${tab}” is larger than ${MAX_CELLS.toLocaleString()} cells (it has ≈${approxCells.toLocaleString()}). How to fix: export the tab as CSV and upload it, or split the sheet.`,
      { status: 413, code: "CONNECTOR_CONFIG" },
    );
  }

  const first = raw[0] as unknown[];
  const header = first.map((cell, i) => {
    const text = cell === null || cell === undefined ? "" : String(cell).trim();
    return text !== "" ? text : `Column ${i + 1}`;
  });

  const rows: (string | number | boolean | null)[][] = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r] as unknown[];
    const out: (string | number | boolean | null)[] = [];
    for (let c = 0; c < header.length; c++) {
      const v = row[c];
      out.push(cellToPrimitive(v));
    }
    rows.push(out);
  }
  return { rows, header };
}

/** Normalize one Sheets cell to the connector row primitive union. */
function cellToPrimitive(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Infer column shapes from the first data rows (real header + sampled types). */
export function headerColumnsFromRows(rows: (string | number | boolean | null)[][]): {
  name: string;
  dataType: string;
  nullable: boolean;
}[] {
  if (rows.length === 0 || rows[0]!.length === 0) return [];
  const header = rows[0]!.map((h, i) => {
    const text = h === null || h === undefined ? "" : String(h).trim();
    return text !== "" ? text : `Column ${i + 1}`;
  });
  const sample = rows.slice(1);
  return header.map((name, c) => {
    let type: string = "string";
    let sawValue = false;
    let allNum = true;
    let allBool = true;
    for (const row of sample.slice(0, 200)) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      sawValue = true;
      if (typeof v !== "number") allNum = false;
      if (typeof v !== "boolean") allBool = false;
    }
    if (!sawValue) type = "string";
    else if (allNum) type = "number";
    else if (allBool) type = "boolean";
    return { name, dataType: type, nullable: true };
  });
}

export const SHEETS_TABLES = ["<spreadsheet tabs>"] as const;

/**
 * Pull one tab as a PulledTable. First non-empty row = header; every following
 * row is data with trailing blanks preserved as nulls (honest paste-down).
 */
export async function fetchSheetsRows(
  config: SheetsConfig,
  tab: string,
  limit: number,
): Promise<{
  columns: { name: string; type: ColType }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  const grid = await fetchTabGrid(config, tab);
  const typedColumns = headerColumnsFromRows([grid.header, ...grid.rows.slice(0, 200)]).map((c) => ({
    name: c.name,
    type: (c.dataType === "number" ? "number" : c.dataType === "boolean" ? "boolean" : "string") as ColType,
  }));

  const totalRows = grid.rows.length;
  const capped = Math.min(totalRows, Math.max(1, Math.floor(limit)));
  const rows = grid.rows.slice(0, capped);
  return {
    columns: typedColumns,
    rows,
    totalRows,
    truncated: totalRows > capped,
  };
}

/** Exposed for tests — the A1 guard widths. */
export const SHEETS_LIMITS = { MAX_CELLS, MAX_COLUMNS, QUERY_TIMEOUT_MS, CONNECT_TIMEOUT_MS };

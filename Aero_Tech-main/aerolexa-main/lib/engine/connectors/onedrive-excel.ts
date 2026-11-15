/**
 * Excel via OneDrive/SharePoint connector (ROADMAP 1.3) — REAL read-only pulls.
 *
 * Transport: Microsoft Graph API v1.0 over HTTPS with an access token minted
 * per operation through the client-credentials flow (Azure AD tenant,
 * application client id + secret). No Microsoft SDK — the installed
 * dependency set is enough (the same pattern the Google Sheets connector
 * uses). The workbook is downloaded as binary and parsed with the `xlsx`
 * package — the SAME parser the upload pipeline uses, so column typing and
 * paste-down semantics are identical to a manual upload.
 *
 * Addressing:
 *  - sharepoint: GET /sites/{siteHost}:/drive + /sites/{siteHost}:/drive/root:{path}:/content
 *    (host-scoped path addressing — no site-id hunt needed for document libraries)
 *  - onedrive:   GET /me/drive/root:{path}:/content — requires delegated-ish
 *    app tokens with Files.Read.All on that user scope; the connection test
 *    surfaces Graph's error verbatim-classified when the app lacks rights.
 *
 * Honesty rules (mirrors every other connector): failures map to clean
 * "What happened / How to fix" messages that never echo the client secret;
 * row caps truncate with an explicit `truncated` flag and a true `totalRows`.
 */

import * as XLSX from "xlsx";

import type { ColType } from "@/lib/types";

import type { OneDriveExcelConfig } from "./config";
import { ConnectorError } from "./errors";

const TOKEN_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Hard cap: a workbook bigger than this is an explicit error, not an OOM. */
const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Token (client credentials, cached for its lifetime)                 */
/* ------------------------------------------------------------------ */

interface TokenCache {
  key: string;
  token: string;
  expiresAt: number;
}
let cached: TokenCache | null = null;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function graphAccessToken(config: OneDriveExcelConfig): Promise<string> {
  const key = `${config.tenantId}:${config.clientId}`;
  if (cached && cached.key === key && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    // Files.Read.All covers OneDrive; Sites.Read.All covers SharePoint —
    // one broad-but-read-only scope works for both addressing modes.
    scope: "https://graph.microsoft.com/.default",
  });

  let res: Response;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ConnectorError(
      `Could not reach the Microsoft identity token endpoint. What happened: ${
        err instanceof Error ? err.message : "network failure"
      }. How to fix: confirm the server has outbound HTTPS access to login.microsoftonline.com, then retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    if (/AADSTS700016|Invalid client|invalid_client/i.test(detail)) {
      throw new ConnectorError(
        "Microsoft rejected the application (client) id. What happened: the client id is wrong or the app is not in this tenant. How to fix: copy the Application (client) ID from Azure AD → App registrations → Overview, then save and test again.",
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    }
    if (/AADSTS7000215|Invalid client secret/i.test(detail)) {
      throw new ConnectorError(
        "Microsoft rejected the client secret. What happened: the secret is wrong or expired. How to fix: create a new client secret (Azure AD → App registrations → Certificates & secrets), save it in the connector settings, then test again.",
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    }
    if (/AADSTS7000(30|33)/i.test(detail)) {
      throw new ConnectorError(
        "The Microsoft app has no admin-consented application permissions. What happened: Files.Read.All / Sites.Read.All are configured but not granted. How to fix: an admin grants the app permissions under Azure AD → App registrations → API permissions → Grant admin consent, then test again.",
        { status: 403, code: "CONNECTOR_PERMISSION" },
      );
    }
    throw new ConnectorError(
      `Microsoft token request failed. What happened: ${detail.slice(0, 200)}. How to fix: verify tenantId/clientId/clientSecret, then save and test again.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }

  cached = { key, token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

/* ------------------------------------------------------------------ */
/* Graph download plumbing                                             */
/* ------------------------------------------------------------------ */

/** URL-encode a drive path segment but keep the `:` path-addressing colon. */
function encodeDrivePath(p: string): string {
  const cleaned = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function graphDownload(config: OneDriveExcelConfig, path: string): Promise<Buffer> {
  const token = await graphAccessToken(config);
  const url =
    config.source === "sharepoint"
      ? `${GRAPH_BASE}/sites/${encodeURIComponent(config.siteHost)}:/drive/root:/${encodeDrivePath(path)}:/content`
      : `${GRAPH_BASE}/me/drive/root:/${encodeDrivePath(path)}:/content`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        `The Microsoft Graph download timed out (${path}). How to fix: retry; a very large workbook can exceed the 60s budget.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      "Could not reach graph.microsoft.com. What happened: a network or DNS failure. How to fix: confirm the server has outbound HTTPS access, then retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  if (res.status === 401) {
    throw new ConnectorError(
      "Microsoft rejected the Graph access token. What happened: the tenant/client credentials are wrong or the secret was rotated. How to fix: re-enter the client secret, save, and test again.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 403) {
    throw new ConnectorError(
      "Microsoft Graph denied the download (HTTP 403). What happened: the app lacks Files.Read.All / Sites.Read.All application permission or admin consent. How to fix: grant the permissions with admin consent in Azure AD, then test again.",
      { status: 403, code: "CONNECTOR_PERMISSION" },
    );
  }
  if (res.status === 404) {
    throw new ConnectorError(
      `The workbook was not found at “${path}”. What happened: the path does not exist, or the app cannot see that library. How to fix: copy the server-relative path from SharePoint (…/sites/<site>/…/file.xlsx) and check the app's access, then retry.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")) || "";
    throw new ConnectorError(
      `Microsoft Graph answered HTTP ${res.status}. What happened: ${body.slice(0, 200) || "unexpected error"}. How to fix: retry; if it persists check the Microsoft 365 service health dashboard.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new ConnectorError(
      `The workbook at “${path}” downloaded as an empty file. How to fix: open the file once in Excel/SharePoint to confirm it saves, then retry.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  if (buf.byteLength > MAX_WORKBOOK_BYTES) {
    throw new ConnectorError(
      `The workbook is ${Math.round(buf.byteLength / 1024 / 1024)}MB — larger than the ${MAX_WORKBOOK_BYTES / 1024 / 1024}MB limit. How to fix: export the needed sheet as CSV and upload it, or split the workbook.`,
      { status: 413, code: "CONNECTOR_CONFIG" },
    );
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* Workbook parsing (the SAME xlsx path as file uploads)               */
/* ------------------------------------------------------------------ */

interface SheetGrid {
  header: string[];
  rows: (string | number | boolean | null)[][];
}

/** Parse the downloaded workbook; pick the requested or first visible sheet. */
export function parseWorkbook(buf: Buffer, worksheet: string): SheetGrid {
  const workbook = XLSX.read(buf, { type: "buffer", cellDates: true });
  if (workbook.SheetNames.length === 0) {
    throw new ConnectorError(
      "The workbook has no sheets. How to fix: save the file from Excel with at least one worksheet, then retry.",
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  const name =
    worksheet.trim() !== "" && workbook.SheetNames.includes(worksheet.trim())
      ? worksheet.trim()
      : workbook.SheetNames[0]!;
  if (worksheet.trim() !== "" && name !== worksheet.trim()) {
    throw new ConnectorError(
      `The workbook has no worksheet “${worksheet}”. How to fix: pick one of the workbook's sheets (${workbook.SheetNames.slice(0, 5).join(", ")}${workbook.SheetNames.length > 5 ? "…" : ""}), then retry.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  const sheet = workbook.Sheets[name];
  if (!sheet) {
    throw new ConnectorError(
      `The worksheet “${name}” could not be read. How to fix: re-save the workbook, then retry.`,
      {
        status: 400,
        code: "CONNECTOR_CONFIG",
      },
    );
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false, raw: true });
  if (matrix.length === 0) {
    throw new ConnectorError(
      `The worksheet “${name}” is empty. How to fix: choose a sheet that contains a header row and data, then retry.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }

  const headerRow = matrix[0] ?? [];
  const header = headerRow.map((h, i) => {
    const text = h === null || h === undefined ? "" : String(h).trim();
    return text !== "" ? text : `Column ${i + 1}`;
  });

  const rows: (string | number | boolean | null)[][] = [];
  for (let r = 1; r < matrix.length; r++) {
    const raw = matrix[r] ?? [];
    const out: (string | number | boolean | null)[] = [];
    for (let c = 0; c < header.length; c++) {
      out.push(cellToPrimitive(raw[c]));
    }
    rows.push(out);
  }
  return { header, rows };
}

/** Normalize one xlsx cell to the connector row primitive union. */
function cellToPrimitive(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Infer column shapes from the header + first data rows (same rule as Sheets). */
export function excelColumnsFromGrid(grid: SheetGrid): { name: string; type: ColType }[] {
  const sample = grid.rows.slice(0, 200);
  return grid.header.map((name, c) => {
    let sawValue = false;
    let allNum = true;
    let allBool = true;
    for (const row of sample) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      sawValue = true;
      if (typeof v !== "number") allNum = false;
      if (typeof v !== "boolean") allBool = false;
    }
    if (!sawValue) return { name, type: "string" as ColType };
    if (allNum) return { name, type: "number" as ColType };
    if (allBool) return { name, type: "boolean" as ColType };
    return { name, type: "string" as ColType };
  });
}

/* ------------------------------------------------------------------ */
/* Public connector API                                                */
/* ------------------------------------------------------------------ */

export async function testOneDriveExcelConnection(
  config: OneDriveExcelConfig,
): Promise<{ serverVersion: string; latencyMs: number; database: string }> {
  const started = Date.now();
  const buf = await graphDownload(config, config.filePath);
  const grid = parseWorkbook(buf, config.worksheet);
  return {
    serverVersion: "Microsoft Graph v1.0",
    latencyMs: Date.now() - started,
    database: `${config.filePath} · sheet “${grid.header.length} col”`,
  };
}

/** One workbook = one table; the sheet is the table the pull targets. */
export const ONEDRIVE_EXCEL_TABLES = ["workbook"] as const;

export async function fetchOneDriveExcelRows(
  config: OneDriveExcelConfig,
  limit: number,
): Promise<{
  columns: { name: string; type: ColType }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  const buf = await graphDownload(config, config.filePath);
  const grid = parseWorkbook(buf, config.worksheet);
  const columns = excelColumnsFromGrid(grid);
  const totalRows = grid.rows.length;
  const capped = Math.min(totalRows, Math.max(1, Math.floor(limit)));
  return {
    columns,
    rows: grid.rows.slice(0, capped),
    totalRows,
    truncated: totalRows > capped,
  };
}

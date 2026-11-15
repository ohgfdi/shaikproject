/**
 * Xero connector — read-only pulls through the Accounting API v2.
 *
 * Auth model (documented by Xero):
 *  1. The firm creates an app at developer.xero.com and authorises it once with
 *     the `offline_access accounting.transactions.read accounting.contacts.read`
 *     scopes. That yields a refresh token bound to a tenant.
 *  2. Each operation exchanges the refresh token for a short-lived access token.
 *     Access tokens are never stored; only the refresh token is, encrypted at
 *     rest like every other credential.
 *  3. Xero rotates the refresh token on every exchange — the old one is
 *     invalidated. The caller therefore receives the rotated value through
 *     `onRefreshToken` and must persist it, or the next sync authenticates with
 *     a dead token. When no callback is supplied the rotation cannot be stored
 *     and this connector says so rather than pretending the connection is
 *     durable.
 */

import type { XeroConfig } from "./config";
import { ConnectorError } from "./errors";

const IDENTITY_URL = "https://identity.xero.com/connect/token";
const API_BASE = "https://api.xero.com/api.xro/2.0";
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const MAX_PAGE_SIZE = 1000;

export const XERO_TABLES = ["invoices", "contacts", "payments"] as const;
export type XeroTable = (typeof XERO_TABLES)[number];

export interface XeroTableColumn {
  name: string;
  type: "string" | "number" | "boolean" | "date";
}

export function xeroTableColumns(table: string): XeroTableColumn[] {
  switch (table) {
    case "invoices":
      return [
        { name: "InvoiceID", type: "string" },
        { name: "InvoiceNumber", type: "string" },
        { name: "Type", type: "string" },
        { name: "Status", type: "string" },
        { name: "ContactName", type: "string" },
        { name: "Date", type: "date" },
        { name: "DueDate", type: "date" },
        { name: "Total", type: "number" },
        { name: "AmountDue", type: "number" },
        { name: "AmountPaid", type: "number" },
        { name: "CurrencyCode", type: "string" },
        { name: "Reference", type: "string" },
      ];
    case "contacts":
      return [
        { name: "ContactID", type: "string" },
        { name: "Name", type: "string" },
        { name: "EmailAddress", type: "string" },
        { name: "IsCustomer", type: "boolean" },
        { name: "IsSupplier", type: "boolean" },
        { name: "Status", type: "string" },
      ];
    case "payments":
      return [
        { name: "PaymentID", type: "string" },
        { name: "InvoiceNumber", type: "string" },
        { name: "ContactName", type: "string" },
        { name: "Date", type: "date" },
        { name: "Amount", type: "number" },
        { name: "Status", type: "string" },
        { name: "Reference", type: "string" },
      ];
    default:
      return [];
  }
}

export function xeroTables(): { schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }[] {
  return XERO_TABLES.map((name) => ({
    schema: "",
    name,
    columns: xeroTableColumns(name).map((c) => ({ name: c.name, dataType: c.type, nullable: true })),
  }));
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export interface XeroTokenResult {
  accessToken: string;
  refreshToken: string | null;
}

/** Exchange the refresh token for a short-lived access token. */
export async function fetchXeroAccessToken(config: XeroConfig): Promise<XeroTokenResult> {
  let res: Response;
  try {
    res = await fetch(IDENTITY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        "The Xero identity server did not answer in time. What happened: token refresh timed out. How to fix: check network access to identity.xero.com and retry.",
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      "Could not reach the Xero identity server. What happened: the token endpoint is unreachable. How to fix: check outbound HTTPS access to identity.xero.com and retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; error?: string; error_description?: string }
    | null;

  if (body?.access_token) {
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null };
  }

  const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
  if (res.status === 400 || res.status === 401) {
    throw new ConnectorError(
      `Xero rejected the credentials (${reason}). What happened: the refresh token is expired, already used, or was issued to a different app. How to fix: re-authorise the app in Xero and paste the new refresh token.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError(
      "Xero is rate-limiting token requests. What happened: too many token exchanges in a short window. How to fix: wait a minute and retry; do not run concurrent syncs against one connection.",
      { status: 429, code: "CONNECTOR_RATE_LIMIT" },
    );
  }
  throw new ConnectorError(
    `The Xero identity server answered HTTP ${res.status}${reason ? ` (${reason})` : ""}. What happened: no access token was issued. How to fix: retry; if it persists, check status.xero.com.`,
    { status: 502, code: "CONNECTOR_REMOTE" },
  );
}

/* ------------------------------------------------------------------ */
/* API plumbing                                                        */
/* ------------------------------------------------------------------ */

async function xeroGet<T>(
  config: XeroConfig,
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${API_BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": config.tenantId,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        "Xero did not answer in time. What happened: the Accounting API request timed out. How to fix: retry, or pull a smaller page.",
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      "Could not reach the Xero Accounting API. What happened: the request failed before a response. How to fix: check outbound HTTPS access and retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  if (res.ok) return (await res.json()) as T;

  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  if (res.status === 401) {
    throw new ConnectorError(
      "Xero rejected the access token. What happened: the token expired or the tenant does not match. How to fix: re-authorise the connection and retry.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 403) {
    throw new ConnectorError(
      "The Xero app is not authorised for this organisation or scope. What happened: the tenant id or granted scopes are wrong. How to fix: re-authorise with the accounting read scopes and the correct tenant.",
      { status: 403, code: "CONNECTOR_PERMISSION" },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError(
      "Xero is rate-limiting this connection. What happened: the API quota was exhausted. How to fix: wait for the Retry-After window and sync again.",
      { status: 429, code: "CONNECTOR_RATE_LIMIT" },
    );
  }
  throw new ConnectorError(
    `Xero returned HTTP ${res.status}${text ? `: ${text}` : ""}. What happened: the Accounting API rejected the request. How to fix: verify the connection and retry.`,
    { status: res.status >= 500 ? 502 : 400, code: "CONNECTOR_REMOTE" },
  );
}

export interface XeroPullOptions {
  /** Persist a rotated refresh token. Xero invalidates the previous one. */
  onRefreshToken?: (refreshToken: string) => Promise<void> | void;
}

/** Live connection test: read the authorised organisation's name. */
export async function testXeroConnection(
  config: XeroConfig,
  opts: XeroPullOptions = {},
): Promise<{ serverVersion: string; latencyMs: number }> {
  const started = Date.now();
  const token = await fetchXeroAccessToken(config);
  if (token.refreshToken && opts.onRefreshToken) await opts.onRefreshToken(token.refreshToken);
  const body = await xeroGet<{ Organisations?: { Name?: string; LegalName?: string }[] }>(
    config,
    "Organisation",
    token.accessToken,
  );
  const org = body.Organisations?.[0];
  if (!org) {
    throw new ConnectorError(
      "Xero returned no organisation for this tenant. What happened: the tenant id is wrong or the app is not connected to a Xero organisation. How to fix: reconnect the app and copy the tenant id shown after authorisation.",
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  return {
    serverVersion: `Xero ${org.Name ?? org.LegalName ?? "organisation"}`,
    latencyMs: Date.now() - started,
  };
}

type XeroRawInvoice = {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Contact?: { Name?: string };
  Date?: string;
  DueDate?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  CurrencyCode?: string;
  Reference?: string;
};

type XeroRawContact = {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  ContactStatus?: string;
};

type XeroRawPayment = {
  PaymentID?: string;
  Invoice?: { InvoiceNumber?: string; Contact?: { Name?: string } };
  Date?: string;
  Amount?: number;
  Status?: string;
  Reference?: string;
};

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : value == null ? null : Number(value);
}

/** Pull one table (paged), returning the same shape as every other connector. */
export async function fetchXeroRows(
  config: XeroConfig,
  table: string,
  limit: number,
  opts: XeroPullOptions = {},
): Promise<{
  columns: { name: string; type: "string" | "number" | "boolean" | "date" }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  if (!(XERO_TABLES as readonly string[]).includes(table)) {
    throw new ConnectorError(
      `“${table}” is not a Xero table this connector exposes. How to fix: choose invoices, contacts or payments.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }

  const token = await fetchXeroAccessToken(config);
  if (token.refreshToken && opts.onRefreshToken) await opts.onRefreshToken(token.refreshToken);

  const columns = xeroTableColumns(table);
  const rows: (string | number | boolean | null)[][] = [];
  let totalRows = 0;
  let page = 1;
  const pageSize = Math.min(Math.max(Math.floor(limit), 1), MAX_PAGE_SIZE);

  while (rows.length < limit) {
    const body = await xeroGet<{
      Invoices?: XeroRawInvoice[];
      Contacts?: XeroRawContact[];
      Payments?: XeroRawPayment[];
    }>(config, table, token.accessToken, { page: String(page), pageSize: String(pageSize) });

    const batch =
      table === "invoices"
        ? (body.Invoices ?? [])
        : table === "contacts"
          ? (body.Contacts ?? [])
          : (body.Payments ?? []);
    if (batch.length === 0) break;

    for (const item of batch) {
      if (rows.length >= limit) break;
      if (table === "invoices") {
        const inv = item as XeroRawInvoice;
        rows.push([
          inv.InvoiceID ?? null,
          inv.InvoiceNumber ?? null,
          inv.Type ?? null,
          inv.Status ?? null,
          inv.Contact?.Name ?? null,
          inv.Date ?? null,
          inv.DueDate ?? null,
          toNumber(inv.Total),
          toNumber(inv.AmountDue),
          toNumber(inv.AmountPaid),
          inv.CurrencyCode ?? null,
          inv.Reference ?? null,
        ]);
      } else if (table === "contacts") {
        const c = item as XeroRawContact;
        rows.push([
          c.ContactID ?? null,
          c.Name ?? null,
          c.EmailAddress ?? null,
          c.IsCustomer ?? null,
          c.IsSupplier ?? null,
          c.ContactStatus ?? null,
        ]);
      } else {
        const p = item as XeroRawPayment;
        rows.push([
          p.PaymentID ?? null,
          p.Invoice?.InvoiceNumber ?? null,
          p.Invoice?.Contact?.Name ?? null,
          p.Date ?? null,
          toNumber(p.Amount),
          p.Status ?? null,
          p.Reference ?? null,
        ]);
      }
    }

    totalRows += batch.length;
    if (batch.length < pageSize) break;
    page += 1;
    // The API caps paging at 100 pages; stop rather than loop forever.
    if (page > 100) break;
  }

  return {
    columns,
    rows,
    totalRows: Math.max(totalRows, rows.length),
    truncated: rows.length >= limit,
  };
}

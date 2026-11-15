/**
 * Zoho Books connector — read-only pulls through the Books API v3.
 *
 * Zoho Books is the accounting system of record for a large share of Indian
 * SMBs, so this connector is first-class here, on par with PostgreSQL:
 * connect / test / browse / import / sync all go through the same dispatcher
 * shapes as the warehouse connectors.
 *
 * Auth model (developer "self-client" flow, documented by Zoho):
 *  1. The user creates a self client at api-console.zoho.com and mints a
 *     refresh token with a read-only Books scope (ZohoBooks.fullaccess.read
 *     or ZohoBooks.invoices.READ etc.).
 *  2. The connector exchanges that refresh token for a short-lived access
 *     token per operation. Access tokens are NEVER stored — only the
 *     refresh token is, encrypted at rest like every other credential.
 *
 * Regional data centers matter: an Indian Zoho account lives on
 * accounts.zoho.in / www.zohoapis.in, and credentials from one DC do not
 * work against another, so the region is part of the config.
 */

import type { ZohoBooksConfig } from "./config";
import { ConnectorError } from "./errors";
import { ZOHO_BOOKS_REGION_META, type ZohoRegionMeta } from "./zoho-regions";

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

interface ZohoHosts {
  accounts: string;
  api: string;
  label: string;
}

/**
 * Resolve the data center this connection targets. A region outside the eight
 * supported centers fails loudly with the supported list — it must never
 * silently use India's hosts for a token minted somewhere else.
 */
function zohoHosts(region: string): ZohoHosts {
  const meta = (ZOHO_BOOKS_REGION_META as Record<string, ZohoRegionMeta | undefined>)[region];
  if (!meta) {
    const supported = Object.values(ZOHO_BOOKS_REGION_META)
      .map((entry) => `“${entry.value}” (${entry.name})`)
      .join(", ");
    throw new ConnectorError(
      `Unknown Zoho Books data center “${region}”. What happened: this connection is configured for a region the connector does not support. How to fix: choose one of ${supported} in the connection settings, then save again.`,
      { status: 400, code: "CONNECTOR_CONFIG" },
    );
  }
  return { accounts: meta.accountsHost, api: meta.apiHost, label: meta.name };
}

/** Tables this connector exposes (headers-level rows; line items stay nested). */
export const ZOHO_BOOKS_TABLES = ["invoices", "contacts", "expenses", "journals"] as const;
export type ZohoBooksTable = (typeof ZOHO_BOOKS_TABLES)[number];

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/** Exchange the refresh token for a short-lived access token (never stored). */
export async function fetchZohoAccessToken(config: ZohoBooksConfig): Promise<string> {
  const hosts = zohoHosts(config.region);
  let res: Response;
  try {
    res = await fetch(`https://${hosts.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        "The Zoho accounts server did not answer in time. What happened: token refresh timed out. How to fix: check network access to the Zoho data center and retry.",
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      "Could not reach the Zoho accounts server. What happened: the token endpoint is unreachable. How to fix: check network/DNS access from this server and retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
  if (body?.access_token) return body.access_token;

  const reason = body?.error ?? `HTTP ${res.status}`;
  // Explicit Zoho OAuth rejections are credentials problems.
  if (reason === "invalid_code" || reason === "invalid_client" || reason === "invalid_client_secret") {
    throw new ConnectorError(
      `Zoho rejected the credentials (${reason}). What happened: the client ID/secret or refresh token is wrong, expired, or was minted for a different data center. How to fix: regenerate the refresh token in api-console.zoho.com for region “${hosts.label}”, then save again.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status >= 400 && res.status < 500) {
    throw new ConnectorError(
      `The Zoho token endpoint rejected the request (HTTP ${res.status}). What happened: the access token could not be minted. How to fix: verify the refresh token and client credentials, then retry.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  // 5xx / unexpected responses are upstream problems, not credential
  // problems — never tell the user their token is wrong because a proxy or
  // load balancer answered with garbage.
  throw new ConnectorError(
    `The Zoho accounts server answered HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}. What happened: the token endpoint did not return an access token. How to fix: retry; if it persists, check status.zoho.com for incidents.`,
    { status: 502, code: "CONNECTOR_REMOTE" },
  );
}

/* ------------------------------------------------------------------ */
/* API plumbing                                                        */
/* ------------------------------------------------------------------ */

type ZohoBooksApiResult<T> = { data: T; totalMatched: number };

/**
 * One authenticated GET against the Books API v3. Resolves the organization
 * automatically (first org on the account) when the config leaves it blank.
 */
async function zohoBooksGet<T>(
  config: ZohoBooksConfig,
  path: string,
  params: Record<string, string> = {},
): Promise<ZohoBooksApiResult<T>> {
  const token = await fetchZohoAccessToken(config);
  const hosts = zohoHosts(config.region);

  let organizationId = config.organizationId.trim();
  if (!organizationId) {
    const orgs = await listZohoOrganizations(config, token);
    const first = orgs[0];
    if (!first?.organization_id) {
      throw new ConnectorError(
        "The Zoho account has no Books organization. What happened: organizations list is empty. How to fix: create a Books organization in Zoho, or paste its Organization ID in the connection settings.",
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    }
    organizationId = first.organization_id;
  }

  const url = new URL(`https://${hosts.api}/books/v3/${path.replace(/^\//, "")}`);
  url.searchParams.set("organization_id", organizationId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        `The Zoho Books ${path} request timed out. How to fix: retry, or import a narrower table.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      `Could not reach the Zoho Books API (${hosts.api}). What happened: the endpoint is unreachable. How to fix: check network access from this server and retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  const body = (await res.json().catch(() => null)) as (T & { code?: number; message?: string }) | null;

  if (!res.ok || !body || typeof body.code !== "number" || body.code !== 0) {
    const zohoMessage = body?.message ?? `HTTP ${res.status}`;
    const zohoCode = body?.code;
    if (res.status === 401 || zohoCode === 57 || zohoCode === 48) {
      throw new ConnectorError(
        `Zoho Books rejected the request (${zohoMessage}). What happened: the access token was invalid or the scope is missing. How to fix: re-mint the refresh token with the read-only Books scope and save again.`,
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    }
    if (res.status === 404) {
      throw new ConnectorError(
        `The Zoho Books organization was not found (${zohoMessage}). What happened: the Organization ID in this connection does not exist on this account. How to fix: copy the correct ID from Zoho Books → Settings → Organization, then save again.`,
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    }
    throw new ConnectorError(
      `The Zoho Books request failed: ${zohoMessage}. How to fix: verify the organization ID and the table you are importing, then retry.`,
      { status: res.status >= 500 ? 502 : 400, code: "CONNECTOR_ERROR" },
    );
  }
  return { data: body, totalMatched: 0 };
}

interface ZohoOrganization {
  organization_id: string;
  name: string;
}

async function listZohoOrganizations(config: ZohoBooksConfig, token: string): Promise<ZohoOrganization[]> {
  const hosts = zohoHosts(config.region);
  const res = await fetch(`https://${hosts.api}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  }).catch(() => {
    throw new ConnectorError(
      "Could not reach the Zoho Books API to resolve the organization. How to fix: check network access from this server and retry.",
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  });
  const body = (await res.json().catch(() => null)) as {
    code?: number;
    organizations?: ZohoOrganization[];
    message?: string;
  } | null;
  if (!res.ok || !body || body.code !== 0 || !Array.isArray(body.organizations)) {
    throw new ConnectorError(
      `Zoho Books did not return the organizations list (${body?.message ?? `HTTP ${res.status}`}). How to fix: verify the credentials and retry.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  return body.organizations;
}

/* ------------------------------------------------------------------ */
/* Connection test                                                     */
/* ------------------------------------------------------------------ */

export async function testZohoBooksConnection(
  config: ZohoBooksConfig,
): Promise<{ serverVersion: string; latencyMs: number; database: string }> {
  const started = Date.now();
  const token = await fetchZohoAccessToken(config);
  const hosts = zohoHosts(config.region);

  let orgs: ZohoOrganization[];
  try {
    orgs = await listZohoOrganizations(config, token);
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError("The Zoho Books connection test failed. How to fix: verify the credentials and retry.", {
      status: 502,
      code: "CONNECTOR_UNREACHABLE",
    });
  }
  const wanted = config.organizationId.trim();
  const org = wanted ? orgs.find((o) => o.organization_id === wanted) : orgs[0];
  if (!org) {
    throw new ConnectorError(
      `The Organization ID “${wanted}” was not found on this Zoho account. What happened: the ID does not match any organization the token can read. How to fix: copy the ID from Zoho Books → Settings → Organization, then save again.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  return {
    serverVersion: `Zoho Books (${hosts.label})`,
    latencyMs: Date.now() - started,
    database: org.name,
  };
}

/* ------------------------------------------------------------------ */
/* Table pulls                                                         */
/* ------------------------------------------------------------------ */

export interface ZohoColumn {
  name: string;
  type: "string" | "number" | "date";
}

const TABLE_COLUMNS: Record<ZohoBooksTable, ZohoColumn[]> = {
  invoices: [
    { name: "invoice_number", type: "string" },
    { name: "reference_number", type: "string" },
    { name: "date", type: "date" },
    { name: "due_date", type: "date" },
    { name: "status", type: "string" },
    { name: "customer_name", type: "string" },
    { name: "total", type: "number" },
    { name: "balance", type: "number" },
    { name: "currency_code", type: "string" },
    { name: "gst_treatment", type: "string" },
    { name: "place_of_supply", type: "string" },
  ],
  contacts: [
    { name: "contact_name", type: "string" },
    { name: "company_name", type: "string" },
    { name: "contact_type", type: "string" },
    { name: "status", type: "string" },
    { name: "currency_code", type: "string" },
    { name: "outstanding_receivable_amount", type: "number" },
    { name: "outstanding_payable_amount", type: "number" },
  ],
  expenses: [
    { name: "date", type: "date" },
    { name: "account_name", type: "string" },
    { name: "vendor_name", type: "string" },
    { name: "reference_number", type: "string" },
    { name: "description", type: "string" },
    { name: "total", type: "number" },
    { name: "tax_amount", type: "number" },
    { name: "status", type: "string" },
  ],
  journals: [
    { name: "journal_number", type: "string" },
    { name: "date", type: "date" },
    { name: "reference_number", type: "string" },
    { name: "notes", type: "string" },
    { name: "currency_code", type: "string" },
    { name: "total", type: "number" },
  ],
};

export function zohoBooksTableColumns(table: string): ZohoColumn[] {
  return TABLE_COLUMNS[table as ZohoBooksTable] ?? [];
}

/** Read a field as a finite number (Zoho sends numbers or numeric strings). */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Flatten one API record into the table's row tuple (column order). */
export function mapZohoRecord(table: ZohoBooksTable, record: Record<string, unknown>): (string | number | null)[] {
  return zohoBooksTableColumns(table).map((col) => {
    const raw = record[col.name];
    return col.type === "number" ? toNumber(raw) : toText(raw);
  });
}

const TABLE_PATH: Record<ZohoBooksTable, string> = {
  invoices: "invoices",
  contacts: "contacts",
  expenses: "expenses",
  journals: "journals",
};

/**
 * Pull up to `limit` rows of a Books table, following pagination until the
 * cap. Records arrive newest-first (Zoho's default `sort_column`), so an
 * import cut off by the row cap keeps the most recent entries.
 */
export async function fetchZohoBooksRows(
  config: ZohoBooksConfig,
  table: string,
  limit: number,
): Promise<{
  columns: { name: string; type: string }[];
  rows: (string | number | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  const zohoTable = table as ZohoBooksTable;
  if (!ZOHO_BOOKS_TABLES.includes(zohoTable)) {
    throw new ConnectorError(
      `Unknown Zoho Books table: ${table}. Use ${ZOHO_BOOKS_TABLES.map((t) => `“${t}”`).join(", ")}.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  const cap = Math.max(1, Math.floor(limit));
  const columns = zohoBooksTableColumns(zohoTable);

  const rows: (string | number | null)[][] = [];
  let page = 1;
  let hasMore = true;
  let totalMatched = 0;

  while (hasMore && rows.length < cap) {
    const perPage = Math.min(100, cap - rows.length);
    const result = await zohoBooksGet<Record<string, unknown>>(config, TABLE_PATH[zohoTable], {
      page: String(page),
      per_page: String(perPage),
    });
    const records = result.data[zohoTable];
    if (!Array.isArray(records)) {
      throw new ConnectorError(
        `The Zoho Books response for “${zohoTable}” had an unexpected shape. How to fix: retry; if it persists, check that the token's scope covers this module.`,
        { status: 502, code: "CONNECTOR_REMOTE" },
      );
    }
    const pageContext = result.data.page_context as { has_more_page?: boolean; total?: number } | undefined;
    // page_context.total is cumulative across pages; keep the largest value
    // seen so a shrunken/absent per-page total can never understate the count.
    if (typeof pageContext?.total === "number" && pageContext.total > totalMatched) {
      totalMatched = pageContext.total;
    }
    hasMore = Boolean(pageContext?.has_more_page);
    for (const record of records) {
      if (record !== null && typeof record === "object") rows.push(mapZohoRecord(zohoTable, record));
      if (rows.length >= cap) break;
    }
    page += 1;
  }

  // Honest truncation: the cap was hit while the source still had pages, or
  // fewer rows arrived than the source reported as matching.
  const stoppedAtCap = hasMore && rows.length >= cap;
  const totalRows = Math.max(rows.length, totalMatched);
  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    totalRows,
    truncated: stoppedAtCap || rows.length < totalRows,
  };
}

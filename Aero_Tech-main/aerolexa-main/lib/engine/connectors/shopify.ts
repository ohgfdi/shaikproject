/**
 * Shopify connector — read-only Admin REST pulls (orders/products/customers).
 *
 * Shopify is the commerce system of record for a large share of Indian D2C
 * brands — the connector pairs with Tally/Zoho (books) to give the seller
 * one workspace over revenue AND accounting. Same dispatcher contract as
 * every other engine: connect / test / browse / import / sync.
 *
 * Auth: a custom-app Admin API access token (shpat_…) with read_orders,
 * read_products, read_customers scopes. The token is stored encrypted at
 * rest; it is sent only as an Authorization header over HTTPS.
 *
 * REST pagination follows Shopify's cursor protocol: the `Link` response
 * header carries rel="next" with a page_info token. The connector follows
 * that header until the row cap (imports keep the NEWEST orders — the list
 * endpoints return most-recent-first).
 */

import { assertSafeExternalUrl } from "@/lib/server/url-guard";

import type { ShopifyConfig } from "./config";
import { ConnectorError } from "./errors";

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export const SHOPIFY_TABLES = ["orders", "products", "customers"] as const;
export type ShopifyTable = (typeof SHOPIFY_TABLES)[number];

const REST_PATH: Record<ShopifyTable, string> = {
  orders: "orders.json",
  products: "products.json",
  customers: "customers.json",
};

export interface ShopifyColumn {
  name: string;
  type: "string" | "number" | "date";
}

const TABLE_COLUMNS: Record<ShopifyTable, ShopifyColumn[]> = {
  orders: [
    { name: "order_number", type: "string" },
    { name: "created_at", type: "date" },
    { name: "financial_status", type: "string" },
    { name: "fulfillment_status", type: "string" },
    { name: "currency", type: "string" },
    { name: "total_price", type: "number" },
    { name: "subtotal_price", type: "number" },
    { name: "total_tax", type: "number" },
    { name: "total_discounts", type: "number" },
    { name: "customer_email", type: "string" },
  ],
  products: [
    { name: "title", type: "string" },
    { name: "product_type", type: "string" },
    { name: "vendor", type: "string" },
    { name: "status", type: "string" },
    { name: "created_at", type: "date" },
    { name: "variants_count", type: "number" },
  ],
  customers: [
    { name: "first_name", type: "string" },
    { name: "last_name", type: "string" },
    { name: "email", type: "string" },
    { name: "phone", type: "string" },
    { name: "state", type: "string" },
    { name: "orders_count", type: "number" },
    { name: "total_spent", type: "number" },
    { name: "created_at", type: "date" },
  ],
};

export function shopifyTableColumns(table: string): ShopifyColumn[] {
  return TABLE_COLUMNS[table as ShopifyTable] ?? [];
}

/* ------------------------------------------------------------------ */
/* Fetch plumbing                                                      */
/* ------------------------------------------------------------------ */

/**
 * GET a Shopify admin URL with SSRF-safe, bounded redirect handling.
 *
 * `assertHttpsShopDomain` only validates the *shape* of the caller-supplied
 * domain, so a plain `redirect: "follow"` would let the remote bounce the
 * request at an internal address. Every hop is therefore resolved and checked
 * by the shared guard, and the chain is capped at MAX_REDIRECTS hops — the
 * same posture `lib/server/url-guard.ts` applies to generic endpoints.
 */
async function fetchShopifyUrl(
  url: URL,
  init: { headers: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeExternalUrl(current.toString());
    const res = await fetch(current, {
      headers: init.headers,
      // Each hop is validated above, so follow-up happens here, not in fetch.
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, current);
    if (next.protocol !== "https:") {
      throw new ConnectorError("The Shopify endpoint redirected to a non-HTTPS URL, which is not allowed.", {
        status: 502,
        code: "CONNECTOR_REDIRECT",
      });
    }
    try {
      void res.body?.cancel();
    } catch {
      // draining the redirect body is best-effort
    }
    current = next;
  }
  throw new ConnectorError(
    `The Shopify endpoint redirected more than ${MAX_REDIRECTS} times. What happened: redirect loop. How to fix: verify the shop domain points directly at the admin API.`,
    { status: 508, code: "CONNECTOR_REDIRECT" },
  );
}

interface ShopifyApiResult<T> {
  data: T;
  /** Cursor for the next page (null when exhausted). */
  nextPageUrl: string | null;
}

function assertHttpsShopDomain(config: ShopifyConfig): string {
  const domain = config.shopDomain.trim();
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z.]{2,}$/i.test(domain)) {
    throw new ConnectorError(
      "The shop domain is invalid. How to fix: use the admin domain, e.g. acme-india.myshopify.com.",
    );
  }
  return `https://${domain}/admin/api/${config.apiVersion}`;
}

async function shopifyGet<T>(
  config: ShopifyConfig,
  path: string,
  params: Record<string, string> = {},
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<ShopifyApiResult<T>> {
  const base = assertHttpsShopDomain(config);
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetchShopifyUrl(url, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        Accept: "application/json",
      },
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        `The Shopify request timed out (${path}). How to fix: retry, or import a narrower table.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      `Could not reach ${config.shopDomain}. What happened: the shop domain is unreachable. How to fix: check the domain spelling and network access, then retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError(
      "Shopify rejected the access token. What happened: the token is wrong, revoked, or lacks the scopes for this table. How to fix: reinstall/refresh the custom app token with read_orders, read_products, read_customers scopes, then save again.",
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  if (res.status === 429) {
    throw new ConnectorError(
      "Shopify rate limit hit (429). What happened: too many requests in the bucket. How to fix: retry in a few seconds; scheduled syncs stay under the limit.",
      { status: 429, code: "CONNECTOR_REMOTE" },
    );
  }
  if (!res.ok) {
    throw new ConnectorError(
      `The Shopify API answered HTTP ${res.status}. How to fix: verify the shop domain and API version (${config.apiVersion}), then retry.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (data === null) {
    throw new ConnectorError(
      "The Shopify API returned a non-JSON response. How to fix: verify the domain points at your shop's admin API, then retry.",
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }

  // Cursor pagination: extract rel="next" from the Link header.
  const link = res.headers.get("link") ?? "";
  const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(link);
  return { data, nextPageUrl: nextMatch ? (nextMatch[1] ?? null) : null };
}

/* ------------------------------------------------------------------ */
/* Connection test                                                     */
/* ------------------------------------------------------------------ */

export async function testShopifyConnection(
  config: ShopifyConfig,
): Promise<{ serverVersion: string; latencyMs: number; database: string }> {
  const started = Date.now();
  const { data } = await shopifyGet<{ shop?: { name?: string; myshopify_domain?: string } }>(
    config,
    "shop.json",
    {},
    // A connection probe should fail fast rather than hold the UI for the
    // full query budget.
    CONNECT_TIMEOUT_MS,
  );
  const shopName = data.shop?.name ?? config.shopDomain;
  return {
    serverVersion: `Shopify (${data.shop?.myshopify_domain ?? config.shopDomain})`,
    latencyMs: Date.now() - started,
    database: shopName,
  };
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

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
export function mapShopifyRecord(table: ShopifyTable, record: Record<string, unknown>): (string | number | null)[] {
  return shopifyTableColumns(table).map((col) => {
    let raw: unknown = record[col.name];
    if (col.name === "customer_email") {
      const customer = record.customer as { email?: unknown } | undefined;
      raw = customer?.email ?? null;
    }
    if (col.name === "variants_count") {
      const variants = record.variants;
      raw = Array.isArray(variants) ? variants.length : null;
    }
    return col.type === "number" ? toNumber(raw) : toText(raw);
  });
}

const ROOT_KEY: Record<ShopifyTable, string> = {
  orders: "orders",
  products: "products",
  customers: "customers",
};

/**
 * Pull up to `limit` rows of a Shopify table, following the Link-header
 * cursor until the cap. The newest records come first (Shopify default).
 */
export async function fetchShopifyRows(
  config: ShopifyConfig,
  table: string,
  limit: number,
): Promise<{
  columns: { name: string; type: string }[];
  rows: (string | number | null)[][];
  totalRows: number;
  truncated: boolean;
}> {
  const shopifyTable = table as ShopifyTable;
  if (!SHOPIFY_TABLES.includes(shopifyTable)) {
    throw new ConnectorError(
      `Unknown Shopify table: ${table}. Use ${SHOPIFY_TABLES.map((t) => `“${t}”`).join(", ")}.`,
      { status: 404, code: "CONNECTOR_NOT_FOUND" },
    );
  }
  const cap = Math.max(1, Math.floor(limit));
  const columns = shopifyTableColumns(shopifyTable);

  const rows: (string | number | null)[][] = [];
  let path: string = REST_PATH[shopifyTable];
  let params: Record<string, string> = { limit: String(Math.min(250, cap)), status: "any" };
  let totalSeen = 0;

  while (rows.length < cap && path) {
    const result = await shopifyGet<Record<string, unknown>>(config, path, params);
    const records = result.data[ROOT_KEY[shopifyTable]];
    if (!Array.isArray(records)) {
      throw new ConnectorError(
        `The Shopify response for “${shopifyTable}” had an unexpected shape. How to fix: retry; if it persists, verify the token scopes.`,
        { status: 502, code: "CONNECTOR_REMOTE" },
      );
    }
    for (const record of records) {
      if (record !== null && typeof record === "object") {
        rows.push(mapShopifyRecord(shopifyTable, record as Record<string, unknown>));
      }
      if (rows.length >= cap) break;
    }
    totalSeen += records.length;
    if (result.nextPageUrl) {
      // Follow the signed cursor URL verbatim (it encodes page_info + limit).
      const next = new URL(result.nextPageUrl);
      path = `${next.pathname.replace(`/admin/api/${config.apiVersion}/`, "")}${next.search}`;
      params = {};
    } else {
      path = "";
    }
  }

  return {
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    totalRows: Math.max(rows.length, totalSeen),
    truncated: rows.length < totalSeen || (rows.length >= cap && totalSeen >= cap),
  };
}

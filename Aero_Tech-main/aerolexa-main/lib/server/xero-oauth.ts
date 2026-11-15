/**
 * Xero OAuth 2.0 connect flow + durable refresh-token storage.
 *
 * Xero rotates the refresh token on every exchange and invalidates the old one,
 * so a connector that does not persist the newest value works exactly once.
 * This module closes that loop:
 *
 *  1. `xeroAuthorizeUrl(state)` starts the authorisation-code flow with the
 *     accounting read scopes (offline_access is required for a refresh token).
 *  2. `connectXero(ctx, code)` exchanges the code, resolves the tenant and
 *     stores the refresh token encrypted with the same crypto used by every
 *     other connector.
 *  3. `persistRotatedXeroToken` writes the rotated value back into the stored
 *     config; `syncXeroConnector` wires it into the live test so a scheduled
 *     sync cannot leave a dead token behind.
 *
 * The client id/secret are instance-level env values; the per-connector secret
 * is the refresh token, which is never returned to a browser.
 */

import { randomBytes } from "node:crypto";

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateConnectorConfig, type ConnectorConfig } from "@/lib/engine/connectors/config";
import { decryptJson, encryptJson } from "@/lib/engine/connectors/crypto";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { testXeroConnection } from "@/lib/engine/connectors/xero";
import { serverEnv } from "@/lib/env";
import { logActivity } from "@/lib/server/activity";

const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const TIMEOUT_MS = 15_000;

export const XERO_SCOPES = "offline_access accounting.transactions.read accounting.contacts.read";

export function xeroConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET);
}

export function xeroRedirectUri(): string {
  const env = serverEnv();
  if (env.XERO_REDIRECT_URI) return env.XERO_REDIRECT_URI;
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/api/integrations/xero/callback`;
}

function requireXeroEnv(): { clientId: string; clientSecret: string } {
  const env = serverEnv();
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
    throw new ApiError(
      400,
      "XERO_NOT_CONFIGURED",
      "Xero is not configured on this instance. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET, then restart.",
    );
  }
  return { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET };
}

/** Fresh, unguessable OAuth state value (stored in a short-lived cookie). */
export function newXeroState(): string {
  return randomBytes(24).toString("hex");
}

export function xeroAuthorizeUrl(state: string): string {
  const { clientId } = requireXeroEnv();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: xeroRedirectUri(),
    scope: XERO_SCOPES,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function exchangeXeroCode(code: string): Promise<XeroTokenResponse> {
  const { clientId, clientSecret } = requireXeroEnv();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: xeroRedirectUri(),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      400,
      "XERO_AUTH_FAILED",
      `Xero rejected the authorisation (HTTP ${response.status}). What happened: the code may have expired or the redirect URI does not match. How to fix: connect again from this screen.${text ? ` Xero said: ${text.slice(0, 300)}` : ""}`,
    );
  }
  const parsed = JSON.parse(text) as Partial<XeroTokenResponse>;
  if (!parsed.refresh_token || !parsed.access_token) {
    throw new ApiError(
      400,
      "XERO_AUTH_FAILED",
      "Xero returned no refresh token. What happened: the app is missing the offline_access scope. How to fix: add it to the Xero app and connect again.",
    );
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_in: parsed.expires_in ?? 1800,
  };
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string;
}

export async function fetchXeroTenants(accessToken: string): Promise<XeroTenant[]> {
  const response = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      502,
      "XERO_TENANT_FAILED",
      `Xero did not return the connected organisations (HTTP ${response.status}). How to fix: reconnect the app and grant access to the organisation.`,
    );
  }
  const parsed = JSON.parse(text) as { tenantId?: string; tenantName?: string }[];
  return parsed
    .filter((row): row is { tenantId: string; tenantName?: string } => Boolean(row.tenantId))
    .map((row) => ({ tenantId: row.tenantId, tenantName: row.tenantName || "Xero organisation" }));
}

export interface XeroConnectionResult {
  connectorId: string;
  name: string;
  tenantId: string;
  tenantName: string;
}

/**
 * Exchange the authorisation code, resolve the tenant and create (or refresh)
 * the workspace's Xero connector. The refresh token is encrypted before it
 * touches the database and is never logged or returned.
 */
export async function connectXero(ctx: AuthContext, code: string): Promise<XeroConnectionResult> {
  const tokens = await exchangeXeroCode(code);
  const tenants = await fetchXeroTenants(tokens.access_token);
  const tenant = tenants[0];
  if (!tenant) {
    throw new ApiError(
      400,
      "XERO_NO_TENANT",
      "This Xero login is not connected to an organisation. How to fix: grant the app access to at least one organisation and connect again.",
    );
  }
  const { clientId, clientSecret } = requireXeroEnv();
  const config = validateConnectorConfig("xero", {
    clientId,
    clientSecret,
    refreshToken: tokens.refresh_token,
    tenantId: tenant.tenantId,
  });
  const name = `Xero — ${tenant.tenantName}`.slice(0, 140);

  const existing = await prisma.connector.findFirst({
    where: { workspaceId: ctx.workspace.id, kind: "xero" },
    select: { id: true },
  });
  const connector = existing
    ? await prisma.connector.update({
        where: { id: existing.id },
        data: { name, config: encryptJson(config), status: "ok", lastTestedAt: new Date(), lastError: null },
      })
    : await prisma.connector.create({
        data: {
          workspaceId: ctx.workspace.id,
          kind: "xero",
          name,
          config: encryptJson(config),
          status: "ok",
          lastTestedAt: new Date(),
          createdById: ctx.user.id,
        },
      });

  await logActivity(ctx, "XERO_CONNECTED", `Connected Xero tenant “${tenant.tenantName}”`, null, {
    connectorId: connector.id,
  });

  return { connectorId: connector.id, name, tenantId: tenant.tenantId, tenantName: tenant.tenantName };
}

/**
 * Store the newest refresh token for a connector. Xero invalidates the previous
 * one on every exchange, so dropping this write breaks the next sync.
 */
/**
 * Rebuild a stored Xero config with the newest refresh token. Pure so the
 * rotation contract is testable without Xero, a database or a clock: every
 * other credential must survive, and an empty token must be refused rather
 * than written.
 */
export function rotateXeroConfig(decrypted: unknown, refreshToken: string): ConnectorConfig {
  const wrapped =
    decrypted !== null && typeof decrypted === "object" && "xero" in (decrypted as Record<string, unknown>)
      ? ((decrypted as { xero?: unknown }).xero ?? {})
      : decrypted;
  return validateConnectorConfig("xero", { ...(wrapped as Record<string, unknown>), refreshToken });
}

export async function persistRotatedXeroToken(connectorId: string, refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  const connector = await prisma.connector.findUnique({ where: { id: connectorId }, select: { config: true } });
  if (!connector) return;
  const config = rotateXeroConfig(decryptJson<unknown>(connector.config), refreshToken);
  await prisma.connector.update({ where: { id: connectorId }, data: { config: encryptJson(config) } });
}

/**
 * Verify a stored Xero connection and persist any rotated refresh token.
 * This is the operation a scheduled sync runs: it exercises the credential
 * handshake end to end without pulling a dataset.
 */
export async function syncXeroConnector(
  ctx: AuthContext,
  connectorId: string,
): Promise<{ ok: true; serverVersion: string; latencyMs: number }> {
  const connector = await prisma.connector.findFirst({
    where: { id: connectorId, workspaceId: ctx.workspace.id, kind: "xero" },
    select: { id: true, config: true, name: true },
  });
  if (!connector) throw new ApiError(404, "NOT_FOUND", "Xero connection not found.");

  let config;
  try {
    config = validateConnectorConfig("xero", decryptJson<unknown>(connector.config));
  } catch (err) {
    throw new ApiError(
      500,
      "CONNECTOR_CONFIG",
      err instanceof ConnectorError
        ? err.message
        : "The stored Xero connection could not be read. How to fix: reconnect Xero.",
    );
  }

  try {
    const meta = await testXeroConnection(config.xero, {
      onRefreshToken: (refreshToken) => persistRotatedXeroToken(connector.id, refreshToken),
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "ok", lastTestedAt: new Date(), lastError: null, lastSyncAt: new Date() },
    });
    return { ok: true, ...meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Xero rejected the connection.";
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "error", lastTestedAt: new Date(), lastError: message.slice(0, 1000) },
    });
    throw new ApiError(502, "XERO_SYNC_FAILED", `${message} How to fix: reconnect Xero from the connectors screen.`);
  }
}

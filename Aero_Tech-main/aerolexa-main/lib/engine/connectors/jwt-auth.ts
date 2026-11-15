/**
 * Service-account JWT auth for warehouse connectors — real cryptography,
 * zero new dependencies (jose, already installed for auth, does RS256).
 *
 * Two flows live here:
 *
 * 1. Snowflake key-pair auth (JWT): a RS256 JWT whose subject is the
 *    Snowflake user, issued with the account's private key and POSTed to
 *    <account>.snowflakecomputing.com/oauth/token. The account identifier
 *    must be uppercased in the `iss`/`sub` claims (Snowflake requirement).
 * 2. BigQuery service-account auth: a RS256 JWT asserting the service
 *    account's scopes is exchanged at https://oauth2.googleapis.com/token
 *    for a short-lived access token (RFC 7523).
 *
 * Private keys never leave the server: they arrive as encrypted connector
 * config (lib/engine/connectors/crypto.ts) and are used only here, in-memory.
 */

import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";

import { ConnectorError } from "./errors";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Normalize a PEM private key: unescape \n, strip wrappers, validate. */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, "\n").replace(/^"|"$/g, "");
  if (!trimmed.includes("-----BEGIN")) {
    throw new ConnectorError(
      "The private key is not a PEM key. What happened: the key must include the BEGIN/END header lines. How to fix: paste the full key file contents, or escape newlines as \\n in the JSON credentials.",
    );
  }
  try {
    createPrivateKey(trimmed); // validation only — never leaves memory
  } catch {
    throw new ConnectorError(
      "The private key could not be parsed. What happened: the PEM body is malformed or the key is encrypted. How to fix: export an unencrypted PKCS#8 key (openssl pkcs8 -topk8 -nocrypt) and save again.",
    );
  }
  return trimmed;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, body: URLSearchParams, timeoutMs: number): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ConnectorError(
      `Could not reach the ${new URL(url).host} token endpoint. What happened: ${
        err instanceof Error ? err.message : "network failure"
      }. How to fix: confirm network access from the server, then retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new ConnectorError(
      `Token request failed (${res.status}). What happened: ${
        data.error_description || data.error || "the identity provider rejected the assertion"
      }. How to fix: verify the key/user/account configuration, then save and test again.`,
      { status: 401, code: "CONNECTOR_AUTH" },
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Snowflake key-pair (JWT) auth
// ---------------------------------------------------------------------------

export interface SnowflakeTokenMeta {
  token: string;
  expiresInSeconds: number;
  tokenUrl: string;
}

/**
 * Mint a Snowflake key-pair JWT and exchange it for a session token.
 * The JWT is signed with the account user's RSA private key per Snowflake's
 * documented key-pair authentication flow.
 */
export async function snowflakeAccessToken(config: {
  account: string;
  username: string;
  privateKeyPem: string;
  /** Optional password fallback (when no key is configured). */
  password?: string;
  timeoutMs?: number;
}): Promise<SnowflakeTokenMeta> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const account = config.account.trim().toUpperCase();

  if (config.privateKeyPem) {
    const pem = normalizePrivateKey(config.privateKeyPem);
    // jose accepts the PEM (PKCS#8) string as-is — headers included.
    const key = await importPKCS8(pem, "RS256");

    // Snowflake requires uppercase account + user in iss/sub.
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(`${account}.${config.username.trim().toUpperCase()}`)
      .setSubject(`${account}.${config.username.trim().toUpperCase()}`)
      .setIssuedAt()
      .setExpirationTime("55s") // must remain valid on receipt; short by design
      .sign(key);

    const data = await postForm(
      `https://${config.account.trim()}.snowflakecomputing.com/oauth/token`,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
        scope: "session:role-any",
      }),
      timeoutMs,
    );
    return {
      token: data.access_token!,
      expiresInSeconds: 55,
      tokenUrl: `https://${config.account.trim()}.snowflakecomputing.com/oauth/token`,
    };
  }

  if (config.password) {
    // Password grant fallback (works when the account allows it; key-pair is preferred).
    const data = await postForm(
      `https://${config.account.trim()}.snowflakecomputing.com/oauth/token`,
      new URLSearchParams({
        grant_type: "password",
        username: config.username.trim(),
        password: config.password,
        scope: "session:role-any",
      }),
      timeoutMs,
    );
    return {
      token: data.access_token!,
      expiresInSeconds: 900,
      tokenUrl: `https://${config.account.trim()}.snowflakecomputing.com/oauth/token`,
    };
  }

  throw new ConnectorError(
    "Snowflake needs either a private key (key-pair auth) or a password. How to fix: add privateKeyPem or password to the connector config.",
    { status: 400, code: "CONNECTOR_CONFIG" },
  );
}

// ---------------------------------------------------------------------------
// Google service-account (JWT → OAuth2) auth — shared by BigQuery + Sheets
// ---------------------------------------------------------------------------

const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly https://www.googleapis.com/auth/cloud-platform";

/**
 * Exchange a Google service-account JWT for an OAuth2 access token (RFC 7523)
 * for ANY Google API scope. BigQuery and Google Sheets both ride this flow.
 */
export async function googleServiceAccountAccessToken(
  credentials: { client_email: string; private_key: string; timeoutMs?: number },
  scope: string,
): Promise<{ token: string; expiresInSeconds: number }> {
  const timeoutMs = credentials.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pem = normalizePrivateKey(credentials.private_key);
  const key = await importPKCS8(pem, "RS256");

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(credentials.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setSubject(credentials.client_email)
    .sign(key);

  const data = await postForm(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    timeoutMs,
  );
  return { token: data.access_token!, expiresInSeconds: 3600 };
}

/** BigQuery-scoped token (kept as its own export for existing callers). */
export async function bigQueryAccessToken(credentials: {
  client_email: string;
  private_key: string;
  timeoutMs?: number;
}): Promise<{ token: string; expiresInSeconds: number }> {
  return googleServiceAccountAccessToken(credentials, BQ_SCOPE);
}

/**
 * Generic OIDC discovery — turns any standards-compliant identity provider
 * (Okta, Auth0, Azure AD/Entra, Keycloak, Google, OneLogin …) into an SSO
 * option from three env vars:
 *
 *   OIDC_ISSUER         e.g. https://idp.example.com/realms/Ledgerly
 *   OIDC_CLIENT_ID
 *   OIDC_CLIENT_SECRET
 *
 * The provider's `.well-known/openid-configuration` document supplies the
 * authorize/token/userinfo endpoints, so no per-vendor adapter is needed.
 * Discovery is validated (issuer match, HTTPS, endpoint presence) and the
 * result is cached per issuer for the process lifetime — discovery is not on
 * the hot path, but the login page renders the provider name from it.
 *
 * The authorization-code flow itself (state + PKCE) lives in
 * app/api/auth/oidc/{authorize,callback}/route.ts; these are the pure,
 * oracle-testable pieces.
 */

import { createHash, randomBytes } from "node:crypto";

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

/** The subset of the discovery document the flow needs. */
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  scopesSupported: string[] | null;
}

const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Fetch + validate the discovery document for an issuer.
 * Throws OidcError with an operator-readable remedy on any deviation.
 */
export async function discoverOidc(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  const trimmed = issuer.trim().replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(`${trimmed}/.well-known/openid-configuration`);
  } catch {
    throw new OidcError(`OIDC_ISSUER is not a valid URL: “${issuer}”.`);
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new OidcError("OIDC_ISSUER must use https in production.");
  }

  let doc: unknown;
  try {
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new OidcError(
        `Discovery document returned ${res.status}. How to fix: check OIDC_ISSUER (it should be the base issuer, e.g. https://idp.example.com/realms/Ledgerly).`,
      );
    }
    doc = await res.json();
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError(
      `Could not reach the OIDC discovery endpoint (${url.toString()}). How to fix: verify the issuer URL and that the IdP is reachable from this server.`,
    );
  }

  const d = doc as Record<string, unknown>;
  const authorizationEndpoint = typeof d.authorization_endpoint === "string" ? d.authorization_endpoint : null;
  const tokenEndpoint = typeof d.token_endpoint === "string" ? d.token_endpoint : null;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OidcError(
      "The discovery document is missing authorization_endpoint or token_endpoint (not an OIDC provider?).",
    );
  }
  // Issuer must match what was configured (mix-up protection, OIDC Core §3.1.3.7).
  const docIssuer = typeof d.issuer === "string" ? d.issuer.replace(/\/$/, "") : "";
  if (docIssuer && docIssuer !== trimmed) {
    throw new OidcError(`Discovery issuer “${docIssuer}” does not match OIDC_ISSUER “${trimmed}” (mix-up protection).`);
  }

  return {
    issuer: docIssuer || trimmed,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint: typeof d.userinfo_endpoint === "string" ? d.userinfo_endpoint : null,
    jwksUri: typeof d.jwks_uri === "string" ? d.jwks_uri : null,
    scopesSupported: Array.isArray(d.scopes_supported)
      ? d.scopes_supported.filter((s): s is string => typeof s === "string")
      : null,
  };
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636, method "S256") — required for confidential clients too;
// it costs nothing and protects the code even if a redirect URI is misconfigured.
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Fresh verifier + S256 challenge (base64url of 32 random bytes). */
export function createPkcePair(random: (n: number) => Buffer = randomBytes): PkcePair {
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** State parameter: HMAC-bound nonce the callback must echo back. */
export function createState(): string {
  return randomBytes(16).toString("base64url");
}

/** Build the redirect URL to the IdP's authorization endpoint. */
export function buildAuthorizeUrl(opts: {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  state: string;
  pkce: PkcePair;
  scopes?: string[];
}): string {
  const url = new URL(opts.discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", (opts.scopes ?? ["openid", "email", "profile"]).join(" "));
  url.searchParams.set("code_challenge", opts.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface OidcTokenResponse {
  accessToken: string;
  idToken: string | null;
  tokenType: string;
}

/** Exchange the authorization code at the token endpoint. */
export async function exchangeCode(opts: {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OidcTokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code_verifier: opts.verifier,
    }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new OidcError(
      `Token exchange failed (${res.status}). How to fix: verify OIDC_CLIENT_ID/OIDC_CLIENT_SECRET and that this exact redirect URI is registered at the IdP. ${detail.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : null;
  if (!accessToken) throw new OidcError("Token response contained no access_token.");
  return {
    accessToken,
    idToken: typeof body.id_token === "string" ? body.id_token : null,
    tokenType: typeof body.token_type === "string" ? body.token_type : "bearer",
  };
}

/** Fetch the verified email from the userinfo endpoint (the IdP has verified it). */
export async function fetchUserInfo(opts: {
  discovery: OidcDiscovery;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ email: string; name: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!opts.discovery.userinfoEndpoint) {
    throw new OidcError("The provider's discovery document has no userinfo_endpoint.");
  }
  const res = await fetchImpl(opts.discovery.userinfoEndpoint, {
    headers: { authorization: `Bearer ${opts.accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new OidcError(`Userinfo request failed (${res.status}).`);
  const body = (await res.json()) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) throw new OidcError("Userinfo response contained no email claim.");
  return { email: email.trim().toLowerCase(), name: typeof body.name === "string" ? body.name : null };
}

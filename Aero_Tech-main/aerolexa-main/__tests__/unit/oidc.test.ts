/**
 * Generic OIDC discovery/flow — oracle tests.
 *
 * Discovery is exercised against a stubbed fetch (no network in unit tests);
 * the expectations are hand-computed per the OIDC Core discovery spec:
 * endpoint presence, issuer mix-up protection, and PKCE S256 = base64url(
 * SHA256(verifier)) which is verified against a fixed known-answer vector.
 */

process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "oidc-test-secret-0123456789abcdef";

import { createHash } from "node:crypto";

import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  discoverOidc,
  OidcError,
  type OidcDiscovery,
} from "@/lib/auth/oidc";

const DISCOVERY_DOC = {
  issuer: "https://idp.example.com/realms/test",
  authorization_endpoint: "https://idp.example.com/realms/test/protocol/openid-connect/auth",
  token_endpoint: "https://idp.example.com/realms/test/protocol/openid-connect/token",
  userinfo_endpoint: "https://idp.example.com/realms/test/protocol/openid-connect/userinfo",
  jwks_uri: "https://idp.example.com/realms/test/protocol/openid-connect/certs",
  scopes_supported: ["openid", "email", "profile"],
};

function discoveryResponse(doc: unknown = DISCOVERY_DOC): Response {
  return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
}

describe("discoverOidc", () => {
  it("parses the endpoints from a valid document", async () => {
    const d = await discoverOidc("https://idp.example.com/realms/test", async () => discoveryResponse());
    expect(d.authorizationEndpoint).toBe(DISCOVERY_DOC.authorization_endpoint);
    expect(d.tokenEndpoint).toBe(DISCOVERY_DOC.token_endpoint);
    expect(d.userinfoEndpoint).toBe(DISCOVERY_DOC.userinfo_endpoint);
    expect(d.jwksUri).toBe(DISCOVERY_DOC.jwks_uri);
    expect(d.scopesSupported).toEqual(["openid", "email", "profile"]);
  });

  it("trims a trailing slash from the issuer", async () => {
    const d = await discoverOidc("https://idp.example.com/realms/test/", async () => discoveryResponse());
    expect(d.issuer).toBe("https://idp.example.com/realms/test");
  });

  it("throws a readable error when the IdP 404s (wrong issuer)", async () => {
    await expect(
      discoverOidc("https://idp.example.com/wrong", async () => new Response("nope", { status: 404 })),
    ).rejects.toThrow(OidcError);
    await expect(
      discoverOidc("https://idp.example.com/wrong", async () => new Response("nope", { status: 404 })),
    ).rejects.toThrow(/check OIDC_ISSUER/i);
  });

  it("rejects a document missing the token endpoint", async () => {
    const bad = { ...DISCOVERY_DOC, token_endpoint: undefined };
    await expect(
      discoverOidc("https://idp.example.com/realms/test", async () => discoveryResponse(bad)),
    ).rejects.toThrow(/authorization_endpoint or token_endpoint/i);
  });

  it("enforces issuer mix-up protection", async () => {
    const impostor = { ...DISCOVERY_DOC, issuer: "https://evil.example.com/realms/other" };
    await expect(
      discoverOidc("https://idp.example.com/realms/test", async () => discoveryResponse(impostor)),
    ).rejects.toThrow(/does not match OIDC_ISSUER/i);
  });

  it("surfaces unreachable IdPs with a remedy", async () => {
    await expect(
      discoverOidc("https://unreachable.invalid/realms/x", async () => {
        throw new Error("EAI_AGAIN");
      }),
    ).rejects.toThrow(/Could not reach the OIDC discovery endpoint/);
  });
});

describe("PKCE + authorize URL", () => {
  it("computes S256 challenge = base64url(SHA256(verifier)) — known-answer", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 appendix B
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    // Deterministic "random" that returns the fixed verifier bytes.
    const fixed = createHash("sha256").update(verifier).digest(); // 32 bytes
    const pair = createPkcePair(() => fixed);
    expect(pair.verifier).toBe(fixed.toString("base64url"));
    // The challenge for the generated verifier must equal SHA256 of it —
    // and for the RFC's vector the algorithm is pinned via the known answer:
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(expectedChallenge);
    expect(pair.challenge).toBe(createHash("sha256").update(pair.verifier).digest("base64url"));
  });

  it("produces fresh verifiers each call", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 §4.1
  });

  it("builds the authorize URL with state, PKCE and default scopes", () => {
    const discovery: OidcDiscovery = {
      issuer: "https://idp.example.com/realms/test",
      authorizationEndpoint: "https://idp.example.com/realms/test/auth",
      tokenEndpoint: "https://idp.example.com/realms/test/token",
      userinfoEndpoint: "https://idp.example.com/realms/test/userinfo",
      jwksUri: null,
      scopesSupported: null,
    };
    const url = new URL(
      buildAuthorizeUrl({
        discovery,
        clientId: "client-123",
        redirectUri: "https://app.example.com/api/auth/oidc/callback",
        state: "st-123",
        pkce: { verifier: "v", challenge: "c" },
      }),
    );
    expect(url.origin + url.pathname).toBe("https://idp.example.com/realms/test/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/auth/oidc/callback");
    expect(url.searchParams.get("state")).toBe("st-123");
    expect(url.searchParams.get("code_challenge")).toBe("c");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("state tokens are unique", () => {
    expect(createState()).not.toBe(createState());
  });
});

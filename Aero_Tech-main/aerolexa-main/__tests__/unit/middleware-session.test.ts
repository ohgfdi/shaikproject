/**
 * Middleware session-verification oracles (behavioural, not source-pinning).
 *
 * The middleware re-verifies the session cookie on the Edge runtime: it reads
 * one cookie name and checks one issuer/audience pair. Two independent drifts
 * broke it at once, and BOTH were invisible in the unit suite:
 *
 *  - it read the pre-rename `aerolexa.session`, while the app writes the
 *    brand key `ledgerly.session` (see lib/brand.ts) — so the header was
 *    always absent and every protected page redirected signed-in users to
 *    /login;
 *  - it verified `issuer: "Ledgerly", audience: "Ledgerly-web"`, but the
 *    signer (lib/auth/session.ts) deliberately mints `aerolexa` /
 *    `aerolexa-web` — wire contracts that must NOT move with the brand — so
 *    every signature check threw and `authed` was permanently false.
 *
 * These tests exercise the real `middleware()` with a token minted exactly the
 * way the signer mints one, so a future drift in either the cookie key or the
 * iss/aud pair fails here instead of in the browser.
 */
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

import { BRAND_STORAGE_KEYS, brandKey, legacyBrandKey } from "@/lib/brand";

const SECRET = "middleware-session-test-secret-0123456789abcdefghijklmno";

/** The issuer/audience lib/auth/session.ts signs with — pinned wire contract. */
const ISSUER = "aerolexa";
const AUDIENCE = "aerolexa-web";

async function mint(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ ver: 0, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user_123")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

/** Run the real middleware over a protected page with the given cookies. */
async function run(pathname: string, cookies: Record<string, string>): Promise<Response> {
  const req = new NextRequest(`https://ledgerly.test${pathname}`, {
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  const { middleware } = await import("@/middleware");
  return middleware(req);
}

const prevSecret = process.env.AUTH_SECRET;
beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});

describe("middleware recognizes the session cookie the app actually issues", () => {
  it("lets a signed-in user through on the current brand cookie key", async () => {
    const res = await run("/analyses/abc123", { [brandKey(BRAND_STORAGE_KEYS.session)]: await mint() });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still honours the pre-rename cookie so an upgraded install is not logged out", async () => {
    const res = await run("/analyses/abc123", { [legacyBrandKey(BRAND_STORAGE_KEYS.session)]: await mint() });
    expect(res.status).toBe(200);
  });

  it("verifies with the signer's issuer/audience, not the brand name", async () => {
    // A token signed with the ISSUER/AUDIENCE above must pass — proving the
    // middleware is not silently rejecting every real session.
    const good = await run("/dashboard", { [brandKey(BRAND_STORAGE_KEYS.session)]: await mint() });
    expect(good.status).toBe(200);

    // …and one signed with anything else must still be rejected.
    const bad = await new SignJWT({ ver: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_123")
      .setIssuer("someone-else")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const res = await run("/dashboard", { [brandKey(BRAND_STORAGE_KEYS.session)]: bad });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("still redirects anonymous visitors to /login (the guard is intact)", async () => {
    const res = await run("/dashboard", {});
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("keeps rejecting a forged signature", async () => {
    const forged = await new SignJWT({ ver: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_123")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret-entirely-0000000000000"));
    const res = await run("/dashboard", { [brandKey(BRAND_STORAGE_KEYS.session)]: forged });
    expect(res.status).toBe(307);
  });

  it("sends a signed-in user away from /login", async () => {
    const res = await run("/login", { [brandKey(BRAND_STORAGE_KEYS.session)]: await mint() });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });
});

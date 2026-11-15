import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { decode as decodeNextAuthToken } from "next-auth/jwt";

import { BRAND_STORAGE_KEYS, brandKey, legacyBrandKey, readBrandCookie } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

const COOKIE_NAME = brandKey(BRAND_STORAGE_KEYS.session);

/**
 * The cookie minted before the Ledgerly rename. Still read so that a live
 * deployment upgrades without logging every user out; `clearSessionCookie`
 * expires both so a sign-out leaves nothing behind.
 */
const LEGACY_COOKIE_NAME = legacyBrandKey(BRAND_STORAGE_KEYS.session);

/**
 * ISSUER/AUDIENCE are token *wire contracts*, not brand strings — deliberately
 * still "aerolexa". `jwtVerify` rejects a mismatched issuer, so renaming them
 * would invalidate every outstanding session on deploy. Same reasoning as
 * SAML_ENTITY_ID in lib/auth/saml.ts.
 */
const ISSUER = "aerolexa";
const AUDIENCE = "aerolexa-web";
/** A short-lived token that proves password success but NOT a full session. */
const MFA_AUDIENCE = "aerolexa-mfa";
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

function secretKey(): Uint8Array {
  return new TextEncoder().encode(serverEnv().AUTH_SECRET);
}

export interface SessionPayload {
  sub: string; // userId
  /** User.sessionVersion at mint time — a mismatch means the session was revoked. */
  ver?: number;
}

/**
 * Create a signed session token for a user. Sessions are stateless JWTs —
 * revocation is handled by a session version claim in a real deployment; the
 * prototype keeps sessions short-lived (default 7 days).
 */
export async function createSessionToken(userId: string): Promise<string> {
  const ttlDays = serverEnv().SESSION_TTL_DAYS;
  // Embed the user's current session version (SEC-7). readSession() compares
  // it against the live value, so bumping User.sessionVersion revokes every
  // outstanding token for that user — no token denylist needed.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  const ver = user?.sessionVersion ?? 1;
  return new SignJWT({ ver })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(secretKey());
}

/**
 * Bump the user's session version — every outstanding session JWT becomes
 * invalid at the next readSession(). Called on password change/reset; also
 * usable by an operator for "sign this user out everywhere".
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}

/**
 * Mint a five-minute MFA challenge after the password step succeeds. It is a
 * separate audience from a session token, so a challenge can never be replayed
 * as a session even if it leaks.
 */
export async function createMfaChallengeToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  return new SignJWT({ kind: "mfa", ver: user?.sessionVersion ?? 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(MFA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Verify an MFA challenge and return its user id, or null when invalid/expired/revoked. */
export async function verifyMfaChallengeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
    });
    if (!payload.sub || payload.kind !== "mfa") return null;
    const ver = typeof payload.ver === "number" ? payload.ver : 0;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { sessionVersion: true },
    });
    if (!user || user.sessionVersion !== ver) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Verify and decode the current request's session cookie. Returns null when absent/invalid/expired. */
export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();

  // 1) Try NextAuth.js JWT session first (enterprise SSO: SAML/OIDC/Google).
  //    The cookie is encrypted by next-auth/jwt with NEXTAUTH_SECRET.
  const nextAuthToken =
    store.get("next-auth.session-token")?.value ?? store.get("__Secure-next-auth.session-token")?.value;
  if (nextAuthToken) {
    try {
      const env = serverEnv();
      const payload = await decodeNextAuthToken({
        token: nextAuthToken,
        secret: env.NEXTAUTH_SECRET || env.AUTH_SECRET,
      });
      if (payload?.sub) return { sub: payload.sub };
    } catch {
      // Fall through to custom JWT session
    }
  }

  // 2) Fall back to the custom Ledgerly JWT session cookie. readBrandCookie
  //    transparently accepts the pre-rename `aerolexa.session` cookie — on the
  //    first read after the upgrade the user is still on a legacy cookie, and
  //    rejecting it would sign out the entire install. The cookie is re-minted
  //    under the new name on the next login, which retires the legacy key.
  const session = readBrandCookie<string>(store, BRAND_STORAGE_KEYS.session);
  const token = session?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!payload.sub) return null;
    // SEC-7: reject tokens minted before the current session version.
    const ver = typeof payload.ver === "number" ? payload.ver : 0;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { sessionVersion: true },
    });
    if (!user || user.sessionVersion !== ver) return null;
    return { sub: payload.sub, ver };
  } catch {
    return null;
  }
}

/** Attach the session cookie to an HTTP response (route handlers). */
export function createSessionCookie(
  token: string,
  maxAgeSeconds: number,
): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: COOKIE_NAME,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax",
      // Secure by default in production builds. AUTH_COOKIE_SECURE=true|false
      // overrides explicitly — self-hosted deployments on plain HTTP (LAN,
      // behind TLS-terminating proxies that strip scheme) need "false", and
      // the API integration harness (supertest over http://127.0.0.1) relies
      // on it because Secure cookies are not replayed over plain HTTP.
      secure: process.env.AUTH_COOKIE_SECURE
        ? process.env.AUTH_COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production",
      path: "/",
      maxAge: maxAgeSeconds,
    },
  };
}

export function clearSessionCookie(): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: COOKIE_NAME,
    value: "",
    options: { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 },
  };
}

/**
 * Both session cookie names, for sign-out. The cookie API returns a single
 * descriptor per name, so callers must set each. Returns the legacy cookie
 * first: sign-out clears the legacy key before the current one, so a failure
 * part-way leaves the user logged out rather than still holding a live session.
 */
export function clearSessionCookieDescriptors(): {
  name: string;
  value: string;
  options: Record<string, unknown>;
}[] {
  const options = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 };
  return [
    { name: LEGACY_COOKIE_NAME, value: "", options },
    { name: COOKIE_NAME, value: "", options },
  ];
}

export const SESSION_COOKIE = COOKIE_NAME;

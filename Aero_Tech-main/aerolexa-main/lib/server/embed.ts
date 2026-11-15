/**
 * Signed embed tokens for public dashboard embedding.
 *
 * A dashboard owner mints a token; the public embed page verifies it and
 * renders the dashboard read-only in an iframe context. Tokens are HMAC-SHA256
 * over a compact payload bound to the dashboard, its workspace and an expiry —
 * same family as the session JWT (jose HS256) but self-contained so the embed
 * surface has no cookie/session dependency (third-party cookie blocking would
 * break a session-based embed; a signed URL keeps working).
 *
 * Threat model: a token grants READ-ONLY view of ONE dashboard until expiry.
 * It never carries write power, never exposes other workspace data, and is
 * revocable by rotation (dashboard rotateEmbedToken) or unpublish.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { appUrl, serverEnv } from "@/lib/env";

const TOKEN_VERSION = "v1";

interface EmbedPayload {
  /** Dashboard id. */
  d: string;
  /** Workspace id (binds the token to its tenant). */
  w: string;
  /** Expiry (epoch seconds). */
  e: number;
  /** Issued-at (epoch seconds). */
  i: number;
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function embedSecret(): string {
  return serverEnv().AUTH_SECRET;
}

function sign(payload: EmbedPayload): string {
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", embedSecret()).update(`${TOKEN_VERSION}.${body}`).digest("base64url");
  return `${TOKEN_VERSION}.${body}.${sig}`;
}

function verify(token: string): EmbedPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [version, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", embedSecret()).update(`${version}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as EmbedPayload;
    if (typeof payload.d !== "string" || typeof payload.w !== "string" || typeof payload.e !== "number") {
      return null;
    }
    if (payload.e * 1000 < Date.now()) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface EmbedTokenClaims {
  dashboardId: string;
  workspaceId: string;
  expiresAt: Date;
  issuedAt: Date;
}

/** Mint a signed embed token for a dashboard. Returns the token + claims. */
export function mintEmbedToken(
  dashboardId: string,
  workspaceId: string,
  ttlDays = 90,
): { token: string; claims: EmbedTokenClaims } {
  const now = Math.floor(Date.now() / 1000);
  const payload: EmbedPayload = {
    d: dashboardId,
    w: workspaceId,
    e: now + ttlDays * 86_400,
    i: now,
  };
  return {
    token: sign(payload),
    claims: {
      dashboardId,
      workspaceId,
      expiresAt: new Date(payload.e * 1000),
      issuedAt: new Date(payload.i * 1000),
    },
  };
}

/** Verify a token; returns claims or null (expired/tampered/malformed). */
export function verifyEmbedToken(token: string): EmbedTokenClaims | null {
  const payload = verify(token);
  if (!payload) return null;
  return {
    dashboardId: payload.d,
    workspaceId: payload.w,
    expiresAt: new Date(payload.e * 1000),
    issuedAt: new Date(payload.i * 1000),
  };
}

/** Build the public embed URL for a token. */
export function embedUrl(token: string): string {
  return `${appUrl()}/embed/${token}`;
}

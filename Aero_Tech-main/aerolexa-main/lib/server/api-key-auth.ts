import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/server/api-key-rate-limiter";
import { normalizeApiKey, verifyApiKey, extractPrefix } from "@/lib/server/api-keys";
import { RATE_LIMITS, checkRateLimit as checkInstanceRateLimit } from "@/lib/server/rate-limit";

export interface ApiKeyContext {
  userId: string;
  workspaceId: string;
  apiKeyId: string;
  scopes: string[];
  rateLimit: number;
}

/**
 * Validate API key from Authorization header.
 * Expected format: "Bearer ak_live_xxxxxxxx_yyyyyyyyyyyyyyyy"
 *
 * The scheme is matched CASE-INSENSITIVELY per RFC 6750 §2.1 — several HTTP
 * clients (and every major SDK's auth layer) send "bearer" lowercased, and
 * rejecting them made the public API authenticate only for callers that
 * happened to spell the scheme exactly "Bearer ".
 */
export async function validateApiKey(request: NextRequest): Promise<{ context: ApiKeyContext } | NextResponse> {
  const authHeader = request.headers.get("authorization");
  const scheme = authHeader?.slice(0, 7);
  if (!authHeader || !scheme || scheme.toLowerCase() !== "bearer ") {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Missing or invalid Authorization header. Use: Bearer <api-key>" },
      },
      { status: 401 },
    );
  }

  // Trim the credential: trailing newlines/spaces (a copy-paste artifact in
  // curl scripts and CI secrets) must not change the lookup prefix or the
  // bytes bcrypt compares.
  const apiKey = normalizeApiKey(authHeader.slice(7));
  const prefix = extractPrefix(apiKey);
  if (!prefix) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_KEY", message: "Invalid API key format" } },
      { status: 401 },
    );
  }

  // Find key by prefix
  const keyRecord = await prisma.userApiKey.findUnique({
    where: { keyPrefix: prefix },
    select: {
      id: true,
      userId: true,
      workspaceId: true,
      keyHash: true,
      scopes: true,
      rateLimit: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!keyRecord) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_KEY", message: "Invalid API key" } },
      { status: 401 },
    );
  }

  if (keyRecord.revokedAt) {
    return NextResponse.json(
      { ok: false, error: { code: "REVOKED_KEY", message: "API key has been revoked" } },
      { status: 401 },
    );
  }

  if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
    return NextResponse.json(
      { ok: false, error: { code: "EXPIRED_KEY", message: "API key has expired" } },
      { status: 401 },
    );
  }

  const isValid = await verifyApiKey(apiKey, keyRecord.keyHash);
  if (!isValid) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_KEY", message: "Invalid API key" } },
      { status: 401 },
    );
  }

  // Re-validate the credential's authority on EVERY request, not just at
  // creation time. A key outlives the account state it was minted under, so
  // membership removal, a workspace switch or a deleted user must invalidate
  // it immediately rather than at the next key rotation.
  const owner = await prisma.user.findUnique({
    where: { id: keyRecord.userId },
    select: { id: true, workspaceId: true },
  });
  if (!owner) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_KEY", message: "Invalid API key" } },
      { status: 401 },
    );
  }
  if (owner.workspaceId !== keyRecord.workspaceId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "KEY_NOT_AUTHORIZED",
          message:
            "This API key is no longer authorized for the requesting account. It was issued for a workspace the account is no longer a member of.",
        },
      },
      { status: 403 },
    );
  }

  // Update last used timestamp (fire and forget)
  prisma.userApiKey
    .update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  let scopes: string[];
  try {
    const parsed = JSON.parse(keyRecord.scopes || "[]");
    scopes = Array.isArray(parsed) ? parsed.filter((s: unknown): s is string => typeof s === "string") : [];
  } catch {
    scopes = [];
  }

  const context: ApiKeyContext = {
    userId: keyRecord.userId,
    workspaceId: keyRecord.workspaceId,
    apiKeyId: keyRecord.id,
    scopes,
    rateLimit: keyRecord.rateLimit,
  };

  // Check rate limit
  const rateLimitResult = checkRateLimit(keyRecord.id, keyRecord.rateLimit);
  if (!rateLimitResult.allowed) {
    const response = NextResponse.json(
      {
        ok: false,
        error: { code: "RATE_LIMITED", message: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(rateLimitResult.retryAfter));
    return response;
  }

  // Instance ceiling, independent of the per-key allowance. The key's own
  // limit is operator-configurable and can be set very high, so without this a
  // single (or many) keys could still be used to saturate the instance. The
  // cheaper of the two always wins: a key with rateLimit=100000 is still
  // capped at RATE_LIMITS.public_api.
  const instance = checkInstanceRateLimit(keyRecord.id, "api_key", "public_api", RATE_LIMITS.public_api);
  if (!instance.allowed) {
    const response = NextResponse.json(
      {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: `Public API rate limit exceeded — retry in ${instance.retryAfterSeconds}s.`,
          retryAfter: instance.retryAfterSeconds,
        },
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(instance.retryAfterSeconds));
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMITS.public_api.limit));
    response.headers.set("X-RateLimit-Remaining", "0");
    return response;
  }

  return { context };
}

/**
 * Check if context has required scope.
 *
 * There is deliberately no `admin:all` wildcard: a key may only carry the
 * scopes its owner was granted, so a compromised read key cannot be escalated
 * into a write key.
 */
export function requireScope(context: ApiKeyContext, scope: string): boolean {
  return context.scopes.includes(scope);
}

/**
 * Add API key context to response headers for debugging.
 */
export function addApiKeyHeaders(response: NextResponse, context: ApiKeyContext): NextResponse {
  response.headers.set("X-API-Key-ID", context.apiKeyId);
  response.headers.set("X-API-Key-Scopes", context.scopes.join(","));
  return response;
}

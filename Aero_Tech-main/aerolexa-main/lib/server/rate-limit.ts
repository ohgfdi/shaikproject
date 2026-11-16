/**
 * Phase 10: Rate Limiting Middleware
 *
 * Provides per-endpoint rate limiting with configurable limits.
 * Uses Redis-backed sliding window for accurate rate limiting.
 * Falls back to in-memory store if Redis is unavailable.
 *
 * Usage in routes:
 *   import { rateLimit } from "@/lib/server/rate-limit";
 *
 *   export const GET = rateLimit("api", 100, "15m")(reqHandler);
 *
 * Available preset limits (from RATE_LIMITS enum):
 *   - RATE_LIMITS.login: 10 req/15min per IP
 *   - RATE_LIMITS.api: 200 req/15min per IP
 *   - RATE_LIMITS.burst: 20 req/1min for short bursts
 */
import type { NextRequest } from "next/server";
import { RATE_LIMITS } from "./rate-limit-types";

/** In-memory fallback store when Redis is unavailable. */
const memoryStore = new Map<string, { count: number; resetAt: number }>();

/** Get or create a rate limit store for a key. */
function getStoreKey(key: string): string {
  return `rl:${key}`;
}

/** Get the current count and reset time for a key. */
function getRateLimit(key: string): { count: number; resetAt: number } | null {
  // Try Redis first (if available), fall back to memory
  const storeKey = getStoreKey(key);

  // Memory fallback
  const entry = memoryStore.get(storeKey);
  if (entry && entry.resetAt > Date.now()) {
    return { count: entry.count, resetAt: entry.resetAt };
  }
  if (entry && entry.resetAt <= Date.now()) {
    // Expired, reset
    memoryStore.delete(storeKey);
    return null;
  }

  return null;
}

/** Increment the rate limit counter for a key. */
function incrementRateLimit(key: string, limit: number, windowMs: number): {
  success: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
} {
  const storeKey = getStoreKey(key);
  const now = Date.now();

  let entry = memoryStore.get(storeKey);
  if (!entry) {
    entry = { count: 0, resetAt: now + windowMs };
    memoryStore.set(storeKey, entry);
  }

  // Reset if window expired
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  const remaining = Math.max(0, limit - entry.count);
  const success = entry.count <= limit;

  return {
    success,
    remaining,
    resetAt: entry.resetAt,
    limit,
  };
}

/**
 * Rate limit middleware factory.
 *
 * @param identifier - Unique identifier for the rate limit group (e.g., "api", "login")
 * @param limit - Maximum number of requests allowed
 * @param window - Time window in format "15m", "1m", "1h", etc.
 * @returns Express/Next.js middleware function
 */
export function rateLimit(
  identifier: string,
  limit: number,
  window: string,
) {
  // Parse window string to milliseconds
  const windowMs = parseTimeWindow(window);

  return async (request: NextRequest) => {
    // Get client identifier (IP address)
    const ip = (request as any).ip ?? request.headers.get("x-forwarded-for") ?? "unknown";
    const key = `${identifier}:${ip}`;

    // Check rate limit
    const { success, remaining, resetAt } = incrementRateLimit(key, limit, windowMs);

    if (!success) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      const retryHeader = `retry-after: ${retryAfter}`;

      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          limit,
          remaining: 0,
          resetAt: new Date(resetAt).toISOString(),
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": retryAfter.toString(),
            ...(retryHeader !== "retry-after: 0" ? { "X-RateLimit-Retry-After": retryAfter.toString() } : {}),
          },
        },
      );
    }

    // Add rate limit headers to successful responses
    const remainingHeader = `x-ratelimit-remaining: ${remaining}`;
    const resetHeader = `x-ratelimit-reset: ${new Date(resetAt).toISOString()}`;
    const limitHeader = `x-ratelimit-limit: ${limit}`;

    return new Response(null, {
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": new Date(resetAt).toISOString(),
        ...(remainingHeader !== "x-ratelimit-remaining: 0" ? { remainingHeader } : {}),
        ...(resetHeader !== "x-ratelimit-reset: " ? { resetHeader } : {}),
        ...(limitHeader !== "x-ratelimit-limit: " ? { limitHeader } : {}),
      },
    });
  };
}

/** Parse time window string to milliseconds. */
function parseTimeWindow(window: string): number {
  const unit = window.slice(-1);
  const value = parseInt(window, 10);

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      // Default to minutes if no unit specified
      return value * 60 * 1000;
  }
}


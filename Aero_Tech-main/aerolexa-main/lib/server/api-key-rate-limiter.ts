/**
 * In-memory rate limiter for API keys.
 * Uses a sliding window algorithm with per-key counters.
 * For production, consider Redis-based rate limiting.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
  firstRequest: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const CLEANUP_INTERVAL = 60_000; // 1 minute

// Periodic cleanup of old entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.firstRequest > 300_000) {
      // 5 minutes old
      rateLimitStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

/** Check and increment rate limit for a key. */
export function checkRateLimit(
  keyId: string,
  limit: number,
  windowMs = 60_000,
): { allowed: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(keyId);

  if (!entry) {
    rateLimitStore.set(keyId, { count: 1, windowStart: now, firstRequest: now });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  // Check if we're in a new window
  if (now - entry.windowStart >= windowMs) {
    // New window
    rateLimitStore.set(keyId, { count: 1, windowStart: now, firstRequest: entry.firstRequest });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  // Increment counter
  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: limit - entry.count, retryAfter: 0 };
}

/** Get the rate limiter instance (singleton). */
export function getApiKeyRateLimiter() {
  return {
    checkLimit: checkRateLimit,
  };
}

/** Reset rate limit for a key (for testing). */
export function resetRateLimit(keyId: string) {
  rateLimitStore.delete(keyId);
}

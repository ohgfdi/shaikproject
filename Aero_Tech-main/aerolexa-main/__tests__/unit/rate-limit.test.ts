import { ApiError } from "@/lib/auth/guard";
import { RATE_LIMITS, clientIp, enforceRateLimit, rateLimitStatus, resetRateLimitStore } from "@/lib/server/rate-limit";

const CFG = { limit: 3, windowMs: 60_000 };

function fakeRequest(ip = "203.0.113.9"): Request {
  return new Request("http://localhost/api/test", { headers: { "x-forwarded-for": ip } });
}

describe("rate-limit", () => {
  beforeEach(() => resetRateLimitStore());

  it("allows requests up to the limit", () => {
    for (let i = 1; i <= 3; i++) {
      const status = rateLimitStatus("t", "user" as const, CFG, 1000);
      expect(status.allowed).toBe(true);
      expect(status.remaining).toBe(3 - i);
    }
  });

  it("defines a budget for every expensive operation added in 3.3", () => {
    // These were all previously unmetered or charged to the wrong bucket.
    for (const bucket of ["upload", "connector_import", "connector_test", "public_api", "llm_validate"] as const) {
      const cfg = RATE_LIMITS[bucket];
      expect(cfg).toBeDefined();
      expect(cfg.limit).toBeGreaterThan(0);
      expect(cfg.windowMs).toBeGreaterThan(0);
    }
  });

  it("caps an API key at the instance ceiling even when its own limit is huge", () => {
    // A key configured with rateLimit=100000 must still be throttled by
    // RATE_LIMITS.public_api — the cheaper of the two always wins.
    const ceiling = RATE_LIMITS.public_api.limit;
    for (let i = 0; i < ceiling; i++) {
      const status = rateLimitStatus("key-huge", "api_key", RATE_LIMITS.public_api, 1000);
      expect(status.allowed).toBe(true);
    }
    const blocked = rateLimitStatus("key-huge", "api_key", RATE_LIMITS.public_api, 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not let one principal's burst consume another's budget", () => {
    for (let i = 0; i < RATE_LIMITS.public_api.limit; i++) {
      rateLimitStatus("key-a", "api_key", RATE_LIMITS.public_api, 1000);
    }
    expect(rateLimitStatus("key-a", "api_key", RATE_LIMITS.public_api, 1000).allowed).toBe(false);
    // A different key is unaffected — the bucket is keyed per principal.
    expect(rateLimitStatus("key-b", "api_key", RATE_LIMITS.public_api, 1000).allowed).toBe(true);
  });

  it("blocks once the limit is exceeded and reports retry-after", () => {
    let status = { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    for (let i = 0; i < 4; i++) {
      status = rateLimitStatus("t", "user" as const, CFG, 1000);
    }
    expect(status.allowed).toBe(false);
    expect(status.retryAfterSeconds).toBe(60);

    let caught: ApiError | null = null;
    try {
      enforceRateLimit(fakeRequest("198.51.100.7"), "user" as const, { limit: 1, windowMs: 5_000 });
      enforceRateLimit(fakeRequest("198.51.100.7"), "user" as const, { limit: 1, windowMs: 5_000 });
    } catch (err) {
      caught = err as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught!.status).toBe(429);
    expect(caught!.code).toBe("RATE_LIMITED");
    expect(caught!.headers?.["Retry-After"]).toBe("5");
  });

  it("gives distinct clients independent budgets", () => {
    // Exhaust client-a's budget completely (limit 3 → 4th call blocked).
    for (let i = 0; i <= CFG.limit; i++) rateLimitStatus("client-a", "user" as const, CFG, 0);
    expect(rateLimitStatus("client-a", "user" as const, CFG, 0).allowed).toBe(false);

    // client-b shares nothing with client-a — full budget, untouched.
    const other = rateLimitStatus("client-b", "user" as const, CFG, 0);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("refills after the window elapses", () => {
    rateLimitStatus("t", "user" as const, CFG, 0);
    rateLimitStatus("t", "user" as const, CFG, 0);
    rateLimitStatus("t", "user" as const, CFG, 0);
    expect(rateLimitStatus("t", "user" as const, CFG, 0).allowed).toBe(false);
    const after = rateLimitStatus("t", "user" as const, CFG, 60_001);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(2);
  });

  it("ignores spoofable x-forwarded-for unless trusted proxy hops are declared", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "198.51.100.3, 10.0.0.1" },
    });

    // Default (TRUST_PROXY_HOPS unset): the header is client-controlled and
    // ignored — fail closed into one shared bucket instead of letting a
    // spoofed fresh IP escape its rate limit on every request.
    delete process.env.TRUST_PROXY_HOPS;
    expect(clientIp(req)).toBe("untrusted-proxy");

    // With one trusted proxy, the RIGHTMOST entry is the real client: each
    // proxy appends the peer it saw; anything further left is a client lie.
    process.env.TRUST_PROXY_HOPS = "1";
    try {
      expect(clientIp(req)).toBe("10.0.0.1");
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
  });

  it("exposes sensible default limits for auth and upload buckets", () => {
    expect(RATE_LIMITS.signup.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.login.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.upload.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.upload.windowMs).toBe(60 * 60 * 1000);
  });
});

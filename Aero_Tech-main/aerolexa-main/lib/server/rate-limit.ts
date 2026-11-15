/**
 * Rate limiting — in-memory first, cluster-reconciled in multi-replica
 * deployments.
 *
 * Design decisions:
 * 1. Requests are keyed by client identity (the client IP for unauthenticated
 *    endpoints; the principal for authenticated ones). An attacker spreading
 *    requests across many principals is still limited per principal.
 * 2. Blocked requests do NOT consume budget — once the window is exhausted,
 *    retrying doesn't extend the lockout; the window simply refills.
 * 3. Enforcement throws an ApiError(429) with a `Retry-After` header so every
 *    route returns the same machine-readable shape.
 * 4. MULTI-REPLICA (see lib/server/replica-bus.ts): the local decision stays
 *    synchronous — hot paths never await a database — and a fire-and-forget
 *    reconciliation merges this replica's consumption into the shared
 *    ledger. When the ledger already shows a fuller window, the local bucket
 *    is pulled DOWN to the cluster truth, so N replicas share ONE budget
 *    (modulo the ≤1-request-per-replica race any eventually-consistent
 *    limiter accepts). DB outage ⇒ fail open to per-replica behavior.
 */

import { ApiError } from "@/lib/auth/guard";

import type { RateLimitConfig, RateLimitResult } from "./rate-limit-types";
import { pruneRateLimitLedger, syncRateLimitWindow } from "./replica-bus";

export type { RateLimitConfig, RateLimitResult };

interface RateLimitWindow {
  count: number;
  resetAt: number;
}

class RateLimitStore {
  private buckets = new Map<string, Map<string, RateLimitWindow>>();

  get(bucket: string, key: string): RateLimitWindow | null {
    return this.buckets.get(bucket)?.get(key) ?? null;
  }

  set(bucket: string, key: string, entry: RateLimitWindow): void {
    let map = this.buckets.get(bucket);
    if (!map) {
      map = new Map();
      this.buckets.set(bucket, map);
    }
    map.set(key, entry);
    if (map.size > 10_000) this.prune(bucket, Date.now());
  }

  prune(bucket: string, now: number): void {
    const map = this.buckets.get(bucket);
    if (!map) return;
    for (const [key, entry] of map) {
      if (entry.resetAt <= now) map.delete(key);
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}

const store = new RateLimitStore();

/**
 * Fire-and-forget cluster reconciliation: push this replica's local window
 * into the shared ledger and, when the ledger shows MORE consumption than we
 * know locally (another replica's requests), pull our bucket down to cluster
 * truth. Never awaited on the request path and never throws.
 *
 * SECURITY NOTE (fail-open): if the shared ledger is unreachable (DB outage),
 * the cluster merge is skipped and each replica enforces only its OWN local
 * budget — so the effective cluster-wide limit can rise to (limit × replicas)
 * for the duration of the outage. This is a deliberate availability trade-off
 * (a database outage must not lock every user out of the API), but it is
 * logged so an operator can alert on the degraded state rather than discover
 * it after the fact.
 */
function reconcileWithCluster(
  principalType: string,
  principalId: string,
  bucketName: string,
  config: RateLimitConfig,
  window: RateLimitWindow,
  now: number,
): void {
  void syncRateLimitWindow(
    bucketName,
    `${principalType}:${principalId}`,
    window.count,
    config.windowMs,
    now,
    warnReconcileDegraded,
  )
    .then((cluster) => {
      if (cluster.count > window.count) {
        // Another replica consumed budget we haven't seen: adopt the shared
        // window wholesale so the NEXT local decision respects it.
        window.count = cluster.count;
        if (cluster.resetAt > window.resetAt) window.resetAt = cluster.resetAt;
        store.set(bucketName, `${principalType}:${principalId}`, window);
      }
      if (Math.random() < 0.01) void pruneRateLimitLedger(now); // ~1%: opportunistic GC
    })
    .catch((err: unknown) => warnReconcileDegraded(err)); // safety net; syncRateLimitWindow fails open
}

let lastReconcileWarnAt = 0;

/** Warn (at most once a minute) that cross-replica limits are degraded. */
function warnReconcileDegraded(err: unknown): void {
  const at = Date.now();
  if (at - lastReconcileWarnAt < 60_000) return;
  lastReconcileWarnAt = at;
  // eslint-disable-next-line no-console
  console.warn(
    "[rate-limit] cluster reconciliation failed — enforcing PER-REPLICA limits only " +
      "until the shared ledger recovers. Effective cluster limit may rise to limit×replicas.",
    err instanceof Error ? err.message : err,
  );
}

/**
 * Consume one unit of a bucket's budget for a principal.
 * Blocked calls return `allowed: false` without incrementing the counter.
 */
export function checkRateLimit(
  principalId: string,
  principalType: "user" | "api_key",
  bucketName: string,
  config: RateLimitConfig,
  now: number = Date.now(),
  keyId?: string,
): RateLimitResult {
  // When keyId is provided, key by keyId:principalType for per-key rate limiting
  // otherwise key by principalType:principalId for IP/user rate limiting
  const key = keyId ? `${keyId}:${principalType}` : `${principalType}:${principalId}`;
  const existing = store.get(bucketName, key);
  const window = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + config.windowMs } : existing;

  const retryAfterSeconds = Math.max(0, Math.ceil((window.resetAt - now) / 1000));
  if (window.count + 1 > config.limit) {
    // Windows are stored/refreshed even when blocked so `retryAfter` is stable.
    store.set(bucketName, key, window);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  window.count += 1;
  store.set(bucketName, key, window);
  reconcileWithCluster(principalType, principalId, bucketName, config, window, now);
  return { allowed: true, remaining: Math.max(0, config.limit - window.count), retryAfterSeconds };
}

/**
 * Enforce a bucket for a request. Keyed by the client IP (unauthenticated
 * endpoints have no principal yet); throws ApiError(429) when exceeded.
 */
export function enforceRateLimit(
  request: Request,
  bucketName: string,
  config: RateLimitConfig,
  now: number = Date.now(),
): void {
  const principalId = clientIp(request) ?? "unknown";
  const outcome = checkRateLimit(principalId, "user", bucketName, config, now);
  if (!outcome.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `Too many requests — try again in ${outcome.retryAfterSeconds} second${outcome.retryAfterSeconds === 1 ? "" : "s"}.`,
      undefined,
      { "Retry-After": String(outcome.retryAfterSeconds) },
    );
  }
}

/** Non-throwing status read for tests and diagnostics. */
export function rateLimitStatus(
  principalId: string,
  principalType: "user" | "api_key",
  config: RateLimitConfig,
  now: number = Date.now(),
  keyId?: string,
): RateLimitResult {
  return checkRateLimit(principalId, principalType, "api_general", config, now, keyId);
}

/** Remaining budget for a principal in a named bucket (informational). */
export function getRateLimitStatus(
  principalId: string,
  principalType: "user" | "api_key",
  bucketName: keyof typeof RATE_LIMITS,
  keyId?: string,
): { remaining: number; resetAt: number; totalLimit: number } | null {
  const key = keyId ? `${keyId}:${principalType}` : `${principalType}:${principalId}`;
  const entry = store.get(bucketName, key);
  if (!entry) return null;
  const config = RATE_LIMITS[bucketName];
  return {
    remaining: Math.max(0, config.limit - entry.count),
    resetAt: entry.resetAt,
    totalLimit: config.limit,
  };
}

/** Reset all buckets (tests). */
export function resetRateLimitStore(): void {
  store.clear();
}

/**
 * Number of proxy hops in front of this server that are TRUSTED to set/append
 * x-forwarded-for. Default 0 (no proxy): the header is ignored entirely
 * because a client can send any value it wants.
 *
 * Why this matters (SEC-7): with the previous "first entry" parsing, an
 * attacker behind a trusted proxy could send a fresh fake X-Forwarded-For on
 * every request and never hit an IP rate limit — each bogus IP got its own
 * bucket. Deployments MUST set TRUST_PROXY_HOPS to their real proxy count:
 *
 *   TRUST_PROXY_HOPS=1   # one proxy (nginx/Cloudflare/ALB in front)
 *
 * With N trusted hops the CLIENT address is the (N+1)-th value from the RIGHT
 * of the chain (right-most values are appended by the trusted proxies
 * themselves; values further left were set by the client and can be lies).
 */
export function trustedProxyHops(): number {
  // Note: a raw string "undefined" (the classic process.env coercion artifact)
  // must also count as unset — Number("undefined") is NaN, handled below.
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 0;
}

/**
 * Extract the client IP for rate limiting.
 *
 * With TRUST_PROXY_HOPS=0 (default): the socket peer is the only honest
 * identity, and Node route handlers do not expose it portably — so the caller
 * may pass a peer address via `fallback`; otherwise requests collapse into
 * ONE shared bucket ("untrusted-proxy"), which is fail-closed: a burst is
 * throttled for everyone rather than escaped by header spoofing.
 * With N>0: walk the x-forwarded-for chain from the right, skip N trusted
 * proxy entries, and take the next value as the client address.
 */
export function clientIp(request: Request, fallback?: string): string | undefined {
  const hops = trustedProxyHops();
  const forwarded = request.headers.get("x-forwarded-for");
  if (hops > 0 && forwarded) {
    const parts = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // XFF semantics: each proxy APPENDS the address of the peer IT saw. So
    // with N trusted proxies the client address is the N-th value FROM THE
    // RIGHT: parts[len - N]. (One proxy: rightmost = real client. Two
    // proxies: rightmost = proxy-1's addr as seen by proxy-2, next = client.)
    // Values further left were sent by the client itself and are unverified —
    // that is exactly the spoofing this parsing prevents.
    const idx = parts.length - hops;
    if (idx >= 0) return parts[idx];
    // Chain shorter than the trusted path — fail closed.
    return fallback ?? "untrusted-proxy";
  }
  if (hops === 0 && fallback === undefined) {
    // No proxies declared: the header is client-controlled, ignore it. All
    // such requests share ONE bucket — fail closed (a burst throttles
    // everyone rather than being escaped by header spoofing).
    return "untrusted-proxy";
  }
  return fallback ?? forwarded?.split(",")[0]?.trim() ?? undefined;
}

/**
 * Enforce a bucket for an authenticated principal (keyed by user id, not IP:
 * behind a corporate proxy every legitimate user shares one address).
 * Throws ApiError(429) with Retry-After when exceeded.
 */
export function enforceUserRateLimit(
  userId: string,
  bucketName: string,
  config: RateLimitConfig,
  now: number = Date.now(),
): void {
  const outcome = checkRateLimit(userId, "user", bucketName, config, now);
  if (!outcome.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `Too many requests — try again in ${outcome.retryAfterSeconds} second${outcome.retryAfterSeconds === 1 ? "" : "s"}.`,
      undefined,
      { "Retry-After": String(outcome.retryAfterSeconds) },
    );
  }
}

/** Per-endpoint buckets. Numbers follow the documented limits in the README. */
export const RATE_LIMITS = {
  /** Sign-in: 30 attempts / 10 min per client. */
  login: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** Sign-up: 10 / hour per client. */
  signup: { limit: 10, windowMs: 60 * 60 * 1000 },
  forgot: { limit: 5, windowMs: 10 * 60 * 1000 },
  resend: { limit: 5, windowMs: 10 * 60 * 1000 },
  reset: { limit: 5, windowMs: 10 * 60 * 1000 },
  verify: { limit: 20, windowMs: 10 * 60 * 1000 },
  /** Uploads: 60 / hour per client. */
  upload: { limit: 60, windowMs: 60 * 60 * 1000 },
  /**
   * Connector imports: 30 / hour per user. Each import opens a warehouse
   * connection, streams rows to disk and materializes a dataset — the most
   * expensive unauthenticated-adjacent operation in the app, and previously
   * unlimited.
   */
  connector_import: { limit: 30, windowMs: 60 * 60 * 1000 },
  /**
   * Connector connection tests: 60 / hour per user. A test opens a live
   * network connection to a Postgres/Snowflake/BigQuery host; without a limit
   * it is a trivial outbound-request amplifier against a third party.
   */
  connector_test: { limit: 60, windowMs: 60 * 60 * 1000 },
  /**
   * Public API (API-key surface): 600 / min per key. The public routes reuse
   * the per-key allowance on the key record, but the cheaper of the two wins,
   * so a misconfigured key with rateLimit=100000 cannot be used to hammer the
   * instance.
   */
  public_api: { limit: 600, windowMs: 60 * 1000 },
  /**
   * LLM code validation: 120 / min per user. Pure compute over submitted
   * source, reachable by any signed-in user — a tight enough cap to stop it
   * being used as a free parser/DoS amplifier without breaking the editor.
   */
  llm_validate: { limit: 120, windowMs: 60 * 1000 },
  /**
   * Model-backed generation (NL→code, chart recommendation): 20 / min per
   * user. Each call spends real provider budget, so this is deliberately as
   * tight as the copilot cap.
   */
  llm_generate: { limit: 20, windowMs: 60 * 1000 },
  /**
   * Client error reports: 60 / min per user. Generous enough that a page in a
   * render loop cannot lose its diagnostics, tight enough that the endpoint
   * cannot be used to flood the operator's error table.
   */
  error_report: { limit: 60, windowMs: 60 * 1000 },
  /**
   * Customer feedback: 20 / hour per user. One inbox entry is worth reading;
   * a script posting hundreds is not.
   */
  feedback: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Copilot questions: 20 / min per signed-in user (analysis-backed answers are not free). */
  copilot: { limit: 20, windowMs: 60 * 1000 },
  /**
   * Bookkeeping writes: 240 / min per signed-in user. Vouchers, closing
   * entries, adjustments and GST invoices are cheap individually, but bulk
   * backfills should not be able to saturate the database or the audit trail.
   */
  books_write: { limit: 240, windowMs: 60 * 1000 },
  /**
   * Notebook cell runs: 120 / min per user. Every run is server compute (an
   * optional Pyodide worker) and writes a version row, so it needs its own
   * bucket rather than sharing the general API allowance.
   */
  notebook_run: { limit: 120, windowMs: 60 * 1000 },
  /**
   * Reactive re-run plan lookups: 600 / min per user. A single parameter-cell
   * drag emits one plan request per change event, so this must clear ~10/s
   * sustained. It is a pure read (no dataset load, no execution) and is
   * deliberately NOT charged to `notebook_run`, so dragging a slider cannot
   * throttle the user out of the very cascade it triggered.
   */
  notebook_plan: { limit: 600, windowMs: 60 * 1000 },
  /**
   * Client portal sign-in links: 10 / hour per client. Sending a link costs an
   * email and is reachable without an account, so it needs a tight bucket.
   */
  portal_login: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** General API fallback. */
  api_general: { limit: 300, windowMs: 60 * 1000 },
} as const;

/** Back-compat alias for callers that referenced the bucket catalog by name. */
export const RATE_LIMIT_BUCKETS = RATE_LIMITS;

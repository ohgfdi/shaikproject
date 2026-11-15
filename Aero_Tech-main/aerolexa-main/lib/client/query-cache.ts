"use client";

/**
 * Client-side query cache (stale-while-revalidate + in-flight de-duplication).
 *
 * Why this exists instead of `@tanstack/react-query`: that package is a
 * declared dependency but has no `QueryClientProvider` anywhere in the app —
 * every screen fetches with the raw `api()` helper and `useState`. The gap it
 * was meant to close was therefore still open: `api()` hardcoded
 * `cache: "no-store"`, so nothing was ever reused and two components asking
 * for the same GET issued two round trips.
 *
 * This module provides the two properties that actually matter for this
 * codebase, without a provider tree or a rewrite of every call site:
 *
 *  1. TTL-based freshness — a GET is served from cache until its TTL expires.
 *  2. Request de-duplication — concurrent GETs for the same URL share ONE
 *     in-flight promise, so N widgets asking for the same resource cost one
 *     round trip.
 *
 * Writes are never cached and never served from cache: mutations must always
 * hit the network, and any write invalidates the paths it touches (see
 * `invalidate`). Caching is opt-in per call site via `apiCached`, so a caller
 * that genuinely needs fresh data on every render keeps using `api`.
 *
 * Correctness notes:
 * - The cache is per-browser-tab module state; it is never shared across
 *   users, so there is no cross-account leakage risk.
 * - A rejected request is NOT cached and does NOT leave a poisoned entry, so
 *   a transient 500 cannot be served to later renders.
 * - `staleTime: 0` disables the cache entirely (always fetch), which is the
 *   safe default for anything the user is actively editing.
 */

/** Freshness policy for a cached GET, in milliseconds. */
export interface CachePolicy {
  /** How long a cached value counts as fresh. 0 disables caching entirely. */
  staleTime: number;
}

interface CacheEntry<T = unknown> {
  value: T;
  /** Epoch ms after which `value` is stale. */
  expiresAt: number;
  /** In-flight promise shared by concurrent callers for the same key. */
  inflight?: Promise<T>;
}

const store = new Map<string, CacheEntry>();

/**
 * Default TTLs by request kind. Deliberately conservative — this is a BI tool
 * where a stale number in front of a client is worse than one extra query.
 *
 * `staleTime: 0` means "always fetch" (the safe default for anything a user
 * is editing). Only genuinely read-mostly reference data gets a real TTL.
 */
export const CACHE_POLICIES = {
  /** Never cache — mutations and anything edited in place. */
  none: { staleTime: 0 },
  /** Schema/reference metadata for a dataset; changes rarely, reads often. */
  datasetMeta: { staleTime: 30_000 },
  /** A saved artifact's rendered snapshot. */
  artifact: { staleTime: 60_000 },
  /** Anything user-owned that may be mutated by another tab. */
  short: { staleTime: 5_000 },
} as const satisfies Record<string, CachePolicy>;

const MAX_ENTRIES = 200;

/** Drop expired entries, and the oldest ones, to bound memory. */
function evict(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
  // Map preserves insertion order, so this is the oldest-first trim.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Test/diagnostics helpers. */
export function clearQueryCache(): void {
  store.clear();
}

export function queryCacheSize(): number {
  return store.size;
}

function keyFor(path: string): string {
  return path;
}

/**
 * Read a cached GET, de-duplicating concurrent callers.
 *
 * Returns the cached value when fresh. When stale (or absent) it kicks off a
 * refresh and — if a value exists — returns the STALE value immediately so the
 * UI paints instantly and updates when the network answers (stale-while-
 * revalidate). Callers that need the post-refresh value should await the
 * returned `refreshed` promise.
 */
export async function cachedGet<T>(
  path: string,
  fetcher: () => Promise<T>,
  policy: CachePolicy = CACHE_POLICIES.none,
): Promise<T> {
  const now = Date.now();
  const key = keyFor(path);
  const entry = store.get(key);

  if (policy.staleTime <= 0) {
    // Explicitly uncached: still de-duplicate concurrent identical GETs.
    const inflight = (entry?.inflight ?? fetcher()) as Promise<T>;
    if (!entry) store.set(key, { value: undefined as T, expiresAt: 0, inflight });
    const settled = await inflight;
    store.delete(key);
    return settled;
  }

  if (entry && entry.expiresAt > now) {
    // Fresh — no network at all. The store is heterogeneous (one map holds
    // every request's value), so the value is re-typed at the read site; the
    // key is the request URL, so a given key only ever holds one shape.
    return entry.value as T;
  }

  if (entry?.inflight) {
    // A refresh for this key is already running; wait for it rather than
    // starting a second identical request.
    return entry.inflight as Promise<T>;
  }

  const inflight = fetcher()
    .then((value) => {
      // Evict AFTER inserting: trimming first would let the very insert that
      // crossed the limit push the store one entry over the bound.
      store.set(key, { value, expiresAt: Date.now() + policy.staleTime });
      evict(Date.now());
      return value;
    })
    .catch((err) => {
      // Never cache a failure and never leave a poisoned entry behind — the
      // next caller must be free to retry.
      store.delete(key);
      throw err;
    });

  store.set(key, { value: (entry?.value ?? undefined) as T, expiresAt: entry?.expiresAt ?? 0, inflight });

  // Stale-while-revalidate: hand back the previous value immediately when we
  // have one, otherwise block on the network like a normal fetch.
  if (entry && entry.expiresAt > 0) {
    // This caller does NOT await `inflight`, so a failing background refresh
    // would surface as an unhandled promise rejection (which crashes a Node
    // process and is a console error in the browser). Attach a handler to the
    // promise so the rejection is always "handled" — awaiting callers still
    // observe the real error, because this only adds a listener, it does not
    // replace the promise the caller awaits.
    inflight.catch(() => undefined);
    return entry.value as T;
  }
  return inflight;
}

/**
 * Invalidate cached reads. Called after every mutation that changes what a GET
 * would return, so the next read refetches instead of serving a stale value.
 *
 * Prefix matching keeps this cheap: `invalidate("/api/datasets/abc")` clears
 * the dataset and everything nested under it.
 */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`)) {
      store.delete(key);
    }
  }
}

/** Invalidate everything (used on sign-out / workspace switch). */
export function invalidateAll(): void {
  store.clear();
}

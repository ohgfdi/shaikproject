/**
 * Client query cache (Phase 4.3).
 *
 * The two properties this cache must never lose:
 *  1. A fresh entry is served WITHOUT a network round trip.
 *  2. Concurrent identical GETs collapse into ONE request.
 *
 * And the three that make it safe to add to a BI tool where a stale number in
 * front of a client is worse than one extra query: a failed request is never
 * cached, a mutation invalidates what it changes, and the store is bounded.
 */
import {
  CACHE_POLICIES,
  cachedGet,
  clearQueryCache,
  invalidate,
  invalidateAll,
  queryCacheSize,
} from "@/lib/client/query-cache";

/**
 * A fetcher that counts calls. `calls` is exposed as a live getter so the
 * counter actually tracks invocations (assigning a snapshot would freeze it at
 * 0 and every assertion would silently pass/fail for the wrong reason).
 */
function fakeFetcher<T>(value: T, opts: { delayMs?: number } = {}) {
  let calls = 0;
  const fn = async (): Promise<T> => {
    calls += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return value;
  };
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn as typeof fn & { readonly calls: number };
}

const POLICY = { staleTime: 1_000 };

describe("query cache", () => {
  beforeEach(() => clearQueryCache());

  it("serves a fresh entry without hitting the network again", async () => {
    const fetch = fakeFetcher({ ok: true });
    await cachedGet("/a", fetch, POLICY);
    expect(fetch.calls).toBe(1);

    await cachedGet("/a", fetch, POLICY);
    await cachedGet("/a", fetch, POLICY);
    // One round trip for three reads — this is the whole point.
    expect(fetch.calls).toBe(1);
  });

  it("keeps different paths separate", async () => {
    const fetch = fakeFetcher("v");
    await cachedGet("/a", fetch, POLICY);
    await cachedGet("/b", fetch, POLICY);
    expect(fetch.calls).toBe(2);
  });

  it("de-duplicates CONCURRENT requests into a single fetch", async () => {
    const fetch = fakeFetcher({ value: 1 }, { delayMs: 20 });
    // Without in-flight sharing this is 5 requests; the cache makes it 1.
    const results = await Promise.all([
      cachedGet("/slow", fetch, POLICY),
      cachedGet("/slow", fetch, POLICY),
      cachedGet("/slow", fetch, POLICY),
      cachedGet("/slow", fetch, POLICY),
      cachedGet("/slow", fetch, POLICY),
    ]);
    expect(fetch.calls).toBe(1);
    for (const r of results) expect(r).toEqual({ value: 1 });
  });

  it("refetches once the TTL has expired", async () => {
    jest.useFakeTimers();
    try {
      const fetch = fakeFetcher("v", { delayMs: 0 });
      await cachedGet("/ttl", fetch, { staleTime: 1_000 });
      expect(fetch.calls).toBe(1);

      jest.advanceTimersByTime(1_001);
      await cachedGet("/ttl", fetch, { staleTime: 1_000 });
      expect(fetch.calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("staleTime 0 always fetches but still de-duplicates concurrent calls", async () => {
    const sequential = fakeFetcher("v", { delayMs: 0 });
    await cachedGet("/nocache", sequential, CACHE_POLICIES.none);
    await cachedGet("/nocache", sequential, CACHE_POLICIES.none);
    // Never cached ⇒ every call is a real request.
    expect(sequential.calls).toBe(2);

    const concurrent = fakeFetcher("v", { delayMs: 20 });
    await Promise.all([
      cachedGet("/nc2", concurrent, CACHE_POLICIES.none),
      cachedGet("/nc2", concurrent, CACHE_POLICIES.none),
    ]);
    expect(concurrent.calls).toBe(1);
  });

  it("never caches a rejection, and leaves no poisoned entry behind", async () => {
    const failing = async () => {
      throw new Error("boom");
    };
    await expect(cachedGet("/bad", failing, POLICY)).rejects.toThrow("boom");
    // A transient 500 must not be served to later renders.
    expect(queryCacheSize()).toBe(0);

    // The next caller must be free to retry and succeed.
    const ok = fakeFetcher("recovered");
    await expect(cachedGet("/bad", ok, POLICY)).resolves.toBe("recovered");
    expect(ok.calls).toBe(1);
  });

  it("a failing refresh does not destroy the last good value", async () => {
    const good = fakeFetcher("good");
    await cachedGet("/keep", good, POLICY);

    const failing = async () => {
      throw new Error("network down");
    };
    jest.useFakeTimers();
    try {
      jest.advanceTimersByTime(2_000);
      // Stale-while-revalidate returns the previous value immediately rather
      // than blanking the UI while the refresh fails.
      await expect(cachedGet("/keep", failing, POLICY)).resolves.toBe("good");
    } finally {
      jest.useRealTimers();
    }
  });

  it("invalidate() drops a prefix and everything nested under it", async () => {
    const fetch = fakeFetcher("v");
    await cachedGet("/api/datasets/abc", fetch, POLICY);
    await cachedGet("/api/datasets/abc/schema", fetch, POLICY);
    await cachedGet("/api/datasets/abc/rows", fetch, POLICY);
    expect(fetch.calls).toBe(3);

    // A write to the dataset must invalidate the dataset AND its children —
    // otherwise a schema/rows read could outlive the write.
    invalidate("/api/datasets/abc");

    const after = fakeFetcher("v");
    await cachedGet("/api/datasets/abc", after, POLICY);
    await cachedGet("/api/datasets/abc/schema", after, POLICY);
    await cachedGet("/api/datasets/abc/rows", after, POLICY);
    expect(after.calls).toBe(3);
  });

  it("invalidate() does not clobber a sibling that shares a string prefix", async () => {
    // "/api/datasets/abc" must not invalidate "/api/datasets/abcdef".
    const sibling = fakeFetcher("sibling");
    await cachedGet("/api/datasets/abcdef", sibling, POLICY);

    invalidate("/api/datasets/abc");

    const after = fakeFetcher("sibling");
    await cachedGet("/api/datasets/abcdef", after, POLICY);
    expect(after.calls).toBe(0); // still cached — not a false invalidation
  });

  it("invalidateAll() clears everything (sign-out / workspace switch)", async () => {
    const fetch = fakeFetcher("v");
    await cachedGet("/x", fetch, POLICY);
    await cachedGet("/y", fetch, POLICY);
    invalidateAll();
    expect(queryCacheSize()).toBe(0);

    const after = fakeFetcher("v");
    await cachedGet("/x", after, POLICY);
    expect(after.calls).toBe(1);
  });

  it("bounds the store so a long session cannot grow it without limit", async () => {
    for (let i = 0; i < 400; i++) {
      await cachedGet(`/key-${i}`, fakeFetcher(i), POLICY);
    }
    expect(queryCacheSize()).toBeLessThanOrEqual(200);
  });

  it("ships conservative defaults — read-mostly data is the only thing cached", () => {
    // A stale number in front of a client is worse than an extra query, so the
    // default policy must be "no cache".
    expect(CACHE_POLICIES.none.staleTime).toBe(0);
    for (const key of ["short", "datasetMeta", "artifact"] as const) {
      expect(CACHE_POLICIES[key].staleTime).toBeGreaterThan(0);
      // Nothing is kept for more than a minute.
      expect(CACHE_POLICIES[key].staleTime).toBeLessThanOrEqual(60_000);
    }
  });
});

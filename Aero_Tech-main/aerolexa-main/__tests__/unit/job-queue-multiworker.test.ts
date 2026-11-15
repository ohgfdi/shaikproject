/**
 * Multi-replica claim safety.
 *
 * `claimJobIds` is the shared rule behind `claimDueJobs`: the candidate list is
 * only a hint, and every claim must pass the store's atomic compare-and-swap.
 * Two workers can therefore see the same candidates and still never execute the
 * same job twice.
 */

import { claimJobIds, type JobClaimStore } from "@/lib/server/job-queue";

const NOW = new Date("2026-11-11T10:00:00.000Z");

/**
 * A store with the same semantics as the Prisma conditional UPDATE: a claim
 * flips pending → running once, and every later claim on that id returns false.
 * Each await yields, so two workers interleave exactly as two replicas would.
 */
function makeStore(ids: string[], candidateLimit = ids.length) {
  const pending = new Set(ids);
  let leaseChecks = 0;

  const store: JobClaimStore = {
    candidates: async (limit) => {
      await Promise.resolve();
      return ids.slice(0, Math.min(limit, candidateLimit));
    },
    claim: async (id, now, leaseUntil) => {
      await Promise.resolve();
      if (!pending.has(id)) return false;
      pending.delete(id);
      if (leaseUntil.getTime() <= now.getTime()) throw new Error("lease must be in the future");
      leaseChecks += 1;
      return true;
    },
  };

  return { store, pending, leaseChecks: () => leaseChecks };
}

describe("claimJobIds under two workers", () => {
  it("never lets two workers claim the same job", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { store, pending } = makeStore(ids);

    const [first, second] = await Promise.all([
      claimJobIds(store, 5, NOW),
      claimJobIds(store, 5, NOW),
    ]);

    const all = [...first, ...second];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(ids);
    expect(pending.size).toBe(0);
  });

  it("gives every job to exactly one of three workers", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `job-${index}`);
    const { store } = makeStore(ids);

    const results = await Promise.all([
      claimJobIds(store, 20, NOW),
      claimJobIds(store, 20, NOW),
      claimJobIds(store, 20, NOW),
    ]);

    const all = results.flat();
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
  });

  it("respects the batch limit per worker", async () => {
    const ids = ["a", "b", "c", "d"];
    const first = makeStore(ids);
    const claimed = await claimJobIds(first.store, 2, NOW);
    expect(claimed).toHaveLength(2);
    expect(first.pending.size).toBe(2);
  });

  it("skips a stale candidate instead of assuming it owns it", async () => {
    const ids = ["a", "b", "c"];
    const { store } = makeStore(ids);
    // Someone else claimed "b" between the candidate read and the CAS.
    const stale: JobClaimStore = {
      candidates:() => Promise.resolve(ids),
      claim: (id, now, lease) => (id === "b" ? Promise.resolve(false) : store.claim(id, now, lease)),
    };
    const claimed = await claimJobIds(stale, 3, NOW);
    expect(claimed).toEqual(["a", "c"]);
  });

  it("takes a lease in the future for every successful claim", async () => {
    const { store, leaseChecks } = makeStore(["a", "b"]);
    await claimJobIds(store, 2, NOW);
    expect(leaseChecks()).toBe(2);
  });
});

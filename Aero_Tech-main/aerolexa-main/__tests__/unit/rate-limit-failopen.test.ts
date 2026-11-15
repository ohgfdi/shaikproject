/**
 * Cross-replica rate limiting — fail-open behavior.
 *
 * The in-memory limiter always enforces its own budget, but the cluster merge
 * (replica-bus) is fire-and-forget and fails open when the shared ledger is
 * unreachable. That trade-off is intentional; these tests pin the two things
 * that must remain true:
 *   1. a ledger outage never throws or lets a replica's OWN budget be exceeded,
 *   2. the degradation is observable (a warning), and throttled (not once per
 *      request) so it cannot itself become a log flood.
 */

jest.mock("@/lib/db", () => ({
  prisma: {
    collaborativeUpdate: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { checkRateLimit, resetRateLimitStore } from "@/lib/server/rate-limit";

const findFirst = prisma.collaborativeUpdate.findFirst as unknown as jest.Mock;

describe("rate-limit fail-open", () => {
  beforeEach(() => {
    resetRateLimitStore();
    findFirst.mockReset();
  });

  it("enforces the per-replica budget and warns once when the shared ledger is down", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = { limit: 5, windowMs: 60_000 };
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit("u1", "user", "login", cfg).allowed).toBe(true);
      }
      // Local budget is still enforced even though the cluster ledger is down.
      expect(checkRateLimit("u1", "user", "login", cfg).allowed).toBe(false);

      await new Promise((resolve) => setImmediate(resolve));

      // Exactly one warning despite five reconciliation attempts (throttled).
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("cluster reconciliation failed");
    } finally {
      warn.mockRestore();
    }
  });
});

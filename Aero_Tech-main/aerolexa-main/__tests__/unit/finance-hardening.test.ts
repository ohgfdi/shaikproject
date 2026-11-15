/**
 * Finance write-path hardening (source-gated).
 *
 * These are the invariants the store layer now owns, asserted against the
 * source because the interesting cases need a real database (concurrent
 * approve/post, unique-index races). The unit suite pins the shape so a later
 * refactor cannot quietly drop the compare-and-swap back to a plain update.
 */

import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

describe("adjustment journals — atomic lifecycle", () => {
  const SRC = read("lib/server/adjustment-journals.ts");

  it("approve and post claim the row with a compare-and-swap inside a transaction", () => {
    expect(SRC).toContain("$transaction");
    expect(SRC).toContain("updateMany");
    expect(SRC).toContain("claimed.count !== 1");
    expect(SRC).toContain('status: "posting"');
  });

  it("post refuses a second winner instead of creating a second voucher", () => {
    expect(SRC).toContain("ALREADY_POSTED");
  });

  it("reversal is one transaction and refuses a double reversal", () => {
    expect(SRC).toContain("ALREADY_REVERSED");
    const reverse = SRC.split("export async function reverseAdjustmentJournal")[1] ?? "";
    expect((reverse.match(/\$transaction/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("never rounds money silently", () => {
    expect(SRC).not.toContain("Math.round");
  });
});

describe("closing entries — atomic lifecycle", () => {
  const SRC = read("lib/server/closing-entries.ts");

  it("approve and post claim the row with a compare-and-swap inside a transaction", () => {
    expect(SRC).toContain("$transaction");
    expect(SRC).toContain("updateMany");
    expect(SRC).toContain("claimed.count !== 1");
    expect(SRC).toContain('status: "posting"');
  });

  it("an edit re-validates that the new lines balance", () => {
    const update =
      SRC.split("export async function updateClosingEntry")[1]?.split("export async function approveClosingEntry")[0] ??
      "";
    expect(update).toContain("validateEntry");
    expect(update).toContain("UNBALANCED_ENTRY");
  });

  it("never rounds money silently", () => {
    expect(SRC).not.toContain("Math.round");
  });
});

describe("vouchers — validation and unique-index race", () => {
  const SRC = read("lib/server/books.ts");
  const ROUTE = read("app/api/books/[id]/vouchers/route.ts");

  it("the route validates the body with zod before the store sees it", () => {
    expect(ROUTE).toContain("postVoucherSchema.parse");
    expect(ROUTE).toContain("z.number().int(");
  });

  it("the unique voucher number is checked and enforced", () => {
    expect(SRC).toContain("tx.bookVoucher.findFirst");
    expect(SRC).toContain("DUPLICATE");
  });

  it("never rounds money silently", () => {
    expect(SRC).not.toContain("Math.round");
  });
});

describe("database errors are client-actionable, not 500s", () => {
  const SRC = read("lib/server/api.ts");

  it("maps Prisma constraint errors to 4xx", () => {
    expect(SRC).toContain("PrismaClientKnownRequestError");
    expect(SRC).toContain('"P2002"');
    expect(SRC).toContain('"P2025"');
    expect(SRC).toContain('"P2003"');
  });
});

describe("job queue idempotency survives a unique-index race", () => {
  const SRC = read("lib/server/job-queue.ts");

  it("treats a lost create race as a dedupe rather than a 500", () => {
    expect(SRC).toContain("P2002");
    expect(SRC).toContain("deduplicated: true");
  });
});

describe("webhook dedupe key is stable across retries", () => {
  const SRC = read("app/api/billing/webhook/route.ts");

  it("never falls back to a random key", () => {
    expect(SRC).not.toContain("randomUUID");
    expect(SRC).toContain("createHash");
    expect(SRC).toContain("sha256");
  });
});

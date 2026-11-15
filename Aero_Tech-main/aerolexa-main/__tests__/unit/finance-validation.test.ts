/**
 * Boundary validation for accounting writes.
 *
 * Money is integer minor units (paise) and dates are ISO `yyyy-mm-dd`. These
 * tests pin the two rules that used to be enforced by a silent `Math.round`
 * and a regex that accepted impossible dates: fractional paise and
 * `2026-02-31` are caller errors, never quietly normalised.
 */

import { ApiError } from "@/lib/auth/guard";
import { assertIsoDate, assertJournalLines, assertMinorUnits, isIsoDate } from "@/lib/server/finance-validation";

describe("isIsoDate / assertIsoDate", () => {
  it("accepts real calendar dates", () => {
    expect(isIsoDate("2025-04-01")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true); // leap day
    expect(isIsoDate("2026-12-31")).toBe(true);
  });

  it("rejects impossible or malformed dates", () => {
    expect(isIsoDate("2026-02-31")).toBe(false); // February has no 31st
    expect(isIsoDate("2025-13-01")).toBe(false);
    expect(isIsoDate("2025-00-10")).toBe(false);
    expect(isIsoDate("2025-4-01")).toBe(false); // not zero-padded
    expect(isIsoDate("01-04-2025")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20250401)).toBe(false);
  });

  it("throws a 400 VALIDATION ApiError naming the field", () => {
    try {
      assertIsoDate("2026-02-31", "Voucher date");
      throw new Error("expected assertIsoDate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 400, code: "VALIDATION" });
      expect((err as ApiError).message).toContain("Voucher date");
    }
  });
});

describe("assertMinorUnits", () => {
  it("accepts integer paise, including zero and negatives", () => {
    expect(() => assertMinorUnits(0, "amount")).not.toThrow();
    expect(() => assertMinorUnits(123, "amount")).not.toThrow();
    expect(() => assertMinorUnits(-50000, "amount")).not.toThrow();
  });

  it("rejects fractional paise instead of rounding them away", () => {
    expect(() => assertMinorUnits(1.5, "amount")).toThrow(ApiError);
    expect(() => assertMinorUnits(0.01, "amount")).toThrow(ApiError);
  });

  it("rejects NaN, Infinity and non-numbers", () => {
    expect(() => assertMinorUnits(Number.NaN, "amount")).toThrow(ApiError);
    expect(() => assertMinorUnits(Number.POSITIVE_INFINITY, "amount")).toThrow(ApiError);
    expect(() => assertMinorUnits("100" as unknown as number, "amount")).toThrow(ApiError);
    expect(() => assertMinorUnits(undefined, "amount")).toThrow(ApiError);
  });

  it("reports the offending label", () => {
    expect(() => assertMinorUnits(1.5, "openingBalance")).toThrow(/openingBalance/);
  });
});

describe("assertJournalLines", () => {
  it("accepts a well-formed two-sided entry", () => {
    expect(() =>
      assertJournalLines([
        { accountCode: "1000", amount: 50000 },
        { accountCode: "4000", amount: -50000, narration: "Sale" },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty or non-array payload", () => {
    expect(() => assertJournalLines([])).toThrow(ApiError);
    expect(() => assertJournalLines(undefined)).toThrow(ApiError);
    expect(() => assertJournalLines("1000")).toThrow(ApiError);
  });

  it("rejects a line without an account code", () => {
    expect(() => assertJournalLines([{ accountCode: "  ", amount: 1 }])).toThrow(/accountCode/);
    expect(() => assertJournalLines([{ accountCode: 1000, amount: 1 } as unknown])).toThrow(/accountCode/);
  });

  it("rejects a fractional amount before the engine sees it", () => {
    expect(() => assertJournalLines([{ accountCode: "1000", amount: 1.25 }])).toThrow(/amount/);
  });

  it("rejects null/primitive entries", () => {
    expect(() => assertJournalLines([null])).toThrow(ApiError);
    expect(() => assertJournalLines(["1000"])).toThrow(ApiError);
  });
});

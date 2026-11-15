/**
 * GSTR-9 engine — oracle tests.
 *
 * Hand-computed FY 2025-26 example. Pinned exactly below:
 *   - Table 9 outward roll-up across months
 *   - Table 4 net = availed − reversed per head
 *   - Table 8: 8C = 8A (2B) − 8B (availed) per head; reconciled only when
 *     every head is within the caller tolerance
 *   - 8D previous-FY claims surface a warning with the s16(4) note
 */

import { buildGstr9, type Gstr9TaxAmounts } from "@/lib/engine/gstr-9";
import { INR } from "@/lib/engine/india-tax";

const amounts = (over: Partial<Gstr9TaxAmounts> = {}): Gstr9TaxAmounts => ({
  taxableValue: 0,
  igst: 0,
  cgst: 0,
  sgst: 0,
  cess: 0,
  ...over,
});

const r = (minor: number) => minor / 100;

describe("buildGstr9", () => {
  const input = {
    fy: "2025-26",
    outward: [
      amounts({ taxableValue: INR(1000000), igst: INR(180000) }), // April
      amounts({ taxableValue: INR(500000), cgst: INR(45000), sgst: INR(45000) }), // May
    ],
    itcAvailed: [amounts({ igst: INR(90000) }), amounts({ cgst: INR(22500), sgst: INR(22500) })],
    itcReversed: [amounts({ igst: INR(5000) })],
    importsItc: amounts({ igst: INR(50000) }),
    rcm: [amounts({ taxableValue: INR(200000), igst: INR(36000) })],
    twoBAvailable: amounts({ igst: INR(100000), cgst: INR(22500), sgst: INR(22500) }),
    previousYearClaims: amounts({ igst: INR(3000) }),
  };

  it("rolls Table 9 outward up by head", () => {
    const res = buildGstr9(input);
    expect(r(res.table9Outward.taxableValue)).toBe(1500000);
    expect(r(res.table9Outward.igst)).toBe(180000);
    expect(r(res.table9Outward.cgst)).toBe(45000);
    expect(r(res.table9Outward.sgst)).toBe(45000);
  });

  it("nets Table 4 as availed − reversed per head", () => {
    const res = buildGstr9(input);
    expect(r(res.table4.availed.igst)).toBe(90000);
    expect(r(res.table4.availed.cgst)).toBe(22500);
    expect(r(res.table4.reversed.igst)).toBe(5000);
    expect(r(res.table4.net.igst)).toBe(85000);
    expect(r(res.table4.net.cgst)).toBe(22500);
  });

  it("carries Tables 5 and 6 through", () => {
    const res = buildGstr9(input);
    expect(r(res.table5Imports!.igst)).toBe(50000);
    expect(r(res.table6Rcm.taxableValue)).toBe(200000);
    expect(r(res.table6Rcm.igst)).toBe(36000);
  });

  it("computes Table 8C and flags the unreconciled difference", () => {
    const res = buildGstr9(input);
    const t8 = res.table8!;
    // 8A − 8B: igst 1,00,000 − 90,000 = 10,000; cgst/sgst 0.
    expect(r(t8.difference.igst)).toBe(10000);
    expect(r(t8.difference.cgst)).toBe(0);
    expect(t8.reconciled).toBe(false);
    expect(res.warnings.some((w) => w.includes("Table 8C"))).toBe(true);
  });

  it("reconciles when every head is within the caller tolerance", () => {
    const res = buildGstr9({ ...input, tolerance: INR(10000) });
    expect(res.table8!.reconciled).toBe(true);
  });

  it("surfaces 8D previous-FY claims with the s16(4) note", () => {
    const res = buildGstr9(input);
    expect(res.table8!.previousYearClaims.igst).toBe(INR(3000));
    expect(res.warnings.some((w) => w.includes("Table 8D") && w.includes("s16(4)"))).toBe(true);
  });

  it("skips Table 8 (with a warning) when no 2B figure is supplied", () => {
    const res = buildGstr9({ ...input, twoBAvailable: undefined, previousYearClaims: undefined });
    expect(res.table8).toBeNull();
    expect(res.warnings.some((w) => w.includes("Table 8 reconciliation was skipped"))).toBe(true);
  });

  it("rejects a malformed FY", () => {
    expect(() => buildGstr9({ ...input, fy: "2025/26" })).toThrow(/fy/);
  });
});

/**
 * gst-filing rupee→paise bridge — oracle tests.
 *
 * The gst-filing route takes money in RUPEES at the API boundary (like
 * app/api/ca/compute and app/api/gst/itc-recon) and must hand the integer-paise
 * GSTR-9 engine exact paise. These tests pin the conversion with hand-computed
 * numbers and prove the engine's output, not just the intermediate shape.
 */

import { toPaise, gstr9InputFromCampaign } from "@/lib/engine/gst-filing";
import { buildGstr9 } from "@/lib/engine/gstr-9";

describe("toPaise", () => {
  it("converts rupees to integer paise", () => {
    expect(toPaise(0)).toBe(0);
    expect(toPaise(0.01)).toBe(1);
    expect(toPaise(1)).toBe(100);
    expect(toPaise(100.5)).toBe(10050);
    expect(toPaise(1234.56)).toBe(123456);
  });

  it("rounds to the nearest paise", () => {
    expect(toPaise(0.015)).toBe(2);
    expect(toPaise(0.014)).toBe(1);
  });
});

describe("gstr9InputFromCampaign", () => {
  it("converts every caller-supplied rupee figure to paise and preserves array lengths", () => {
    const input = gstr9InputFromCampaign({
      bookId: "book-1",
      fy: "2025-26",
      gstin: "27AAPFU0939F1ZV",
      // Two outward periods, hand-computed: ₹1,000 @18% IGST and ₹2,000 intra @18%.
      monthlyOutward: [
        { month: "2025-04", taxableValue: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 },
        { month: "2025-05", taxableValue: 2000, igst: 0, cgst: 180, sgst: 180, cess: 0 },
      ],
      monthlyItcAvailed: [
        { month: "2025-04", igst: 100, cgst: 0, sgst: 0, cess: 0 },
        { month: "2025-05", igst: 0, cgst: 50, sgst: 50, cess: 0 },
      ],
      monthlyItcReversed: [{ month: "2025-05", igst: 20, cgst: 0, sgst: 0, cess: 0 }],
      importsItc: { igst: 30, cgst: 5, sgst: 5, cess: 1 },
      monthlyRcm: [{ month: "2025-06", igst: 10, cgst: 0, sgst: 0, cess: 0 }],
      twoBAvailable: { igst: 120, cgst: 45, sgst: 45, cess: 0 },
      previousYearClaims: { igst: 7, cgst: 0, sgst: 0, cess: 0 },
      tolerance: 0.01,
    });

    expect(input.fy).toBe("2025-26");
    expect(input.tolerance).toBe(1);

    // Outward → paise.
    expect(input.outward).toEqual([
      { taxableValue: 100_000, igst: 18_000, cgst: 0, sgst: 0, cess: 0 },
      { taxableValue: 200_000, igst: 0, cgst: 18_000, sgst: 18_000, cess: 0 },
    ]);
    // ITC availed carries a zero taxableValue (only the four tax heads apply).
    expect(input.itcAvailed).toEqual([
      { taxableValue: 0, igst: 10_000, cgst: 0, sgst: 0, cess: 0 },
      { taxableValue: 0, igst: 0, cgst: 5_000, sgst: 5_000, cess: 0 },
    ]);
    expect(input.itcReversed).toEqual([{ taxableValue: 0, igst: 2_000, cgst: 0, sgst: 0, cess: 0 }]);
    expect(input.importsItc).toEqual({ taxableValue: 0, igst: 3_000, cgst: 500, sgst: 500, cess: 100 });
    expect(input.rcm).toEqual([{ taxableValue: 0, igst: 1_000, cgst: 0, sgst: 0, cess: 0 }]);
    expect(input.twoBAvailable).toEqual({ taxableValue: 0, igst: 12_000, cgst: 4_500, sgst: 4_500, cess: 0 });
    expect(input.previousYearClaims).toEqual({ taxableValue: 0, igst: 700, cgst: 0, sgst: 0, cess: 0 });
  });

  it("omits optional heads when the caller does not supply them", () => {
    const input = gstr9InputFromCampaign({
      bookId: "book-1",
      fy: "2025-26",
      gstin: "27AAPFU0939F1ZV",
      monthlyOutward: [{ month: "2025-04", taxableValue: 100, igst: 18, cgst: 0, sgst: 0, cess: 0 }],
      monthlyItcAvailed: [{ month: "2025-04", igst: 18, cgst: 0, sgst: 0, cess: 0 }],
    });

    expect(input.itcReversed).toBeUndefined();
    expect(input.importsItc).toBeUndefined();
    expect(input.rcm).toBeUndefined();
    expect(input.twoBAvailable).toBeUndefined();
    expect(input.previousYearClaims).toBeUndefined();
    expect(input.tolerance).toBeUndefined();
  });

  it("drives buildGstr9 to the hand-computed paise totals (annual single-row form)", () => {
    // Annual figures entered once: outward ₹1,00,000 @IGST 18%, ITC availed
    // ₹5,000.50, 2B available ₹5,100. The engine must reconcile in paise.
    const result = buildGstr9(
      gstr9InputFromCampaign({
        bookId: "book-1",
        fy: "2025-26",
        gstin: "27AAPFU0939F1ZV",
        monthlyOutward: [{ month: "2025-26", taxableValue: 100_000, igst: 18_000, cgst: 0, sgst: 0, cess: 0 }],
        monthlyItcAvailed: [{ month: "2025-26", igst: 5_000.5, cgst: 0, sgst: 0, cess: 0 }],
        twoBAvailable: { igst: 5_100, cgst: 0, sgst: 0, cess: 0 },
      }),
    );

    expect(result.table9Outward.igst).toBe(1_800_000);
    expect(result.table9Outward.taxableValue).toBe(10_000_000);
    expect(result.table4.availed.igst).toBe(500_050);
    // 8C = 2B available − availed = 510000 − 500050 = 9950 paise (₹99.50).
    expect(result.table8?.difference.igst).toBe(9_950);
    expect(result.table8?.reconciled).toBe(false);
    expect(result.warnings.join(" ")).toContain("Table 8C");
  });
});

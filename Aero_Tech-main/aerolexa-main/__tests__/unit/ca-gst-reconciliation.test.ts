/**
 * GST computation and reconciliation engine — oracle tests.
 *
 * Every figure is hand-computed from a small integer ledger. The scenarios pin:
 *   - GSTR-1 grouping by tax rate (sorted ascending);
 *   - the place-of-supply split: same state → CGST + SGST, other state → IGST;
 *   - ITC split into reverse-charge vs normal inward, plus imports and cess;
 *   - rule 36(4): claimed ITC above the 2B-available figure is flagged;
 *   - the s.49A/49B set-off order (IGST first, then CGST, then SGST; cess
 *     ring-fenced).
 *
 * The GSTIN used starts with state code 27 (Maharashtra), so an outward row
 * with place "27" is intra-State and one with "29" is inter-State.
 */

import { computeGstReconciliation } from "@/lib/engine/ca-gst-reconciliation";

const base = {
  gstin: "27AAPFU0939F1ZV",
  period: "2025-04",
  outwardLedger: [] as { inv: string; taxable: number; taxRate: number; place: string; eway: boolean; cess?: number }[],
  inwardLedger: [] as {
    inv: string;
    taxable: number;
    taxRate: number;
    rcm: boolean;
    igst?: number;
    cgst?: number;
    sgst?: number;
    cess?: number;
  }[],
  imports: [] as { inv: string; taxable: number; igstRate: number; cess: number }[],
  openingIct: 0,
  availableIct2A2B: 0,
  reverseCharge: 0,
  cessLedger: [] as { inv: string; taxable: number; rate: number }[],
};

describe("computeGstReconciliation: GSTR-1 by rate", () => {
  it("groups outward supplies by tax rate and sorts the groups", () => {
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [
        { inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false },
        { inv: "O2", taxable: 200, taxRate: 5, place: "27", eway: false },
        { inv: "O3", taxable: 500, taxRate: 18, place: "29", eway: true },
      ],
    });

    expect(res.gstr1.byRate).toEqual([
      { heading: "5%", taxable: 200, tax: 10, cess: 0 },
      { heading: "18%", taxable: 1500, tax: 270, cess: 0 },
    ]);
    expect(res.gstr1.totalTaxable).toBe(1700);
    expect(res.gstr1.totalTax).toBe(280);
    expect(res.gstr1.totalCess).toBe(0);
  });

  it("splits intra-State supplies into CGST + SGST and inter-State into IGST", () => {
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [
        { inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false },
        { inv: "O2", taxable: 500, taxRate: 12, place: "29", eway: true },
      ],
    });
    // Intra: 180 → 90 + 90. Inter: 60 IGST.
    expect(res.liability.cgst).toBe(90);
    expect(res.liability.sgst).toBe(90);
    expect(res.liability.igst).toBe(60);
    expect(res.gstr3b.outwardTax).toBe(240); // 180 + 60
  });
});

describe("computeGstReconciliation: ITC and set-off", () => {
  it("separates reverse-charge from normal inward ITC and warns the RCM tax is payable in cash", () => {
    const res = computeGstReconciliation({
      ...base,
      inwardLedger: [
        { inv: "I1", taxable: 1000, taxRate: 18, rcm: true },
        { inv: "I2", taxable: 1000, taxRate: 18, rcm: false },
      ],
      availableIct2A2B: 360,
    });

    expect(res.gstr3b.iclClaimed).toBe(180); // reverse charge (4A)(3)
    expect(res.gstr3b.icgClaimed).toBe(180); // normal
    expect(res.gstr3b.reverseChargeTax).toBe(180); // derived from the RCM rows
    expect(res.ict.claimedIn3B).toBe(360);
    expect(res.ict.matched).toBe(360);
    expect(res.ict.unmatchedClaimed).toBe(0);
    expect(res.ict.unmatchedAvailable).toBe(0);
    expect(res.warnings.some((w) => w.includes("Reverse-charge tax is payable in cash"))).toBe(true);
  });

  it("nets import/cess ITC against the output cess liability", () => {
    const res = computeGstReconciliation({
      ...base,
      imports: [{ inv: "M1", taxable: 1000, igstRate: 18, cess: 50 }],
      cessLedger: [{ inv: "C1", taxable: 1000, rate: 10 }],
      availableIct2A2B: 180,
    });

    expect(res.gstr3b.cessPaidOnImports).toBe(50);
    expect(res.liability.cess).toBe(100); // cess ledger 10%
    expect(res.credit.cess).toBe(50); // import cess is ITC
    expect(res.payable.cess).toBe(50); // 100 − 50
    expect(res.payable.igst).toBe(0);
    expect(res.payable.total).toBe(50);
  });

  it("uses the s.49A order: IGST credit against IGST, then CGST, then SGST", () => {
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [{ inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false }],
      inwardLedger: [{ inv: "I1", taxable: 500, taxRate: 18, rcm: false }],
      openingIct: 100,
      availableIct2A2B: 200,
    });

    // Liability: CGST 90 + SGST 90. Credit: IGST 100 (opening) + CGST 45 + SGST 45.
    expect(res.liability.cgst).toBe(90);
    expect(res.liability.sgst).toBe(90);
    expect(res.credit.igst).toBe(100);
    // IGST credit clears CGST 90, leaves 10; that 10 then clears SGST 90 to 80.
    expect(res.payable.cgst).toBe(0);
    expect(res.payable.sgst).toBe(80 - 45); // SGST liability 80 after IGST credit, less SGST credit 45
    expect(res.payable.igst).toBe(0);
    expect(res.payable.total).toBe(35);
  });

  it("does not let CGST credit pay SGST (no cross-head use between the two)", () => {
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [{ inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false }],
      inwardLedger: [{ inv: "I1", taxable: 1000, taxRate: 18, rcm: false }],
      availableIct2A2B: 180,
    });
    // CGST liability 90 cleared by CGST credit 90; SGST liability 90 too → nil.
    expect(res.payable.total).toBe(0);
  });

  it("keeps cess credit ring-fenced from other heads", () => {
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [{ inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false }],
      inwardLedger: [{ inv: "I1", taxable: 1000, taxRate: 18, rcm: false, cess: 60 }],
      availableIct2A2B: 240,
    });
    // Cess credit of 60 cannot pay the (already cleared) GST; cess liability 0.
    expect(res.payable.cess).toBe(0);
    expect(res.payable.total).toBe(0);
  });
});

describe("computeGstReconciliation: 3B vs 2A/2B reconciliation", () => {
  it("matches the claimed ITC against 2A/2B and flags the difference", () => {
    // Opening ₹100 + normal inward ₹90 = ₹190 claimed. 2A/2B reflects ₹200.
    const res = computeGstReconciliation({
      ...base,
      outwardLedger: [{ inv: "O1", taxable: 1000, taxRate: 18, place: "27", eway: false }],
      inwardLedger: [{ inv: "I1", taxable: 500, taxRate: 18, rcm: false }],
      openingIct: 100,
      availableIct2A2B: 200,
    });

    expect(res.ict.claimedIn3B).toBe(190);
    expect(res.ict.matched).toBe(190);
    expect(res.ict.unmatchedClaimed).toBe(0);
    expect(res.ict.unmatchedAvailable).toBe(10);
    // Two distinct findings: the 2A/2B surplus, and the computed-vs-2B gap.
    expect(res.ict.mismatches).toHaveLength(2);
    expect(res.ict.mismatches.some((m) => m.includes("exceeds"))).toBe(true);
    expect(res.ict.mismatches.some((m) => m.includes("differ"))).toBe(true);
  });

  it("flags claimed ITC above 2A/2B as a rule 36(4) reversal", () => {
    // Opening ₹100, no inward, only ₹40 reflected in 2A/2B → ₹60 excess.
    const res = computeGstReconciliation({
      ...base,
      openingIct: 100,
      availableIct2A2B: 40,
    });

    expect(res.ict.claimedIn3B).toBe(100);
    expect(res.ict.matched).toBe(40);
    expect(res.ict.unmatchedClaimed).toBe(60);
    expect(res.ict.capApplied).toBe(true);
    expect(res.ict.capNote).toMatch(/rule 36\(4\)/i);
    expect(res.ict.capNote).toMatch(/reversed in 4\(B\)\(1\)/);
    expect(res.ict.mismatches.some((m) => m.includes("exceeds"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("verify eligibility"))).toBe(true);
  });

  it("uses a caller-supplied claimed figure when one is given", () => {
    const res = computeGstReconciliation({
      ...base,
      inwardLedger: [{ inv: "I1", taxable: 1000, taxRate: 18, rcm: false }],
      availableIct2A2B: 180,
      itcAvailedIn3b: 150,
    });
    expect(res.ict.claimedIn3B).toBe(150);
    expect(res.ict.unmatchedAvailable).toBe(30);
    expect(res.ict.capApplied).toBe(false);
  });
});

describe("computeGstReconciliation: reverse charge", () => {
  it("surfaces the supplied reverse-charge taxable value and derives the tax from the rows", () => {
    const res = computeGstReconciliation({
      ...base,
      reverseCharge: 300,
      inwardLedger: [{ inv: "R1", taxable: 300, taxRate: 18, rcm: true }],
      availableIct2A2B: 54,
    });

    expect(res.gstr3b.reverseChargeTaxable).toBe(300);
    expect(res.gstr3b.reverseChargeTax).toBe(54);
    // RCM liability and credit are equal, so the cash payable is nil.
    expect(res.liability.cgst).toBe(27);
    expect(res.credit.cgst).toBe(27);
    expect(res.payable.total).toBe(0);
  });
});

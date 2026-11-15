/**
 * GSTR-2B ITC reconciliation — oracle tests.
 *
 * Hand-computed. The rules pinned exactly below:
 *   - s16(2)(aa): a books-only invoice NEVER enters 4(A); it is held in
 *     pending2b until it appears in 2B.
 *   - s17(5) blocked credits and s16(4) expired credits stay out of 4(A).
 *   - rule 37 (supplier has not filed) stays out of 4(A).
 *   - 4(C) net = 4(A) + RCM − 4(B) per tax head.
 *   - CRN rows net against 4(A) (credit notes reduce ITC).
 */

import {
  BLOCKED_ITC_LABELS,
  ineligibleItc,
  matchKey,
  reconcileItc,
  s16Deadline,
  type Gstr2bRow,
  type PurchaseRow,
} from "@/lib/engine/gstr-2b-itc";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

const AS_OF = "2025-05-15";

/** A 2B row helper — intra-state 18% default, overridable. */
const twoB = (over: Partial<Gstr2bRow> & Pick<Gstr2bRow, "gstin" | "invoiceNumber" | "invoiceDate">): Gstr2bRow => ({
  taxableValue: INR(100000),
  igst: 0,
  cgst: INR(9000),
  sgst: INR(9000),
  cess: 0,
  placeOfSupply: "27",
  ...over,
});

const purchase = (
  over: Partial<PurchaseRow> & Pick<PurchaseRow, "gstin" | "invoiceNumber" | "invoiceDate">,
): PurchaseRow => ({
  taxableValue: INR(100000),
  igst: 0,
  cgst: INR(9000),
  sgst: INR(9000),
  cess: 0,
  placeOfSupply: "27",
  ...over,
});

describe("s16(4) deadline", () => {
  it("is 30 November following the financial year of the invoice", () => {
    expect(s16Deadline("2025-04-10")).toBe("2026-11-30"); // FY 2025-26 ends Mar 2026
    expect(s16Deadline("2025-01-10")).toBe("2025-11-30"); // FY 2024-25 ends Mar 2025
    expect(s16Deadline("2024-12-31")).toBe("2025-11-30"); // FY 2024-25
  });
});

describe("match key", () => {
  it("normalises GSTIN and document number case", () => {
    expect(matchKey("27aapfu0939f1zv", "inv-1", "CRN")).toBe("27AAPFU0939F1ZV|INV-1|CRN");
  });
});

describe("reconcileItc — verdicts", () => {
  const purchases: PurchaseRow[] = [
    purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-1", invoiceDate: "2025-04-01" }),
    purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-2", invoiceDate: "2025-04-02" }), // books only
    purchase({
      gstin: "29AABCU9603R1ZM",
      invoiceNumber: "INV-4",
      invoiceDate: "2025-04-04",
      blockedCategory: "food-and-beverages",
      igst: INR(18000),
      cgst: 0,
      sgst: 0,
      placeOfSupply: "29",
    }),
    purchase({ gstin: "29AABCU9603R1ZM", invoiceNumber: "INV-5", invoiceDate: "2025-04-05" }),
    purchase({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "INV-6",
      invoiceDate: "2025-04-06",
      reverseCharge: true,
      igst: INR(9000),
      cgst: 0,
      sgst: 0,
    }),
    purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-7", invoiceDate: "2022-04-10" }), // s16(4) expired
    purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-8", invoiceDate: "2025-04-08" }), // amount mismatch
    purchase({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "CN-1",
      invoiceDate: "2025-04-09",
      docType: "CRN",
      taxableValue: INR(-10000),
      cgst: INR(-900),
      sgst: INR(-900),
    }),
  ];

  const twoBrows: Gstr2bRow[] = [
    twoB({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-1", invoiceDate: "2025-04-01" }),
    twoB({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-3", invoiceDate: "2025-04-03" }), // 2B only
    twoB({
      gstin: "29AABCU9603R1ZM",
      invoiceNumber: "INV-4",
      invoiceDate: "2025-04-04",
      igst: INR(18000),
      cgst: 0,
      sgst: 0,
    }),
    twoB({ gstin: "29AABCU9603R1ZM", invoiceNumber: "INV-5", invoiceDate: "2025-04-05", supplierFiledGstr1: false }),
    twoB({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "INV-6",
      invoiceDate: "2025-04-06",
      reverseCharge: true,
      igst: INR(9000),
      cgst: 0,
      sgst: 0,
    }),
    twoB({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "INV-7", invoiceDate: "2022-04-10" }),
    twoB({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "INV-8",
      invoiceDate: "2025-04-08",
      cgst: INR(9500),
      sgst: INR(9500),
    }),
    twoB({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "CN-1",
      invoiceDate: "2025-04-09",
      docType: "CRN",
      taxableValue: INR(-10000),
      cgst: INR(-900),
      sgst: INR(-900),
    }),
  ];

  const recon = reconcileItc({ twoB: twoBrows, purchases, asOfDate: AS_OF });

  const verdictOf = (invoiceNumber: string) => recon.invoices.find((i) => i.invoiceNumber === invoiceNumber)?.verdict;

  it("classifies each invoice into exactly one verdict", () => {
    expect(verdictOf("INV-1")).toBe("matched-eligible");
    expect(verdictOf("INV-2")).toBe("in-books-only");
    expect(verdictOf("INV-3")).toBe("in-2b-only");
    expect(verdictOf("INV-4")).toBe("matched-blocked");
    expect(verdictOf("INV-5")).toBe("matched-rule37");
    expect(verdictOf("INV-6")).toBe("matched-eligible-rcm");
    expect(verdictOf("INV-7")).toBe("matched-expired-s16");
    expect(verdictOf("INV-8")).toBe("amount-mismatch");
    expect(verdictOf("CN-1")).toBe("matched-eligible");
  });

  it("counts every verdict", () => {
    expect(recon.counts["matched-eligible"]).toBe(2); // INV-1 + CN-1
    expect(recon.counts["in-books-only"]).toBe(1);
    expect(recon.counts["in-2b-only"]).toBe(1);
    expect(recon.counts["matched-blocked"]).toBe(1);
    expect(recon.counts["matched-rule37"]).toBe(1);
    expect(recon.counts["matched-eligible-rcm"]).toBe(1);
    expect(recon.counts["matched-expired-s16"]).toBe(1);
    expect(recon.counts["amount-mismatch"]).toBe(1);
  });

  it("labels the blocked category", () => {
    const blocked = recon.invoices.find((i) => i.invoiceNumber === "INV-4")!;
    expect(blocked.blockedLabel).toBe(BLOCKED_ITC_LABELS["food-and-beverages"]);
    expect(blocked.reasons.join(" ")).toContain("s17(5)");
  });

  it("measures the amount difference and keeps the mismatch out of 4(A)", () => {
    const mismatch = recon.invoices.find((i) => i.invoiceNumber === "INV-8")!;
    expect(r(mismatch.taxDifference)).toBe(1000); // ₹500 CGST + ₹500 SGST
  });

  it("holds books-only credit in pending2b and NEVER in 4(A)", () => {
    const t4 = recon.table4;
    expect(r(t4.pending2b.cgst)).toBe(9000);
    expect(r(t4.pending2b.sgst)).toBe(9000);
    // 4(A) contains INV-1 (9,000 + 9,000) and CN-1 (−900 − 900) only.
    expect(r(t4.itcAvailed.cgst)).toBe(8100);
    expect(r(t4.itcAvailed.sgst)).toBe(8100);
    expect(r(t4.itcAvailed.igst)).toBe(0);
    expect(r(t4.itcAvailed.taxableValue)).toBe(90000); // 1,00,000 − 10,000
  });

  it("puts reverse-charge credit in 4(A)(3), not 4(A)", () => {
    expect(r(recon.table4.itcAvailedRcm.igst)).toBe(9000);
    expect(r(recon.table4.itcAvailed.igst)).toBe(0);
  });

  it("keeps 4(C) net = 4(A) + RCM − 4(B) per head", () => {
    const t4 = recon.table4;
    expect(r(t4.netItc.igst)).toBe(9000); // 0 + 9,000 − 0
    expect(r(t4.netItc.cgst)).toBe(8100);
    expect(r(t4.netItc.sgst)).toBe(8100);
    expect(t4.rule364Excess).toBe(0);
  });

  it("reports ineligible ITC (s17(5) + s16(4)) for 4(B)(2)", () => {
    const inelig = ineligibleItc(recon);
    expect(r(inelig.igst)).toBe(18000); // INV-4 (inter-state blocked)
    expect(r(inelig.cgst)).toBe(9000); // INV-7 (expired, intra-state)
    expect(r(inelig.sgst)).toBe(9000);
  });

  it("emits warnings and methodology", () => {
    expect(recon.warnings.some((w) => w.includes("INV-2"))).toBe(true);
    expect(recon.methodology.length).toBeGreaterThanOrEqual(4);
  });
});

describe("reconcileItc — tolerance and duplicates", () => {
  it("accepts a difference within the caller tolerance", () => {
    const recon = reconcileItc({
      twoB: [twoB({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "A-1", invoiceDate: "2025-04-01" })],
      purchases: [
        purchase({
          gstin: "27AAPFU0939F1ZV",
          invoiceNumber: "A-1",
          invoiceDate: "2025-04-01",
          cgst: INR(9001),
          sgst: INR(9001),
        }),
      ],
      asOfDate: AS_OF,
      tolerance: INR(2),
    });
    expect(recon.invoices[0]!.verdict).toBe("matched-eligible");
  });

  it("rejects a malformed as-of date", () => {
    expect(() => reconcileItc({ twoB: [], purchases: [], asOfDate: "15-05-2025" })).toThrow(/asOfDate/);
  });

  it("matches duplicate document numbers one-for-one, leaving the extra as in-books-only", () => {
    const recon = reconcileItc({
      twoB: [twoB({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "DUP-1", invoiceDate: "2025-04-01" })],
      purchases: [
        purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "DUP-1", invoiceDate: "2025-04-01" }),
        purchase({ gstin: "27AAPFU0939F1ZV", invoiceNumber: "DUP-1", invoiceDate: "2025-04-01" }),
      ],
      asOfDate: AS_OF,
    });
    expect(recon.counts["matched-eligible"]).toBe(1);
    expect(recon.counts["in-books-only"]).toBe(1);
  });
});

describe("reconcileItc — rule 36(4), credit notes and head shifts", () => {
  const key = { gstin: "27AAPFU0939F1ZV", invoiceDate: "2025-04-01" };

  it("reverses the ITC availed above the 2B-eligible figure (rule 36(4))", () => {
    const recon = reconcileItc({
      twoB: [twoB({ ...key, invoiceNumber: "A-1" })],
      purchases: [purchase({ ...key, invoiceNumber: "A-1" })],
      asOfDate: AS_OF,
      // The return claimed 12,000 + 12,000 against 9,000 + 9,000 available.
      itcAvailedInTable4A: { taxableValue: INR(100000), igst: 0, cgst: INR(12000), sgst: INR(12000), cess: 0 },
    });
    expect(r(recon.table4.rule364Excess)).toBe(6000); // 3,000 CGST + 3,000 SGST
    expect(r(recon.table4.itcReversed.cgst)).toBe(3000);
    expect(r(recon.table4.itcReversed.sgst)).toBe(3000);
    // 4(C) settles back to the eligible credit.
    expect(r(recon.table4.netItc.cgst)).toBe(9000);
    expect(r(recon.table4.netItc.sgst)).toBe(9000);
    expect(recon.warnings.some((w) => w.includes("rule 36(4)"))).toBe(true);
  });

  it("treats a positive-amounted credit note as a reduction of ITC", () => {
    const recon = reconcileItc({
      twoB: [
        twoB({ ...key, invoiceNumber: "A-1" }),
        twoB({ ...key, invoiceNumber: "CN-9", docType: "CRN", taxableValue: INR(10000), cgst: INR(900), sgst: INR(900) }),
      ],
      purchases: [
        purchase({ ...key, invoiceNumber: "A-1" }),
        purchase({
          ...key,
          invoiceNumber: "CN-9",
          docType: "CRN",
          taxableValue: INR(10000),
          cgst: INR(900),
          sgst: INR(900),
        }),
      ],
      asOfDate: AS_OF,
    });
    expect(r(recon.table4.itcAvailed.cgst)).toBe(8100); // 9,000 − 900
    expect(r(recon.table4.itcAvailed.sgst)).toBe(8100);
    expect(r(recon.table4.itcAvailed.taxableValue)).toBe(90000);
  });

  it("flags a CGST/SGST ↔ IGST head shift even when the total tax agrees", () => {
    const recon = reconcileItc({
      twoB: [
        twoB({
          gstin: "29AABCU9603R1ZM",
          invoiceNumber: "B-1",
          invoiceDate: "2025-04-01",
          igst: INR(18000),
          cgst: 0,
          sgst: 0,
          placeOfSupply: "29",
        }),
      ],
      purchases: [
        purchase({
          gstin: "29AABCU9603R1ZM",
          invoiceNumber: "B-1",
          invoiceDate: "2025-04-01",
          igst: 0,
          cgst: INR(9000),
          sgst: INR(9000),
          placeOfSupply: "29",
        }),
      ],
      asOfDate: AS_OF,
    });
    const inv = recon.invoices[0]!;
    expect(inv.verdict).toBe("amount-mismatch");
    expect(r(inv.taxDifference)).toBe(36000); // 18,000 IGST + 9,000 + 9,000 shifted
    expect(inv.reasons.join(" ")).toMatch(/heads/i);
  });

  it("treats a 2B row marked ITC-not-available as blocked", () => {
    const recon = reconcileItc({
      twoB: [twoB({ ...key, invoiceNumber: "C-1", itcAvailable: false })],
      purchases: [purchase({ ...key, invoiceNumber: "C-1" })],
      asOfDate: AS_OF,
    });
    expect(recon.invoices[0]!.verdict).toBe("matched-blocked");
    expect(recon.invoices[0]!.reasons.join(" ")).toMatch(/NOT available/i);
    expect(r(recon.table4.itcAvailed.cgst)).toBe(0);
  });
});

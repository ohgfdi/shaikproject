/**
 * GST returns engine — oracle tests.
 *
 * Hand-computed. The B2CL classification (inter-state B2C above ₹2.5L is
 * invoice-wise, not consolidated) and the intra-state CGST/SGST split are the
 * rules pinned exactly below.
 */

import {
  buildEInvoicePayload,
  buildGstr1Summary,
  gstInterest,
  gstLateFee,
  reconcileGstr3bWithGstr1,
  validateEInvoice,
  type Gstr1Invoice,
} from "@/lib/engine/gst-returns";
import { INR } from "@/lib/engine/india-tax";

const r = (minor: number) => minor / 100;

describe("GSTR-1 summary", () => {
  const invoices: Gstr1Invoice[] = [
    {
      invoiceNumber: "B1",
      date: "2025-04-01",
      buyerGstin: "27AAPFU0939F1ZV",
      placeOfSupply: "27",
      supplyType: "b2b",
      interState: false,
      taxableValue: INR(100000),
      ratePct: 18,
      hsn: "1001",
    },
    {
      invoiceNumber: "B2",
      date: "2025-04-02",
      buyerGstin: "29AABCU9603R1ZM",
      placeOfSupply: "29",
      supplyType: "b2b",
      interState: true,
      taxableValue: INR(100000),
      ratePct: 18,
      hsn: "1001",
    },
    {
      invoiceNumber: "B3",
      date: "2025-04-03",
      buyerGstin: "27AAPFU0939F1ZV",
      placeOfSupply: "27",
      supplyType: "b2b",
      interState: false,
      taxableValue: INR(100000),
      ratePct: 18,
      hsn: "1001",
    },
    {
      invoiceNumber: "C1",
      date: "2025-04-04",
      buyerGstin: null,
      placeOfSupply: "29",
      supplyType: "b2c",
      interState: true,
      taxableValue: INR(300000),
      ratePct: 18,
      hsn: "1001",
    },
    {
      invoiceNumber: "C2",
      date: "2025-04-05",
      buyerGstin: null,
      placeOfSupply: "27",
      supplyType: "b2c",
      interState: false,
      taxableValue: INR(1000),
      ratePct: 18,
      hsn: "1001",
    },
    {
      invoiceNumber: "E1",
      date: "2025-04-06",
      buyerGstin: null,
      placeOfSupply: "99",
      supplyType: "export-without-payment",
      interState: true,
      taxableValue: INR(50000),
      ratePct: 0,
      hsn: "1001",
    },
    {
      invoiceNumber: "N1",
      date: "2025-04-07",
      buyerGstin: null,
      placeOfSupply: "27",
      supplyType: "nil-rated",
      interState: false,
      taxableValue: INR(20000),
      ratePct: 0,
      hsn: "1001",
    },
  ];

  it("classifies B2B, B2CL, B2CS, exports and nil separately", () => {
    const s = buildGstr1Summary(invoices);
    expect(r(s.b2b.taxableValue)).toBe(300000);
    expect(r(s.b2b.tax)).toBe(54000); // 3 × 18,000
    expect(r(s.b2cl.taxableValue)).toBe(300000); // inter-state B2C > ₹2.5L, invoice-wise
    expect(r(s.b2cs.taxableValue)).toBe(1000); // small B2C, consolidated
    expect(r(s.exportsWithoutPayment.taxableValue)).toBe(50000);
    expect(r(s.nilExempt.taxableValue)).toBe(20000);
  });

  it("totals taxable value and tax across all buckets", () => {
    const s = buildGstr1Summary(invoices);
    expect(r(s.totals.taxableValue)).toBe(671000);
    expect(r(s.totals.tax)).toBe(108180); // 54,000 + 54,000 + 180
  });

  it("groups tax by rate", () => {
    const s = buildGstr1Summary(invoices);
    const eighteen = s.byRate.find((x) => x.ratePct === 18)!;
    expect(r(eighteen.taxableValue)).toBe(601000);
    expect(r(eighteen.tax)).toBe(108180);
  });

  it("accepts a caller-supplied B2CL threshold", () => {
    const s = buildGstr1Summary(invoices, { b2clThreshold: INR(500000) });
    // With a ₹5L threshold the ₹3.54L invoice falls back into B2CS.
    expect(s.b2cl.count).toBe(0);
    expect(r(s.b2cs.taxableValue)).toBe(301000);
  });

  it("reports intra-State B2C above ₹2.5L in B2CL under the current Table 5A", () => {
    const s = buildGstr1Summary([
      {
        invoiceNumber: "L1",
        date: "2025-04-08",
        buyerGstin: null,
        placeOfSupply: "27",
        supplyType: "b2c",
        interState: false,
        taxableValue: INR(300000),
        ratePct: 18,
        hsn: "1001",
      },
    ]);
    expect(s.b2cl.count).toBe(1);
    expect(s.b2cs.count).toBe(0);

    // The legacy inter-State-only rule is still available for older periods.
    const legacy = buildGstr1Summary(
      [
        {
          invoiceNumber: "L1",
          date: "2020-04-08",
          buyerGstin: null,
          placeOfSupply: "27",
          supplyType: "b2c",
          interState: false,
          taxableValue: INR(300000),
          ratePct: 18,
          hsn: "1001",
        },
      ],
      { b2clIncludesIntraState: false },
    );
    expect(legacy.b2cs.count).toBe(1);
  });

  it("charges no tax on exempt / LUT export supplies even if a rate is stamped", () => {
    const s = buildGstr1Summary([
      {
        invoiceNumber: "X1",
        date: "2025-04-09",
        buyerGstin: null,
        placeOfSupply: "99",
        supplyType: "export-without-payment",
        interState: true,
        taxableValue: INR(100000),
        ratePct: 18, // stamped on the invoice, but LUT export is zero-rated
        hsn: "1001",
      },
      {
        invoiceNumber: "X2",
        date: "2025-04-10",
        buyerGstin: null,
        placeOfSupply: "27",
        supplyType: "exempt",
        interState: false,
        taxableValue: INR(50000),
        ratePct: 18,
        hsn: "1001",
      },
    ]);
    expect(s.totals.tax).toBe(0);
    expect(s.exportsWithoutPayment.tax).toBe(0);
    expect(s.nilExempt.tax).toBe(0);
  });
});

describe("GSTR-3B ↔ GSTR-1 reconciliation", () => {
  it("reconciles within a rupee tolerance", () => {
    const res = reconcileGstr3bWithGstr1({
      gstr1Taxable: INR(671000),
      gstr1Tax: INR(108180),
      gstr3bTaxable: INR(671000),
      gstr3bTax: INR(108180.5),
    });
    expect(res.reconciled).toBe(true);
  });

  it("flags a real mismatch", () => {
    const res = reconcileGstr3bWithGstr1({
      gstr1Taxable: INR(671000),
      gstr1Tax: INR(108180),
      gstr3bTaxable: INR(671000),
      gstr3bTax: INR(100000),
    });
    expect(res.reconciled).toBe(false);
    expect(r(res.taxDifference)).toBe(8180);
  });
});

describe("interest and late fee", () => {
  it("computes interest u/s 50 pro-rated by days", () => {
    const res = gstInterest({ taxAmount: INR(100000), fromDate: "2025-04-21", toDate: "2025-05-21" });
    expect(res.days).toBe(30);
    expect(r(res.interest)).toBeCloseTo(1479.45, 2); // 1,00,000 × 18% × 30/365
  });

  it("charges ₹50/day normally and ₹20/day for NIL", () => {
    expect(r(gstLateFee({ days: 10 }).lateFee)).toBe(500);
    expect(r(gstLateFee({ days: 10, isNil: true }).lateFee)).toBe(200);
    expect(r(gstLateFee({ days: 100, cap: INR(2000) }).lateFee)).toBe(2000);
  });

  it("applies the statutory ceilings per return by default", () => {
    // 200 days × ₹50 = ₹10,000, but s.47 caps a normal return at ₹5,000.
    const normal = gstLateFee({ days: 200 });
    expect(r(normal.lateFee)).toBe(5_000);
    expect(normal.capped).toBe(true);
    // NIL return: 100 days × ₹20 = ₹2,000, capped at ₹500.
    expect(r(gstLateFee({ days: 100, isNil: true }).lateFee)).toBe(500);
  });

  it("applies the small-taxpayer concession (₹25/day, ₹1,000 cap)", () => {
    const small = gstLateFee({ days: 100, smallTaxpayer: true });
    expect(r(small.perDay)).toBe(25);
    expect(r(small.lateFee)).toBe(1_000); // 2,500 capped
    expect(r(gstLateFee({ days: 10, isNil: true, smallTaxpayer: true }).lateFee)).toBe(100);
  });

  it("excludes the ITC-paid portion from the s.50 interest base (Rule 88B)", () => {
    const res = gstInterest({
      taxAmount: INR(100000),
      itcUtilised: INR(60000),
      fromDate: "2025-04-21",
      toDate: "2025-05-21",
    });
    expect(r(res.interestBase)).toBe(40_000);
    expect(r(res.interest)).toBeCloseTo(591.78, 2); // 40,000 × 18% × 30/365
  });
});

describe("e-invoice payload", () => {
  const base = {
    invoiceNumber: "INV-001",
    date: "2025-04-01",
    seller: { gstin: "27AAPFU0939F1ZV", name: "Seller Pvt Ltd", location: "Mumbai", stateCode: "27" },
    buyer: { gstin: "29AABCU9603R1ZM", name: "Buyer Pvt Ltd", placeOfSupply: "29", stateCode: "29" },
    items: [{ hsn: "1001", taxableValue: INR(100000), ratePct: 18 }],
  };

  it("splits CGST/SGST for intra-state supplies", () => {
    const payload = buildEInvoicePayload({
      ...base,
      buyer: { gstin: "27AABCU9603R1ZM", name: "Buyer", placeOfSupply: "27", stateCode: "27" },
    });
    expect(r(payload.ValDtls.CgstVal!)).toBe(9000);
    expect(r(payload.ValDtls.SgstVal!)).toBe(9000);
    expect(payload.ValDtls.IgstVal).toBe(0);
    expect(r(payload.ValDtls.TotInvVal)).toBe(118000);
  });

  it("uses IGST for inter-state supplies", () => {
    const payload = buildEInvoicePayload(base);
    expect(r(payload.ValDtls.IgstVal!)).toBe(18000);
    expect(r(payload.ValDtls.TotInvVal)).toBe(118000);
    expect(validateEInvoice(payload).valid).toBe(true);
  });

  it("validates a malformed seller GSTIN and a total mismatch", () => {
    const payload = buildEInvoicePayload(base);
    payload.SellerDtls.Gstin = "BAD";
    payload.ValDtls.TotInvVal = INR(1);
    const res = validateEInvoice(payload);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/Seller GSTIN/);
    expect(res.errors.join(" ")).toMatch(/does not equal/);
  });

  it("rejects a non-notified GST rate", () => {
    const payload = buildEInvoicePayload({ ...base, items: [{ hsn: "1001", taxableValue: INR(100000), ratePct: 17 }] });
    const res = validateEInvoice(payload);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/notified rate/);
  });
});

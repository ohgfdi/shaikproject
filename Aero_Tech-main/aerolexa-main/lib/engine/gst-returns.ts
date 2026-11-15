/**
 * GST returns engine — GSTR-1 summary, GSTR-3B ↔ GSTR-1 reconciliation,
 * e-invoice payload build/validation, and interest u/s 50 + late fee.
 *
 * `ca-india.ts` computes the GSTR-3B-shaped liability from a ledger. This
 * module is the RETURN layer above it: it classifies outward supplies into the
 * GSTR-1 buckets the portal expects, reconciles the two returns, and checks an
 * e-invoice before it is handed to the IRP.
 *
 * SCOPE AND HONESTY — as in `ca-india.ts`:
 *
 *   This PREPARES the return figures and validates the payload. It does NOT
 *   talk to the GST portal, does not generate an IRN (that is a signed hash the
 *   IRP issues), and does not file. Thresholds and rates are DATA supplied by
 *   the caller; the defaults are labelled, so a rate or threshold change is the
 *   caller's to own rather than a silent wrong return.
 *
 * Money is in MINOR UNITS (paise) as integers, matching the CA engines.
 */

import { INR, formatInr } from "./india-tax";

export class GstReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GstReturnError";
  }
}

/** GST tax on a taxable value, rounded once to the nearest paise. */
export function gstTax(taxableValue: number, ratePct: number): number {
  return Math.round((taxableValue * ratePct) / 100);
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin);
}
/** State code is the first two digits of a GSTIN. */
export function gstinStateCode(gstin: string): string | null {
  return GSTIN_RE.test(gstin) ? gstin.slice(0, 2) : null;
}

// ---------------------------------------------------------------------------
// GSTR-1 summary
// ---------------------------------------------------------------------------

export type Gstr1SupplyType = "b2b" | "b2c" | "export-with-payment" | "export-without-payment" | "nil-rated" | "exempt";

export interface Gstr1Invoice {
  invoiceNumber: string;
  date: string;
  /** Buyer GSTIN; null for B2C. */
  buyerGstin?: string | null;
  /** Place of supply, 2-digit state code. */
  placeOfSupply: string;
  supplyType: Gstr1SupplyType;
  interState: boolean;
  /** Taxable value, minor units. */
  taxableValue: number;
  ratePct: number;
  cess?: number;
  hsn?: string;
}

export interface Gstr1Bucket {
  count: number;
  taxableValue: number;
  tax: number;
  cess: number;
}

export interface Gstr1Summary {
  b2b: Gstr1Bucket;
  b2cl: Gstr1Bucket;
  b2cs: Gstr1Bucket;
  exportsWithPayment: Gstr1Bucket;
  exportsWithoutPayment: Gstr1Bucket;
  nilExempt: Gstr1Bucket;
  byRate: { ratePct: number; taxableValue: number; tax: number }[];
  hsnSummary: { hsn: string | null; taxableValue: number; tax: number; count: number }[];
  totals: { taxableValue: number; tax: number; cess: number };
  warnings: string[];
  methodology: string[];
}

const emptyBucket = (): Gstr1Bucket => ({ count: 0, tax: 0, cess: 0, taxableValue: 0 });

function addToBucket(b: Gstr1Bucket, inv: Gstr1Invoice): void {
  b.count += 1;
  b.taxableValue += inv.taxableValue;
  b.tax += gstTax(inv.taxableValue, inv.ratePct);
  b.cess += inv.cess ?? 0;
}

/**
 * Classify outward supplies into the GSTR-1 buckets.
 *
 * The one rule that must not be approximated: an inter-state B2C invoice whose
 * value EXCEEDS the B2CL threshold (₹2.5L by default) is reported invoice-wise
 * in B2CL, not consolidated in B2CS. Getting that wrong is the classic GSTR-1
 * mismatch.
 */
export function buildGstr1Summary(
  invoices: Gstr1Invoice[],
  opts: {
    b2clThreshold?: number;
    /** Current GSTR-1 Table 5A covers intra-State B2C above the threshold too.
     * Set false to reproduce the legacy inter-State-only B2CL rule. */
    b2clIncludesIntraState?: boolean;
  } = {},
): Gstr1Summary {
  const b2clThreshold = opts.b2clThreshold ?? INR(250000);
  const b2clIncludesIntraState = opts.b2clIncludesIntraState !== false;
  const buckets = {
    b2b: emptyBucket(),
    b2cl: emptyBucket(),
    b2cs: emptyBucket(),
    exportsWithPayment: emptyBucket(),
    exportsWithoutPayment: emptyBucket(),
    nilExempt: emptyBucket(),
  };
  const byRate = new Map<number, { taxableValue: number; tax: number }>();
  const hsn = new Map<string, { taxableValue: number; tax: number; count: number }>();
  const warnings: string[] = [];
  let totals = { taxableValue: 0, tax: 0, cess: 0 };

  for (const inv of invoices) {
    // Nil-rated, exempt and LUT/bond exports carry NO tax on the return even if
    // a rate was stamped on the invoice. Export WITH payment of IGST does carry
    // tax (the exporter then claims the refund).
    const zeroRated =
      inv.supplyType === "nil-rated" || inv.supplyType === "exempt" || inv.supplyType === "export-without-payment";
    const tax = zeroRated ? 0 : gstTax(inv.taxableValue, inv.ratePct);
    const cess = inv.cess ?? 0;

    if (inv.supplyType === "nil-rated" || inv.supplyType === "exempt") {
      addToBucket(buckets.nilExempt, { ...inv, ratePct: 0, cess: 0 });
    } else if (inv.supplyType === "export-with-payment") {
      addToBucket(buckets.exportsWithPayment, inv);
    } else if (inv.supplyType === "export-without-payment") {
      addToBucket(buckets.exportsWithoutPayment, { ...inv, ratePct: 0, cess: 0 });
    } else if (inv.buyerGstin) {
      if (!isValidGstin(inv.buyerGstin)) {
        warnings.push(`Invoice ${inv.invoiceNumber} has a malformed buyer GSTIN "${inv.buyerGstin}".`);
      }
      addToBucket(buckets.b2b, inv);
    } else {
      const invoiceValue = inv.taxableValue + tax + cess;
      const largeB2c = invoiceValue > b2clThreshold && (b2clIncludesIntraState || inv.interState);
      if (largeB2c) addToBucket(buckets.b2cl, inv);
      else addToBucket(buckets.b2cs, inv);
    }

    if (!zeroRated) {
      const rate = byRate.get(inv.ratePct) ?? { taxableValue: 0, tax: 0 };
      rate.taxableValue += inv.taxableValue;
      rate.tax += tax;
      byRate.set(inv.ratePct, rate);
    }

    const hsnKey = inv.hsn ?? "(missing)";
    const h = hsn.get(hsnKey) ?? { taxableValue: 0, tax: 0, count: 0 };
    h.taxableValue += inv.taxableValue;
    h.tax += tax;
    h.count += 1;
    hsn.set(hsnKey, h);

    if (!inv.hsn) warnings.push(`Invoice ${inv.invoiceNumber} has no HSN/SAC — the HSN summary will be incomplete.`);

    totals = { taxableValue: totals.taxableValue + inv.taxableValue, tax: totals.tax + tax, cess: totals.cess + cess };
  }

  return {
    ...buckets,
    byRate: [...byRate.entries()].map(([ratePct, v]) => ({ ratePct, ...v })).sort((a, b) => a.ratePct - b.ratePct),
    hsnSummary: [...hsn.entries()]
      .map(([key, v]) => ({ hsn: key === "(missing)" ? null : key, ...v }))
      .sort((a, b) => b.taxableValue - a.taxableValue),
    totals,
    warnings,
    methodology: [
      `Classified ${invoices.length} outward invoice(s) into GSTR-1 buckets.`,
      `B2CL threshold ${formatInr(b2clThreshold)} applied invoice-wise for inter-state B2C supplies.`,
      `Totals: taxable ${formatInr(totals.taxableValue)}, tax ${formatInr(totals.tax)}, cess ${formatInr(totals.cess)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// GSTR-3B ↔ GSTR-1 reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
  taxableDifference: number;
  taxDifference: number;
  reconciled: boolean;
  warnings: string[];
}

/**
 * Reconcile outward taxable value and tax between GSTR-1 and GSTR-3B. A rupee
 * tolerance absorbs rounding on the portal; anything larger is a real mismatch
 * that should be investigated before filing.
 */
export function reconcileGstr3bWithGstr1(opts: {
  gstr1Taxable: number;
  gstr1Tax: number;
  gstr3bTaxable: number;
  gstr3bTax: number;
  tolerance?: number;
}): ReconciliationResult {
  const tolerance = opts.tolerance ?? INR(1);
  const taxableDifference = opts.gstr1Taxable - opts.gstr3bTaxable;
  const taxDifference = opts.gstr1Tax - opts.gstr3bTax;
  const warnings: string[] = [];
  if (Math.abs(taxableDifference) > tolerance) {
    warnings.push(
      `Outward taxable value differs by ${formatInr(taxableDifference)} between GSTR-1 and GSTR-3B (tolerance ${formatInr(tolerance)}).`,
    );
  }
  if (Math.abs(taxDifference) > tolerance) {
    warnings.push(`Outward tax differs by ${formatInr(taxDifference)} between GSTR-1 and GSTR-3B.`);
  }
  return {
    taxableDifference,
    taxDifference,
    reconciled: warnings.length === 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Interest u/s 50 and late fee
// ---------------------------------------------------------------------------

/**
 * Interest on delayed tax u/s 50(1): 18% per annum, pro-rated by days.
 *
 * Rule 88B(1): where a return is furnished after the due date, interest runs
 * only on the portion of the tax discharged in CASH — the part paid by
 * utilising the electronic credit ledger is excluded. Pass `itcUtilised` and
 * the base is reduced accordingly; omitting it computes interest on the whole
 * amount, which is the correct reading when the liability was paid in cash.
 */
export function gstInterest(opts: {
  taxAmount: number;
  fromDate: string;
  toDate: string;
  ratePct?: number;
  /** Tax discharged by utilising ITC (Rule 88B(1)) — excluded from the base. */
  itcUtilised?: number;
}): {
  days: number;
  interestBase: number;
  interest: number;
  methodology: string[];
} {
  const ratePct = opts.ratePct ?? 18;
  const from = new Date(`${opts.fromDate}T00:00:00Z`);
  const to = new Date(`${opts.toDate}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new GstReturnError("Interest dates must be ISO yyyy-mm-dd.");
  }
  const days = Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  const itcUtilised = Math.max(0, Math.round(opts.itcUtilised ?? 0));
  const interestBase = Math.max(0, Math.round(opts.taxAmount) - itcUtilised);
  const interest = Math.round((interestBase * ratePct * days) / (100 * 365));
  return {
    days,
    interestBase,
    interest,
    methodology: [
      itcUtilised > 0
        ? `Cash portion of the tax ${formatInr(interestBase)} = ${formatInr(opts.taxAmount)} − ${formatInr(itcUtilised)} discharged by ITC (Rule 88B(1)).`
        : `Interest base ${formatInr(interestBase)}.`,
      `${formatInr(interestBase)} × ${ratePct}% × ${days}/365 days = ${formatInr(interest)}.`,
    ],
  };
}

/** Statutory late-fee ceilings per return (CGST + SGST). */
export const GST_LATE_FEE = {
  /** ₹50/day (₹25 CGST + ₹25 SGST), capped at ₹5,000 per return. */
  normalPerDay: INR(50),
  normalCap: INR(5000),
  /** NIL return: ₹20/day (₹10 + ₹10), capped at ₹500. */
  nilPerDay: INR(20),
  nilCap: INR(500),
  /** Small taxpayer (turnover ≤ ₹5 crore, Notification 07/2021 as amended):
   * ₹25/day capped at ₹1,000; NIL ₹10/day capped at ₹500. */
  smallTaxpayerPerDay: INR(25),
  smallTaxpayerCap: INR(1000),
  smallTaxpayerNilPerDay: INR(10),
  smallTaxpayerNilCap: INR(500),
} as const;

/**
 * Late fee under s.47. ₹50/day for a normal return capped at ₹5,000; ₹20/day
 * capped at ₹500 for a NIL return; the small-taxpayer concession is ₹25/day
 * capped at ₹1,000 (₹10/day, ₹500 for NIL). The cap is applied by default —
 * an uncapped ₹50/day for a year's delay would overstate the fee tenfold.
 */
export function gstLateFee(opts: {
  days: number;
  isNil?: boolean;
  /** Small taxpayer (turnover ≤ ₹5 crore). */
  smallTaxpayer?: boolean;
  perDay?: number;
  /** Override the statutory ceiling; pass Infinity to disable the cap. */
  cap?: number;
}): {
  lateFee: number;
  perDay: number;
  cap: number;
  capped: boolean;
  methodology: string[];
} {
  const isNil = opts.isNil === true;
  const perDay =
    opts.perDay ??
    (isNil
      ? opts.smallTaxpayer
        ? GST_LATE_FEE.smallTaxpayerNilPerDay
        : GST_LATE_FEE.nilPerDay
      : opts.smallTaxpayer
        ? GST_LATE_FEE.smallTaxpayerPerDay
        : GST_LATE_FEE.normalPerDay);
  const cap =
    opts.cap ??
    (isNil
      ? opts.smallTaxpayer
        ? GST_LATE_FEE.smallTaxpayerNilCap
        : GST_LATE_FEE.nilCap
      : opts.smallTaxpayer
        ? GST_LATE_FEE.smallTaxpayerCap
        : GST_LATE_FEE.normalCap);
  const days = Math.max(0, Math.floor(opts.days));
  const raw = perDay * days;
  const capped = raw > cap;
  return {
    lateFee: capped ? cap : raw,
    perDay,
    cap,
    capped,
    methodology: [
      `${days} day(s) × ${formatInr(perDay)} = ${formatInr(raw)}${capped ? `, capped at ${formatInr(cap)} per return` : ""}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// E-invoice payload
// ---------------------------------------------------------------------------

export const VALID_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

export interface EInvoiceItem {
  slNo: string;
  isServc: "Y" | "N";
  hsnCd: string;
  qty?: number;
  unitPrice?: number;
  totAmt?: number;
  assAmt: number;
  gstRt: number;
  cgstAmt?: number;
  sgstAmt?: number;
  igstAmt?: number;
  cesAmt?: number;
  totItemVal: number;
}

export interface EInvoicePayload {
  Version: string;
  TranDtls: { TaxSch: "GST"; SupTyp: "B2B" | "B2C" | "EXPWP" | "EXPWOP"; RegRev: "Y" | "N" };
  DocDtls: { Typ: "INV" | "CRN" | "DBN"; No: string; Dt: string };
  SellerDtls: { Gstin: string; LglNm: string; Loc: string; Stcd: string; Pin?: number };
  BuyerDtls: { Gstin?: string; LglNm: string; Pos: string; Loc?: string; Stcd?: string; Pin?: number };
  ItemList: EInvoiceItem[];
  ValDtls: { AssVal: number; CgstVal?: number; SgstVal?: number; IgstVal?: number; CesVal?: number; TotInvVal: number };
}

/**
 * Build a schema-shaped e-invoice payload. Intra-state supplies split the rate
 * into equal CGST and SGST; inter-state supplies carry the whole rate as IGST.
 * The IRN itself is issued by the IRP — this is the document the IRP accepts.
 */
export function buildEInvoicePayload(input: {
  invoiceNumber: string;
  date: string;
  docType?: "INV" | "CRN" | "DBN";
  seller: { gstin: string; name: string; location: string; stateCode: string; pin?: number };
  buyer: { gstin?: string; name: string; placeOfSupply: string; location?: string; stateCode?: string; pin?: number };
  supplyType?: "B2B" | "B2C" | "EXPWP" | "EXPWOP";
  reverseCharge?: boolean;
  items: {
    description?: string;
    hsn: string;
    quantity?: number;
    unitPrice?: number;
    taxableValue: number;
    ratePct: number;
    isService?: boolean;
    cess?: number;
  }[];
}): EInvoicePayload {
  const intraState = !!input.buyer.gstin && input.seller.stateCode === input.buyer.placeOfSupply;
  let assVal = 0;
  let cgstVal = 0;
  let sgstVal = 0;
  let igstVal = 0;
  let cesVal = 0;

  const items: EInvoiceItem[] = input.items.map((it, i) => {
    const tax = gstTax(it.taxableValue, it.ratePct);
    const cess = it.cess ?? 0;
    assVal += it.taxableValue;
    cesVal += cess;
    if (it.ratePct === 0 || input.supplyType === "EXPWP" || input.supplyType === "EXPWOP") {
      // zero-rated / export: no tax on the document
    } else if (intraState) {
      cgstVal += Math.round(tax / 2);
      sgstVal += tax - Math.round(tax / 2);
    } else {
      igstVal += tax;
    }
    return {
      slNo: String(i + 1),
      isServc: it.isService ? "Y" : "N",
      hsnCd: it.hsn,
      qty: it.quantity,
      unitPrice: it.unitPrice,
      totAmt: it.quantity !== undefined && it.unitPrice !== undefined ? it.quantity * it.unitPrice : it.taxableValue,
      assAmt: it.taxableValue,
      gstRt: it.ratePct,
      cgstAmt: intraState && it.ratePct > 0 ? Math.round(tax / 2) : undefined,
      sgstAmt: intraState && it.ratePct > 0 ? tax - Math.round(tax / 2) : undefined,
      igstAmt: !intraState && it.ratePct > 0 ? tax : undefined,
      cesAmt: cess || undefined,
      totItemVal: it.taxableValue + (input.supplyType === "EXPWP" || input.supplyType === "EXPWOP" ? 0 : tax) + cess,
    };
  });

  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: input.supplyType ?? (input.buyer.gstin ? "B2B" : "B2C"),
      RegRev: input.reverseCharge ? "Y" : "N",
    },
    DocDtls: { Typ: input.docType ?? "INV", No: input.invoiceNumber, Dt: input.date },
    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.name,
      Loc: input.seller.location,
      Stcd: input.seller.stateCode,
      Pin: input.seller.pin,
    },
    BuyerDtls: {
      Gstin: input.buyer.gstin,
      LglNm: input.buyer.name,
      Pos: input.buyer.placeOfSupply,
      Loc: input.buyer.location,
      Stcd: input.buyer.stateCode,
      Pin: input.buyer.pin,
    },
    ItemList: items,
    ValDtls: {
      AssVal: assVal,
      CgstVal: cgstVal,
      SgstVal: sgstVal,
      IgstVal: igstVal,
      CesVal: cesVal,
      TotInvVal: assVal + cgstVal + sgstVal + igstVal + cesVal,
    },
  };
}

export interface EInvoiceValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate an e-invoice payload against the schema rules the IRP enforces.
 * This is a structural check — it does not generate or verify an IRN.
 */
export function validateEInvoice(payload: EInvoicePayload): EInvoiceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isValidGstin(payload.SellerDtls.Gstin)) errors.push(`Seller GSTIN "${payload.SellerDtls.Gstin}" is malformed.`);
  else if (payload.SellerDtls.Stcd && payload.SellerDtls.Stcd !== gstinStateCode(payload.SellerDtls.Gstin)) {
    errors.push(`Seller state code "${payload.SellerDtls.Stcd}" does not match its GSTIN.`);
  }
  if (payload.BuyerDtls.Gstin !== undefined && !isValidGstin(payload.BuyerDtls.Gstin)) {
    errors.push(`Buyer GSTIN "${payload.BuyerDtls.Gstin}" is malformed.`);
  }
  if (!/^\d{2}$/.test(payload.BuyerDtls.Pos))
    errors.push(`Place of supply "${payload.BuyerDtls.Pos}" must be a 2-digit state code.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.DocDtls.Dt))
    errors.push(`Document date "${payload.DocDtls.Dt}" must be yyyy-mm-dd.`);
  if (payload.DocDtls.No.length === 0 || payload.DocDtls.No.length > 16)
    errors.push(`Document number must be 1–16 characters (got ${payload.DocDtls.No.length}).`);
  if (payload.ItemList.length === 0) errors.push("At least one item is required.");

  for (const item of payload.ItemList) {
    if (!/^\d{4,8}$/.test(item.hsnCd)) errors.push(`Item ${item.slNo}: HSN/SAC "${item.hsnCd}" must be 4–8 digits.`);
    if (!(VALID_GST_RATES as readonly number[]).includes(item.gstRt)) {
      errors.push(`Item ${item.slNo}: GST rate ${item.gstRt}% is not a notified rate (${VALID_GST_RATES.join(", ")}).`);
    }
    if (item.assAmt < 0) errors.push(`Item ${item.slNo}: assessable value cannot be negative.`);
  }

  const expectedTotal =
    payload.ValDtls.AssVal +
    (payload.ValDtls.CgstVal ?? 0) +
    (payload.ValDtls.SgstVal ?? 0) +
    (payload.ValDtls.IgstVal ?? 0) +
    (payload.ValDtls.CesVal ?? 0);
  if (expectedTotal !== payload.ValDtls.TotInvVal) {
    errors.push(
      `Invoice total ${formatInr(payload.ValDtls.TotInvVal)} does not equal assessable value plus taxes (${formatInr(expectedTotal)}).`,
    );
  }
  if (!payload.BuyerDtls.Gstin && payload.TranDtls.SupTyp === "B2B") {
    warnings.push("Supply type is B2B but the buyer has no GSTIN.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * GSTR-2B ITC reconciliation engine — the monthly ITC gate before 3B is filed.
 *
 * What a CA actually does every month: pull the purchase register (books) and
 * GSTR-2B (portal), match invoice by invoice, and decide which credit may be
 * availed THIS month. The rules that decide it, all implemented here:
 *
 *   s 16(2)(aa)  — the invoice must appear in GSTR-2B (credit not claimed on a
 *                  books-only invoice; one already claimed must be reversed).
 *   s 17(5)      — blocked credits (motor vehicles, food & beverages, club
 *                  memberships, works contract for immovable property, personal
 *                  consumption, gifts/free samples …).
 *   s 16(4)      — time limit: the credit belongs to the earlier of 30 Nov
 *                  following the FY end or the annual-return due date.
 *   r 36(4)      — ITC availed in Table 4(A) cannot exceed the ITC available
 *                  (2B + RCM + imports); the excess is reversed in 4(B)(1).
 *   r 37         — supplier did not file GSTR-1 for the period: reversal.
 *
 * SCOPE AND HONESTY — same contract as `gst-returns.ts`: this PREPARES the
 * reconciliation and the Table 4 figures. It does not talk to the portal and
 * does not import the 2B JSON itself (the caller maps it). Rates/thresholds are
 * caller-supplied data with labelled defaults.
 *
 * Money is in MINOR UNITS (paise) as integers, matching the CA engines.
 */

import { INR, formatInr } from "./india-tax";

export class ItcReconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItcReconError";
  }
}

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

/** One GSTR-2B line (B2B / CDN / IMPG / IMPGSEZ, as the caller maps them). */
export interface Gstr2bRow {
  /** Supplier GSTIN. */
  gstin: string;
  /** Supplier legal/trade name. */
  supplierName?: string;
  /** Invoice / credit-note / debit-note number. */
  invoiceNumber: string;
  /** yyyy-mm-dd. */
  invoiceDate: string;
  /** "INV" invoice, "CRN" credit note (reduces ITC), "DBN" debit note. */
  docType?: "INV" | "CRN" | "DBN";
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** 2-digit place-of-supply state code. */
  placeOfSupply: string;
  /** Reverse-charge supply: ITC claimed under 4(A)(3), not normal ITC. */
  reverseCharge?: boolean;
  /** false when the supplier has not filed GSTR-1 (rule 37 exposure). */
  supplierFiledGstr1?: boolean;
  itcAvailable?: boolean;
}

/** One purchase-register line from the books. */
export interface PurchaseRow {
  gstin: string;
  invoiceNumber: string;
  invoiceDate: string;
  docType?: "INV" | "CRN" | "DBN";
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  placeOfSupply: string;
  reverseCharge?: boolean;
  /** s17(5) blocked-credit category, when the books tag it. */
  blockedCategory?: BlockedItcCategory | null;
}

/**
 * s 17(5) blocked-credit categories (the ones a purchase register actually
 * tags). Defaults are labelled; amendments land as caller data.
 */
export type BlockedItcCategory =
  | "motor-vehicle-seating-13-or-less" // s17(5)(a) unless further supply/transport
  | "vessels-aircraft" // s17(5)(ab)
  | "food-and-beverages" // s17(5)(b)(i)
  | "beauty-treatment" // s17(5)(b)(ii)
  | "membership-of-club" // s17(5)(b)(iii)
  | "life-health-insurance" // s17(5)(b)(iv) unless statutory
  | "travel-benefits-employees" // s17(5)(b)(v) unless statutory
  | "works-contract-immovable" // s17(5)(c) unless plant & machinery
  | "construction-immovable" // s17(5)(d) unless plant & machinery
  | "composition-dealer" // s17(5)(e)
  | "non-resident-import" // s17(5)(f)
  | "personal-consumption" // s17(5)(g)
  | "gifts-free-samples" // s17(5)(h)
  | "lost-stolen-destroyed" // s17(5)(i)
  | "tax-paid-u/s-74-129-130" // s17(5)(j)
  | "csr" // s17(5)(k)
  | "goods-services-rental-repair-subcontracted"; // s17(5)(l)

/** Human labels for the blocked categories (used in warnings and the UI). */
export const BLOCKED_ITC_LABELS: Record<BlockedItcCategory, string> = {
  "motor-vehicle-seating-13-or-less": "Motor vehicle ≤13 seats (s17(5)(a))",
  "vessels-aircraft": "Vessels / aircraft (s17(5)(ab))",
  "food-and-beverages": "Food & beverages, outdoor catering (s17(5)(b)(i))",
  "beauty-treatment": "Beauty treatment, cosmetic surgery (s17(5)(b)(ii))",
  "membership-of-club": "Club / health & fitness membership (s17(5)(b)(iii))",
  "life-health-insurance": "Life / health insurance (s17(5)(b)(iv))",
  "travel-benefits-employees": "Employee travel benefits (s17(5)(b)(v))",
  "works-contract-immovable": "Works contract for immovable property (s17(5)(c))",
  "construction-immovable": "Construction of immovable property (s17(5)(d))",
  "composition-dealer": "From a composition dealer (s17(5)(e))",
  "non-resident-import": "Non-resident taxable person import (s17(5)(f))",
  "personal-consumption": "Personal consumption (s17(5)(g))",
  "gifts-free-samples": "Gifts / free samples (s17(5)(h))",
  "lost-stolen-destroyed": "Goods lost, stolen, destroyed, written off (s17(5)(i))",
  "tax-paid-u/s-74-129-130": "Tax paid u/s 74/129/130 (s17(5)(j))",
  csr: "CSR expenditure (s17(5)(k))",
  "goods-services-rental-repair-subcontracted": "Goods/services where owner's ITC is blocked (s17(5)(l))",
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface ItcTaxAmounts {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

const ZERO: ItcTaxAmounts = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

function sumTax(t: ItcTaxAmounts): number {
  return t.igst + t.cgst + t.sgst + t.cess;
}

/**
 * Credit notes REDUCE ITC. Normalise every amount by the document type so a
 * caller that supplies a CRN with positive figures (the natural way to read an
 * invoice) does not silently increase the credit availed. A caller that already
 * supplied negative figures keeps them negative.
 */
function signedAmounts(
  docType: "INV" | "CRN" | "DBN",
  amounts: { taxableValue: number; igst: number; cgst: number; sgst: number; cess: number },
): ItcTaxAmounts {
  const sign = docType === "CRN" ? -1 : 1;
  return {
    taxableValue: sign * Math.abs(amounts.taxableValue),
    igst: sign * Math.abs(amounts.igst),
    cgst: sign * Math.abs(amounts.cgst),
    sgst: sign * Math.abs(amounts.sgst),
    cess: sign * Math.abs(amounts.cess),
  };
}

/** Sum of the absolute per-head differences — a CGST↔IGST shift is a mismatch
 * even when the total tax is identical. */
function headwiseDifference(a: ItcTaxAmounts, b: ItcTaxAmounts): number {
  return Math.abs(a.igst - b.igst) + Math.abs(a.cgst - b.cgst) + Math.abs(a.sgst - b.sgst) + Math.abs(a.cess - b.cess);
}

function sumRows(
  rows: { taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }[],
): ItcTaxAmounts {
  return rows.reduce(
    (a, r) => ({
      taxableValue: a.taxableValue + r.taxableValue,
      igst: a.igst + r.igst,
      cgst: a.cgst + r.cgst,
      sgst: a.sgst + r.sgst,
      cess: a.cess + r.cess,
    }),
    { ...ZERO },
  );
}

/** Match key: uppercase GSTIN + document number + type. */
export function matchKey(gstin: string, invoiceNumber: string, docType: "INV" | "CRN" | "DBN" = "INV"): string {
  return `${gstin.trim().toUpperCase()}|${invoiceNumber.trim().toUpperCase()}|${docType}`;
}

/**
 * S16(4) deadline: 30 November following the end of the financial year to
 * which the invoice pertains. An April-2025 invoice belongs to FY 2025-26,
 * which ends 31 March 2026 — so the deadline is 30 November 2026, the SAME
 * calendar year as the March FY end (November follows March, not a year later).
 */
export function s16Deadline(invoiceDate: string): string {
  const y = Number(invoiceDate.slice(0, 4));
  const fyEndYear = Number(invoiceDate.slice(5, 7)) <= 3 ? y : y + 1; // FY end (Mar)
  return `${fyEndYear}-11-30`;
}

export type ItcVerdict =
  | "matched-eligible"
  | "matched-eligible-rcm"
  | "matched-blocked"
  | "matched-rule37"
  | "matched-expired-s16"
  | "amount-mismatch"
  | "in-2b-only"
  | "in-books-only";

export interface ReconciledInvoice {
  key: string;
  gstin: string;
  supplierName: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  docType: "INV" | "CRN" | "DBN";
  verdict: ItcVerdict;
  /** The side that wins the amounts (2B when matched). */
  twoB: ItcTaxAmounts | null;
  books: ItcTaxAmounts | null;
  /** Absolute tax difference (all four heads summed), 0 when matched. */
  taxDifference: number;
  blockedCategory: BlockedItcCategory | null;
  blockedLabel: string | null;
  s16Deadline: string;
  reasons: string[];
}

export interface Gstr3bTable4 {
  /** 4(A)(1)–(4): ITC availed on invoices, by head. */
  itcAvailed: ItcTaxAmounts;
  /** 4(A)(3): reverse-charge ITC (kept separate in the return). */
  itcAvailedRcm: ItcTaxAmounts;
  /** 4(B)(1): reversals — excess over rule 36(4), s17(5) if pre-claimed, rule 37. */
  itcReversed: ItcTaxAmounts;
  /** 4(C) net = A − B. */
  netItc: ItcTaxAmounts;
  /** 4(A)(5) ITC available this period: 2B-eligible + RCM. */
  itcAvailable: ItcTaxAmounts;
  /** rule 36(4) excess availed (included in itcReversed when > 0). */
  rule364Excess: number;
  /** ITC on books-only invoices that must NOT be availed (s16(2)(aa)). */
  pending2b: ItcTaxAmounts;
}

export interface ItcReconciliation {
  invoices: ReconciledInvoice[];
  table4: Gstr3bTable4;
  counts: Record<ItcVerdict, number>;
  warnings: string[];
  methodology: string[];
}

const emptyCounts = (): Record<ItcVerdict, number> => ({
  "matched-eligible": 0,
  "matched-eligible-rcm": 0,
  "matched-blocked": 0,
  "matched-rule37": 0,
  "matched-expired-s16": 0,
  "amount-mismatch": 0,
  "in-2b-only": 0,
  "in-books-only": 0,
});

/**
 * Reconcile the purchase register against GSTR-2B and produce the GSTR-3B
 * Table 4 figures. The invariant the tests pin: Table 4(C) = 4(A) − 4(B) per
 * tax head, and no credit on a books-only invoice ever enters 4(A).
 */
export function reconcileItc(input: {
  twoB: Gstr2bRow[];
  purchases: PurchaseRow[];
  /** As-of date for the s16(4) time-limit test (yyyy-mm-dd). */
  asOfDate: string;
  /** Rupee tolerance for amount comparison (default ₹1). */
  tolerance?: number;
  /** Assess for whose s16(4) clock the caller checks (default: invoice's). */
  rule37Reversal?: boolean;
  /** ITC actually availed in GSTR-3B Table 4(A) for the period. Supplying it
   * lets rule 36(4) bite: availed above the 2B-eligible + RCM figure is
   * reversed in 4(B)(1). Omit and the reconciliation assumes the computed
   * eligible credit is what was availed. */
  itcAvailedInTable4A?: ItcTaxAmounts;
}): ItcReconciliation {
  const tolerance = input.tolerance ?? INR(1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) throw new ItcReconError("asOfDate must be yyyy-mm-dd.");

  const byKey = new Map<string, Gstr2bRow[]>();
  for (const r of input.twoB) {
    const k = matchKey(r.gstin, r.invoiceNumber, r.docType ?? "INV");
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }

  const invoices: ReconciledInvoice[] = [];
  const consumed2b = new Set<Gstr2bRow>();
  const warnings: string[] = [];

  // ---- books side first: every purchase row must find its 2B twin ----------
  for (const p of input.purchases) {
    const docType = p.docType ?? "INV";
    const key = matchKey(p.gstin, p.invoiceNumber, docType);
    const candidates = byKey.get(key);
    const books: ItcTaxAmounts = signedAmounts(docType, {
      taxableValue: p.taxableValue,
      igst: p.igst,
      cgst: p.cgst,
      sgst: p.sgst,
      cess: p.cess,
    });
    const twin = candidates?.find((c) => !consumed2b.has(c));
    const reasons: string[] = [];

    let verdict: ItcVerdict;
    let twoB: ItcTaxAmounts | null = null;
    let taxDifference = 0;

    if (!twin) {
      verdict = "in-books-only";
      reasons.push(
        "s16(2)(aa): invoice not in GSTR-2B — ITC cannot be availed this period (reverse in 4(B)(1) if already claimed).",
      );
      warnings.push(`Purchase ${p.invoiceNumber} (${p.gstin}) is in the books but not in GSTR-2B.`);
    } else {
      consumed2b.add(twin);
      twoB = signedAmounts(docType, {
        taxableValue: twin.taxableValue,
        igst: twin.igst,
        cgst: twin.cgst,
        sgst: twin.sgst,
        cess: twin.cess,
      });
      taxDifference = headwiseDifference(twoB, books);
      const filed = twin.supplierFiledGstr1 !== false;
      const expired = input.asOfDate > s16Deadline(twin.invoiceDate);

      if (taxDifference > tolerance) {
        verdict = "amount-mismatch";
        const totalShifted = Math.abs(sumTax(twoB) - sumTax(books)) <= tolerance;
        reasons.push(
          totalShifted
            ? `Total tax agrees but the heads do not (CGST/SGST vs IGST shift of ${formatInr(taxDifference)}) — the credit heads in 3B would be wrong; correct the invoice classification.`
            : `Tax amounts differ between books and 2B by ${formatInr(taxDifference)} across heads (tolerance ${formatInr(tolerance)}) — reconcile before availing.`,
        );
      } else if (twin.itcAvailable === false) {
        verdict = "matched-blocked";
        reasons.push(
          "GSTR-2B reports this credit as NOT available — it cannot be availed until the supplier corrects the return.",
        );
      } else if (p.blockedCategory) {
        verdict = "matched-blocked";
        reasons.push(`s17(5): ${BLOCKED_ITC_LABELS[p.blockedCategory]} — ITC ineligible.`);
      } else if (expired) {
        verdict = "matched-expired-s16";
        reasons.push(`s16(4): time limit expired on ${s16Deadline(twin.invoiceDate)}.`);
      } else if (!filed) {
        verdict = "matched-rule37";
        reasons.push("rule 37: supplier has not filed GSTR-1 — reversal exposure; avail provisionally only.");
      } else if (twin.reverseCharge || p.reverseCharge) {
        verdict = "matched-eligible-rcm";
        reasons.push("Reverse charge: claim under Table 4(A)(3), payable first under s9(3)/(4).");
      } else {
        verdict = "matched-eligible";
      }
    }

    invoices.push({
      key,
      gstin: p.gstin,
      supplierName: twin?.supplierName ?? null,
      invoiceNumber: p.invoiceNumber,
      invoiceDate: p.invoiceDate,
      docType,
      verdict,
      twoB,
      books,
      taxDifference,
      blockedCategory: p.blockedCategory ?? null,
      blockedLabel: p.blockedCategory ? BLOCKED_ITC_LABELS[p.blockedCategory] : null,
      s16Deadline: s16Deadline(p.invoiceDate),
      reasons,
    });
  }

  // ---- 2B-only rows: credit the supplier has issued that the books missed ---
  for (const t of input.twoB) {
    if (consumed2b.has(t)) continue;
    const reasons: string[] = [
      "In GSTR-2B but not in the purchase register — book the invoice or claim provisionally in 4(A)(7); verify before availing.",
    ];
    if (t.reverseCharge) reasons.push("Reverse-charge row: claim under 4(A)(3) once accounted for.");
    invoices.push({
      key: matchKey(t.gstin, t.invoiceNumber, t.docType ?? "INV"),
      gstin: t.gstin,
      supplierName: t.supplierName ?? null,
      invoiceNumber: t.invoiceNumber,
      invoiceDate: t.invoiceDate,
      docType: t.docType ?? "INV",
      verdict: "in-2b-only",
      twoB: signedAmounts(t.docType ?? "INV", {
        taxableValue: t.taxableValue,
        igst: t.igst,
        cgst: t.cgst,
        sgst: t.sgst,
        cess: t.cess,
      }),
      books: null,
      taxDifference: 0,
      blockedCategory: null,
      blockedLabel: null,
      s16Deadline: s16Deadline(t.invoiceDate),
      reasons,
    });
  }

  // ---- aggregate into Table 4 ----------------------------------------------
  const avail = sumRows(invoices.filter((i) => i.verdict === "matched-eligible").map((i) => i.twoB!));
  const rcm = sumRows(invoices.filter((i) => i.verdict === "matched-eligible-rcm").map((i) => i.twoB!));
  const pending = sumRows(invoices.filter((i) => i.verdict === "in-books-only").map((i) => i.books!));

  // rule 36(4): ITC AVAILED in 3B cannot exceed ITC AVAILABLE (2B-eligible +
  // RCM). The comparison only bites when the caller supplies the availed
  // figure — otherwise the eligible credit computed here is what was availed.
  const availableForRule364: ItcTaxAmounts = {
    taxableValue: avail.taxableValue + rcm.taxableValue,
    igst: avail.igst + rcm.igst,
    cgst: avail.cgst + rcm.cgst,
    sgst: avail.sgst + rcm.sgst,
    cess: avail.cess + rcm.cess,
  };
  const availedIn3b = input.itcAvailedInTable4A ?? availableForRule364;
  const excessPerHead: ItcTaxAmounts = {
    taxableValue: 0,
    igst: Math.max(0, availedIn3b.igst - availableForRule364.igst),
    cgst: Math.max(0, availedIn3b.cgst - availableForRule364.cgst),
    sgst: Math.max(0, availedIn3b.sgst - availableForRule364.sgst),
    cess: Math.max(0, availedIn3b.cess - availableForRule364.cess),
  };
  const rule364Excess = sumTax(excessPerHead);

  const reversed = { ...ZERO };
  if (rule364Excess > 0) {
    reversed.igst = excessPerHead.igst;
    reversed.cgst = excessPerHead.cgst;
    reversed.sgst = excessPerHead.sgst;
    reversed.cess = excessPerHead.cess;
    warnings.push(
      `rule 36(4): ITC availed ${formatInr(sumTax(availedIn3b))} exceeds ITC available ${formatInr(sumTax(availableForRule364))} — excess ${formatInr(rule364Excess)} reversed in 4(B)(1).`,
    );
  }

  // 4(A) shows what was actually availed when the caller tells us; the normal
  // (non-RCM) slice is the availed total less the RCM row.
  const normalAvailed: ItcTaxAmounts = input.itcAvailedInTable4A
    ? {
        taxableValue: avail.taxableValue,
        igst: Math.max(0, availedIn3b.igst - rcm.igst),
        cgst: Math.max(0, availedIn3b.cgst - rcm.cgst),
        sgst: Math.max(0, availedIn3b.sgst - rcm.sgst),
        cess: Math.max(0, availedIn3b.cess - rcm.cess),
      }
    : avail;

  const table4: Gstr3bTable4 = {
    itcAvailed: normalAvailed,
    itcAvailedRcm: rcm,
    itcReversed: reversed,
    netItc: {
      taxableValue: 0,
      igst: normalAvailed.igst + rcm.igst - reversed.igst,
      cgst: normalAvailed.cgst + rcm.cgst - reversed.cgst,
      sgst: normalAvailed.sgst + rcm.sgst - reversed.sgst,
      cess: normalAvailed.cess + rcm.cess - reversed.cess,
    },
    itcAvailable: {
      taxableValue: avail.taxableValue + rcm.taxableValue,
      igst: avail.igst + rcm.igst,
      cgst: avail.cgst + rcm.cgst,
      sgst: avail.sgst + rcm.sgst,
      cess: avail.cess + rcm.cess,
    },
    rule364Excess,
    pending2b: { ...pending },
  };

  const counts = emptyCounts();
  for (const i of invoices) counts[i.verdict] += 1;

  return {
    invoices: invoices.sort(
      (a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber),
    ),
    table4,
    counts,
    warnings,
    methodology: [
      `Matched ${input.purchases.length} purchase-register row(s) against ${input.twoB.length} GSTR-2B row(s) on GSTIN + document number + type.`,
      `Table 4(A) ITC availed ${formatInr(sumTax(avail))} + RCM ${formatInr(sumTax(rcm))}; 4(B)(1) reversed ${formatInr(sumTax(reversed))}; 4(C) net ${formatInr(sumTax(table4.netItc))}.`,
      `s16(2)(aa): ${formatInr(sumTax(pending))} of credit on books-only invoices held back pending 2B appearance.`,
      `s16(4) deadline checked against ${input.asOfDate}; tolerance ${formatInr(tolerance)}.`,
    ],
  };
}

/**
 * Table 4(B)(2) — ineligible ITC (s16(4) / composition supplies) as a
 * convenience when the caller needs the declared-ineligible line.
 */
export function ineligibleItc(recon: ItcReconciliation): ItcTaxAmounts {
  return sumRows(
    recon.invoices
      .filter((i) => i.verdict === "matched-expired-s16" || i.verdict === "matched-blocked")
      .map((i) => i.twoB ?? i.books!),
  );
}

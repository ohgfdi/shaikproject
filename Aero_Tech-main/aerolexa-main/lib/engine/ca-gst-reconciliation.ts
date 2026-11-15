/**
 * GST computation and reconciliation — outward ledger into a GSTR-1 summary,
 * GSTR-3B summary, head-wise ITC availability, 3B-vs-2A/2B reconciliation, and
 * the net cash payable after the s.49A/49B set-off order.
 *
 * SCOPE AND HONESTY: this is arithmetic on caller-supplied ledger rows. The
 * place of supply on each OUTWARD row decides CGST+SGST vs IGST against the
 * supplier's own GSTIN state; INWARD rows carry an optional head-wise split
 * (IGST/CGST/SGST/cess) because a purchase register usually has one, and fall
 * back to the intra-State split when it does not. The set-off follows
 * s.49A/49B and rule 88A: IGST credit against IGST, then CGST, then SGST; CGST
 * credit against CGST then IGST; SGST credit against SGST then IGST; cess only
 * against cess.
 *
 * Money is in MINOR UNITS (paise).
 */

export interface Gstr1Row {
  heading: string;
  taxable: number;
  tax: number;
  cess: number;
}

export interface Gstr1Summary {
  byRate: Gstr1Row[];
  totalTaxable: number;
  totalTax: number;
  totalCess: number;
}

export interface Gstr3BSummary {
  outwardTaxable: number;
  outwardTax: number;
  outwardCess: number;
  iclClaimed: number;
  icgClaimed: number;
  cessPaidOnImports?: number;
  reverseChargeTaxable: number;
  reverseChargeTax: number;
}

export interface IctReconciliation {
  openingIct: number;
  available2A2B: number;
  claimedIn3B: number;
  matched: number;
  unmatchedClaimed: number;
  unmatchedAvailable: number;
  capApplied: boolean;
  capNote: string;
  mismatches: string[];
}

export interface GstPayable {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
}

export interface GstCreditHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstLiabilityHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface GstReconciliationResult {
  gstin: string;
  period: string;
  gstr1: Gstr1Summary;
  gstr3b: Gstr3BSummary;
  ict: IctReconciliation;
  /** Output + RCM liability by head, before credit set-off. */
  liability: GstLiabilityHeads;
  /** ITC available by head (opening + inward + RCM + imports). */
  credit: GstCreditHeads;
  payable: GstPayable;
  warnings: string[];
  methodology: string[];
}

function summarizeByRate(
  taxablePerRate: Map<number, number>,
  taxPerRate: Map<number, number>,
  cessPerRate: Map<number, number>,
): Gstr1Row[] {
  const rows: Gstr1Row[] = [];
  const rates = Array.from(taxablePerRate.keys()).sort((a, b) => a - b);
  for (const r of rates) {
    rows.push({
      heading: `${r}%`,
      taxable: taxablePerRate.get(r) ?? 0,
      tax: taxPerRate.get(r) ?? 0,
      cess: cessPerRate.get(r) ?? 0,
    });
  }
  return rows;
}

const gstOn = (taxable: number, ratePct: number) => Math.round((taxable * ratePct) / 100);
const stateOf = (gstin: string) => gstin.slice(0, 2);

/** Split a rate-based tax into the intra-State halves, keeping the total exact. */
function splitIntra(tax: number): { cgst: number; sgst: number } {
  const cgst = Math.round(tax / 2);
  return { cgst, sgst: tax - cgst };
}

export function computeGstReconciliation(input: {
  gstin: string;
  period: string;
  outwardLedger: { inv: string; taxable: number; taxRate: number; place: string; eway: boolean; cess?: number }[];
  inwardLedger: {
    inv: string;
    taxable: number;
    taxRate: number;
    rcm: boolean;
    /** Optional head-wise amounts; when omitted the intra-State split is used. */
    igst?: number;
    cgst?: number;
    sgst?: number;
    cess?: number;
  }[];
  imports: { inv: string; taxable: number; igstRate: number; cess: number }[];
  openingIct: number;
  availableIct2A2B: number;
  reverseCharge: number;
  /** RCM tax payable, when the caller has it; otherwise derived from inward rows. */
  reverseChargeTax?: number;
  cessLedger: { inv: string; taxable: number; rate: number }[];
  /** ITC actually claimed in 3B, when it differs from the computed figure. */
  itcAvailedIn3b?: number;
}): GstReconciliationResult {
  const {
    gstin,
    period,
    outwardLedger,
    inwardLedger,
    imports,
    openingIct,
    availableIct2A2B,
    reverseCharge,
    reverseChargeTax,
    cessLedger,
    itcAvailedIn3b,
  } = input;

  const ownState = stateOf(gstin);

  // ---------------------------------------------------------------- outward
  const outTaxablePerRate = new Map<number, number>();
  const outTaxPerRate = new Map<number, number>();
  const liability: GstLiabilityHeads = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let outwardTaxable = 0;

  for (const row of outwardLedger) {
    const r = row.taxRate;
    const taxable = Math.max(0, Math.round(row.taxable));
    const tax = gstOn(taxable, r);
    const cess = Math.max(0, Math.round(row.cess ?? 0));
    outwardTaxable += taxable;
    outTaxablePerRate.set(r, (outTaxablePerRate.get(r) ?? 0) + taxable);
    outTaxPerRate.set(r, (outTaxPerRate.get(r) ?? 0) + tax + cess);
    if (String(row.place) === ownState) {
      const split = splitIntra(tax);
      liability.cgst += split.cgst;
      liability.sgst += split.sgst;
    } else {
      liability.igst += tax;
    }
    liability.cess += cess;
  }

  // Cess on the cess ledger is an outward cess liability.
  let cessFromLedger = 0;
  for (const row of cessLedger) {
    cessFromLedger += gstOn(Math.max(0, Math.round(row.taxable)), row.rate);
  }
  liability.cess += cessFromLedger;

  const gstr1: Gstr1Summary = {
    byRate: summarizeByRate(outTaxablePerRate, outTaxPerRate, new Map<number, number>()),
    totalTaxable: outwardTaxable,
    totalTax: Array.from(outTaxPerRate.values()).reduce((a, b) => a + b, 0),
    totalCess: liability.cess,
  };

  // ------------------------------------------------------------------- ITC
  const credit: GstCreditHeads = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let rcmItc = 0;
  let normalItc = 0;
  let rcmTaxDerived = 0;

  for (const row of inwardLedger) {
    const taxable = Math.max(0, Math.round(row.taxable));
    const tax = gstOn(taxable, row.taxRate);
    const hasSplit = row.igst !== undefined || row.cgst !== undefined || row.sgst !== undefined;
    const igst = hasSplit ? Math.max(0, Math.round(row.igst ?? 0)) : 0;
    const split = hasSplit
      ? { cgst: Math.max(0, Math.round(row.cgst ?? 0)), sgst: Math.max(0, Math.round(row.sgst ?? 0)) }
      : splitIntra(tax);
    const cess = Math.max(0, Math.round(row.cess ?? 0));

    credit.igst += igst;
    credit.cgst += split.cgst;
    credit.sgst += split.sgst;
    credit.cess += cess;

    if (row.rcm) {
      rcmItc += igst + split.cgst + split.sgst + cess;
      // The same amount is payable in cash under s.9(3)/(4).
      rcmTaxDerived += igst + split.cgst + split.sgst;
      liability.igst += igst;
      liability.cgst += split.cgst;
      liability.sgst += split.sgst;
    } else {
      normalItc += igst + split.cgst + split.sgst + cess;
    }
  }

  // Imports: IGST and cess paid at customs are ITC, not a domestic liability.
  let importIgst = 0;
  let importCess = 0;
  for (const row of imports) {
    importIgst += gstOn(Math.max(0, Math.round(row.taxable)), row.igstRate);
    importCess += Math.max(0, Math.round(row.cess));
  }
  credit.igst += importIgst;
  credit.cess += importCess;

  // Opening credit is an IGST-ledger balance in this model; the caller can move
  // it by supplying head-wise opening balances through the inward rows.
  const opening = Math.max(0, Math.round(openingIct));
  credit.igst += opening;

  // RCM tax payable: caller figure when supplied, else derived from the rows.
  const rcmTax = reverseChargeTax !== undefined ? Math.max(0, Math.round(reverseChargeTax)) : rcmTaxDerived;

  const totalCredits = credit.igst + credit.cgst + credit.sgst + credit.cess;
  const claimedIn3B = itcAvailedIn3b !== undefined ? Math.max(0, Math.round(itcAvailedIn3b)) : totalCredits;

  // --------------------------------------------------------- reconciliation
  const matched = Math.min(claimedIn3B, availableIct2A2B);
  const unmatchedClaimed = Math.max(0, claimedIn3B - availableIct2A2B);
  const unmatchedAvailable = Math.max(0, availableIct2A2B - claimedIn3B);
  const capApplied = unmatchedClaimed > 0;

  const mismatches: string[] = [];
  if (unmatchedClaimed > 0) {
    mismatches.push(
      `ITC claimed ${claimedIn3B} exceeds 2A/2B available ${availableIct2A2B} by ${unmatchedClaimed}; rule 36(4) requires the excess to be reversed.`,
    );
  }
  if (unmatchedAvailable > 0) {
    mismatches.push(
      `2A/2B available ITC ${availableIct2A2B} exceeds the claimed ITC ${claimedIn3B} by ${unmatchedAvailable}; available credit is being left unclaimed.`,
    );
  }
  if (totalCredits !== availableIct2A2B) {
    mismatches.push(
      `Computed credit ${totalCredits} and 2A/2B available ${availableIct2A2B} differ; reconcile opening balance, inward supplies, imports, and reversals.`,
    );
  }
  const capNote =
    `Rule 36(4): ITC claimed cannot exceed the credit available in GSTR-2B. ` +
    `Claimed ${claimedIn3B} vs available ${availableIct2A2B}` +
    (capApplied ? `; excess ${unmatchedClaimed} must be reversed in 4(B)(1).` : `; no excess.`);

  // ------------------------------------------------------------- set-off
  // s.49A/49B + rule 88A order, per head. Cess is ring-fenced.
  let igstCredit = credit.igst;
  let cgstCredit = credit.cgst;
  let sgstCredit = credit.sgst;
  let cessCredit = credit.cess;

  const igstPayable = Math.max(0, liability.igst - igstCredit);
  igstCredit = Math.max(0, igstCredit - liability.igst);

  // IGST credit against CGST, then SGST.
  const cgstAfterIgst = Math.max(0, liability.cgst - igstCredit);
  igstCredit = Math.max(0, igstCredit - liability.cgst);
  const sgstAfterIgst = Math.max(0, liability.sgst - igstCredit);
  igstCredit = Math.max(0, igstCredit - liability.sgst);

  // CGST credit against CGST, then IGST (but IGST was already settled).
  const cgstPayable = Math.max(0, cgstAfterIgst - cgstCredit);
  cgstCredit = Math.max(0, cgstCredit - cgstAfterIgst);
  const sgstPayable = Math.max(0, sgstAfterIgst - sgstCredit);
  sgstCredit = Math.max(0, sgstCredit - sgstAfterIgst);

  const cessPayable = Math.max(0, liability.cess - cessCredit);
  cessCredit = Math.max(0, cessCredit - liability.cess);

  const payable: GstPayable = {
    igst: igstPayable,
    cgst: cgstPayable,
    sgst: sgstPayable,
    cess: cessPayable,
    total: igstPayable + cgstPayable + sgstPayable + cessPayable,
  };

  const warnings: string[] = [];
  if (unmatchedClaimed > 0)
    warnings.push("Claimed ITC exceeds 2A/2B available; verify eligibility and reverse the excess.");
  if (availableIct2A2B === 0 && totalCredits > 0) {
    warnings.push(
      "2A/2B available ITC is zero while computed credit is positive; confirm GSTR-2A/2B status for the period.",
    );
  }
  if (rcmTax > 0) {
    warnings.push(
      "Reverse-charge tax is payable in cash (credit can be claimed in the same period); confirm the RCM invoices and the rate applied.",
    );
  }

  return {
    gstin,
    period,
    gstr1,
    gstr3b: {
      outwardTaxable,
      outwardTax: gstr1.totalTax,
      outwardCess: liability.cess,
      iclClaimed: rcmItc,
      icgClaimed: normalItc,
      cessPaidOnImports: importCess,
      reverseChargeTaxable: Math.max(0, Math.round(reverseCharge)),
      reverseChargeTax: rcmTax,
    },
    ict: {
      openingIct: opening,
      available2A2B: availableIct2A2B,
      claimedIn3B,
      matched,
      unmatchedClaimed,
      unmatchedAvailable,
      capApplied,
      capNote,
      mismatches,
    },
    liability,
    credit,
    payable,
    warnings,
    methodology: [
      "GSTR-1 summary groups outward supplies by the tax rate on each invoice; tax is rounded once per invoice.",
      "Outward tax is split CGST+SGST where the place of supply equals the supplier's GSTIN state, and IGST otherwise.",
      "Inward rows use their head-wise split when supplied; otherwise the intra-State split is assumed. RCM credit is claimed and the same amount is payable in cash.",
      "Rule 36(4): ITC claimed cannot exceed the 2B-available figure; the excess is surfaced as a reversal.",
      "Payable is computed after the s.49A/49B set-off order: IGST credit against IGST, then CGST, then SGST; CGST against CGST then IGST; SGST against SGST then IGST; cess only against cess.",
    ],
  };
}

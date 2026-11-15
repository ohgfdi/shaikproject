/**
 * GSTR-9 annual return engine — the year-end summary and ITC reconciliation.
 *
 * `gst-returns.ts` prepares the monthly returns; `gstr-2b-itc.ts` decides the
 * monthly ITC gate. This module rolls the year up into the GSTR-9-shaped
 * tables a CA files in December:
 *
 *   Table 4 — ITC availed, reversed and the net for the year
 *   Table 5 — ITC on imports
 *   Table 6 — inward supplies under reverse charge
 *   Table 8 — the reconciliation that matters: 8A ITC as per GSTR-2B
 *             (auto-populated) vs 8B ITC availed in 3B, 8C the difference,
 *             and 8D claims relating to the previous FY made within the
 *             s16(4) window
 *   Table 9 — outward supplies and tax by head for the year
 *
 * SCOPE AND HONESTY — same contract as every CA engine here: this AGGREGATES
 * caller-supplied monthly figures and reconciles them. It does not read the
 * portal's GSTR-9 utility, does not generate the JSON, and does not file.
 * Tolerances are caller data; the defaults are labelled.
 *
 * Money is in MINOR UNITS (paise) as integers.
 */

import { formatInr } from "./india-tax";

export class Gstr9Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Gstr9Error";
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface Gstr9TaxAmounts {
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export const ZERO_TAX: Gstr9TaxAmounts = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

export interface Gstr9Input {
  /** "2025-26" style. */
  fy: string;
  /** Monthly outward summaries (GSTR-1 / 3B Table 3.1). */
  outward: Gstr9TaxAmounts[];
  /** Monthly ITC availed as claimed in 3B Table 4(A). */
  itcAvailed: Gstr9TaxAmounts[];
  /** Monthly ITC reversed in 3B Table 4(B). */
  itcReversed?: Gstr9TaxAmounts[];
  /** ITC on imports (Table 5), optional. */
  importsItc?: Gstr9TaxAmounts;
  /** Inward reverse-charge supplies for the year (Table 6), optional. */
  rcm?: Gstr9TaxAmounts[];
  /** Annual ITC available per GSTR-2B — Table 8A. Omit = no reconciliation. */
  twoBAvailable?: Gstr9TaxAmounts;
  /** FY-1 invoices claimed this FY within s16(4) — Table 8D. */
  previousYearClaims?: Gstr9TaxAmounts;
  /** Rupee tolerance for Table 8C (default ₹1). */
  tolerance?: number;
}

export interface Gstr9Result {
  fy: string;
  table4: { availed: Gstr9TaxAmounts; reversed: Gstr9TaxAmounts; net: Gstr9TaxAmounts };
  table5Imports: Gstr9TaxAmounts | null;
  table6Rcm: Gstr9TaxAmounts;
  table8: {
    /** 8A — ITC as per GSTR-2B (auto-populated). */
    twoBAvailable: Gstr9TaxAmounts;
    /** 8B — ITC availed in 3B for the year. */
    availed: Gstr9TaxAmounts;
    /** 8C = 8A − 8B, the number the department's notice starts from. */
    difference: Gstr9TaxAmounts;
    /** 8D — claims relating to the previous FY within the s16(4) window. */
    previousYearClaims: Gstr9TaxAmounts;
    /** true when every head of 8C is within tolerance. */
    reconciled: boolean;
  } | null;
  table9Outward: Gstr9TaxAmounts;
  warnings: string[];
  methodology: string[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function sumAmounts(rows: Gstr9TaxAmounts[]): Gstr9TaxAmounts {
  return rows.reduce<Gstr9TaxAmounts>(
    (a, r) => ({
      taxableValue: a.taxableValue + r.taxableValue,
      igst: a.igst + r.igst,
      cgst: a.cgst + r.cgst,
      sgst: a.sgst + r.sgst,
      cess: a.cess + r.cess,
    }),
    { ...ZERO_TAX },
  );
}

function subtractAmounts(a: Gstr9TaxAmounts, b: Gstr9TaxAmounts): Gstr9TaxAmounts {
  return {
    taxableValue: a.taxableValue - b.taxableValue,
    igst: a.igst - b.igst,
    cgst: a.cgst - b.cgst,
    sgst: a.sgst - b.sgst,
    cess: a.cess - b.cess,
  };
}

function maxAbsDifference(a: Gstr9TaxAmounts, b: Gstr9TaxAmounts): number {
  const d = subtractAmounts(a, b);
  return Math.max(Math.abs(d.igst), Math.abs(d.cgst), Math.abs(d.sgst), Math.abs(d.cess));
}

// ---------------------------------------------------------------------------
// The return
// ---------------------------------------------------------------------------

export function buildGstr9(input: Gstr9Input): Gstr9Result {
  if (!/^\d{4}-\d{2}$/.test(input.fy)) {
    throw new Gstr9Error(`fy must look like "2025-26"; got "${input.fy}".`);
  }
  const tolerance = Math.max(0, Math.round(input.tolerance ?? 100)); // ₹1
  const warnings: string[] = [];

  const outward = sumAmounts(input.outward);
  const availed = sumAmounts(input.itcAvailed);
  const reversed = sumAmounts(input.itcReversed ?? []);
  const net: Gstr9TaxAmounts = {
    taxableValue: availed.taxableValue - reversed.taxableValue,
    igst: availed.igst - reversed.igst,
    cgst: availed.cgst - reversed.cgst,
    sgst: availed.sgst - reversed.sgst,
    cess: availed.cess - reversed.cess,
  };
  const rcm = sumAmounts(input.rcm ?? []);
  const imports = input.importsItc ?? null;

  let table8: Gstr9Result["table8"] = null;
  if (input.twoBAvailable) {
    const twoB = input.twoBAvailable;
    const difference = subtractAmounts(twoB, availed);
    const reconciled = maxAbsDifference(twoB, availed) <= tolerance;
    const previousYearClaims = input.previousYearClaims ?? { ...ZERO_TAX };

    if (!reconciled) {
      warnings.push(
        `Table 8C: ITC as per GSTR-2B differs from the ITC availed in 3B (IGST ${formatInr(difference.igst)}, CGST ${formatInr(difference.cgst)}, SGST ${formatInr(difference.sgst)}, cess ${formatInr(difference.cess)}) — reconcile or explain before filing; this is the figure a scrutiny notice quotes.`,
      );
    }
    const pyc = previousYearClaims;
    if (pyc.igst + pyc.cgst + pyc.sgst + pyc.cess > 0) {
      warnings.push(
        `Table 8D: ${formatInr(pyc.igst + pyc.cgst + pyc.sgst + pyc.cess)} of ITC relates to FY ${Number(input.fy.slice(0, 4)) - 1}-${String(Number(input.fy.slice(0, 4))).slice(2)} invoices claimed within the s16(4) window (30 November) — confirm each claim is inside the deadline.`,
      );
    }
    table8 = { twoBAvailable: twoB, availed, difference, previousYearClaims, reconciled };
  } else {
    warnings.push(
      "No GSTR-2B annual figure supplied — Table 8 reconciliation was skipped; the 8C difference is unknown.",
    );
  }

  return {
    fy: input.fy,
    table4: { availed, reversed, net },
    table5Imports: imports,
    table6Rcm: rcm,
    table8,
    table9Outward: outward,
    warnings,
    methodology: [
      `GSTR-9-shaped summary for FY ${input.fy}: ${input.outward.length} outward period(s) and ${input.itcAvailed.length} ITC period(s) aggregated.`,
      `Table 4: availed ${formatInr(availed.igst + availed.cgst + availed.sgst + availed.cess)}, reversed ${formatInr(reversed.igst + reversed.cgst + reversed.sgst + reversed.cess)}, net ${formatInr(net.igst + net.cgst + net.sgst + net.cess)}.`,
      input.twoBAvailable
        ? `Table 8: 2B available ${formatInr(input.twoBAvailable.igst + input.twoBAvailable.cgst + input.twoBAvailable.sgst + input.twoBAvailable.cess)} vs availed ${formatInr(availed.igst + availed.cgst + availed.sgst + availed.cess)}; tolerance ${formatInr(tolerance)} per head.`
        : `Table 8 skipped: no 2B annual figure supplied.`,
      `Table 9 outward: taxable value ${formatInr(outward.taxableValue)}; tax ${formatInr(outward.igst + outward.cgst + outward.sgst + outward.cess)}.`,
    ],
  };
}

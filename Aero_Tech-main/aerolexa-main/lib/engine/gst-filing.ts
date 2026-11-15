/**
 * gst-filing API bridge — the rupee/paise seam between the books GST-filing
 * route and the integer-paise GSTR-9 engine.
 *
 * Every GST/CA route in this app takes money in RUPEES at the API boundary and
 * converts to integer paise for the engines (`app/api/ca/compute` and
 * `app/api/gst/itc-recon` both do exactly this). The gst-filing route is kept
 * to the same contract: a reviewer enters rupees in the workspace, the route
 * converts, and the engine receives honest integer paise.
 *
 * The conversion lives here, not inline in the route, so it is a pure function
 * that can be pinned by a hand-computed unit test without a database or server.
 */

import type { Gstr9Input, Gstr9TaxAmounts } from "./gstr-9";

/** Rupees (API boundary) → integer paise (engine contract). */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** The four tax heads a caller supplies, in rupees. */
export interface MoneyRupees {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface MonthlyOutwardRupees extends MoneyRupees {
  month: string;
  taxableValue: number;
}

export interface MonthlyItcRupees extends MoneyRupees {
  month: string;
}

/**
 * GSTR-9 campaign payload as accepted by the route (all money in rupees). The
 * monthly arrays may legitimately carry a single annual row: the engine sums
 * them, so "one period" is an honest annual figure.
 */
export interface Gstr9CampaignInput {
  bookId: string;
  fy: string; // yyyy-yy
  gstin: string;
  monthlyOutward: MonthlyOutwardRupees[];
  monthlyItcAvailed: MonthlyItcRupees[];
  monthlyItcReversed?: MonthlyItcRupees[];
  importsItc?: MoneyRupees;
  monthlyRcm?: MonthlyItcRupees[];
  twoBAvailable?: MoneyRupees;
  previousYearClaims?: MoneyRupees;
  /** Rupee tolerance for Table 8C (default ₹1). */
  tolerance?: number;
}

function itcToPaise(m: MoneyRupees): Gstr9TaxAmounts {
  return {
    taxableValue: 0,
    igst: toPaise(m.igst),
    cgst: toPaise(m.cgst),
    sgst: toPaise(m.sgst),
    cess: toPaise(m.cess),
  };
}

/**
 * Convert a caller-supplied (rupee) GSTR-9 payload into the integer-paise input
 * `buildGstr9` expects. Array lengths are preserved.
 */
export function gstr9InputFromCampaign(body: Gstr9CampaignInput): Gstr9Input {
  return {
    fy: body.fy,
    outward: body.monthlyOutward.map((m) => ({
      taxableValue: toPaise(m.taxableValue),
      igst: toPaise(m.igst),
      cgst: toPaise(m.cgst),
      sgst: toPaise(m.sgst),
      cess: toPaise(m.cess),
    })),
    itcAvailed: body.monthlyItcAvailed.map(itcToPaise),
    itcReversed: body.monthlyItcReversed?.map(itcToPaise),
    importsItc: body.importsItc ? itcToPaise(body.importsItc) : undefined,
    rcm: body.monthlyRcm?.map(itcToPaise),
    twoBAvailable: body.twoBAvailable ? itcToPaise(body.twoBAvailable) : undefined,
    previousYearClaims: body.previousYearClaims ? itcToPaise(body.previousYearClaims) : undefined,
    tolerance: body.tolerance !== undefined ? toPaise(body.tolerance) : undefined,
  };
}

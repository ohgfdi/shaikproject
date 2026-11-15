/**
 * AR / AP ageing engine — receivables, payables and the MSME 43B(h) exposure.
 *
 * What a CA actually produces at every close:
 *   - the customer ageing (0-30/31-60/61-90/90+ buckets) for the debtors note
 *   - the supplier ageing for the creditors note
 *   - the MSME u/s 43B(h) exposure: amounts outstanding to micro & small
 *     suppliers beyond 45 days are DISALLOWED until paid, effective MY 2024-25.
 *
 * SCOPE AND HONESTY — `msmeRegistration` on a supplier is caller-supplied
 * data; the engine does not query the Udyam registry. The disallowance here is
 * the tax-computation view (add back the unpaid >45-day balance), not advice;
 * interest u/s 16 of the MSMED Act (compounding at 3× bank rate) is computed
 * separately with caller-supplied rates because they are DATA that moves.
 *
 * Money is in MINOR UNITS (paise) as integers. Dates are yyyy-mm-dd. Buckets
 * are computed on WHOLE days from the invoice date to the as-of date.
 */

import { formatInr, INR } from "./india-tax";

export class AgeingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgeingError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface OpenInvoice {
  /** Invoice / bill number. */
  number: string;
  counterparty: string;
  date: string;
  /** Outstanding balance in minor units (positive). */
  outstanding: number;
  /** AP only: is the supplier registered as micro/small on Udyam? */
  msmeRegistration?: boolean;
}

/** Ageing buckets, labelled the way Indian statements show them. */
export const AGEING_BUCKETS = ["0-30", "31-60", "61-90", "91-180", "180+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function bucketFor(days: number): AgeingBucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 180) return "91-180";
  return "180+";
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

export interface AgeingRow {
  counterparty: string;
  buckets: Record<AgeingBucket, number>;
  total: number;
}

export interface AgeingResult {
  asOfDate: string;
  rows: AgeingRow[];
  /** Bucket totals across all counterparties. */
  byBucket: Record<AgeingBucket, number>;
  total: number;
  methodology: string[];
}

/** Whole days outstanding from invoice date to as-of date. */
function daysOutstanding(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    throw new AgeingError(`Invalid date — expected yyyy-mm-dd (got "${fromIso}" .. "${toIso}").`);
  }
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

function emptyBuckets(): Record<AgeingBucket, number> {
  return { "0-30": 0, "31-60": 0, "61-90": 0, "91-180": 0, "180+": 0 };
}

/**
 * Age open invoices into the five standard buckets.
 *
 * A 60-day-old invoice sits in "31-60" (days 31..60 inclusive) — the bucket
 * boundaries the tests pin exactly.
 */
export function ageInvoices(input: { invoices: OpenInvoice[]; asOfDate: string }): AgeingResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) throw new AgeingError("asOfDate must be yyyy-mm-dd.");

  const byParty = new Map<string, AgeingRow>();
  const byBucket = emptyBuckets();
  let total = 0;

  for (const inv of input.invoices) {
    if (!Number.isFinite(inv.outstanding) || inv.outstanding < 0) {
      throw new AgeingError(
        `Invoice ${inv.number}: outstanding must be a non-negative amount (got ${inv.outstanding}).`,
      );
    }
    const days = daysOutstanding(inv.date, input.asOfDate);
    const bucket = bucketFor(days);
    const party = inv.counterparty.trim() || "(unknown)";
    const row = byParty.get(party) ?? { counterparty: party, buckets: emptyBuckets(), total: 0 };
    row.buckets[bucket] += inv.outstanding;
    row.total += inv.outstanding;
    byParty.set(party, row);
    byBucket[bucket] += inv.outstanding;
    total += inv.outstanding;
  }

  const rows = [...byParty.values()].sort((a, b) => b.total - a.total);

  return {
    asOfDate: input.asOfDate,
    rows,
    byBucket,
    total,
    methodology: [
      `Aged ${input.invoices.length} open invoice(s) as at ${input.asOfDate} on whole days from the invoice date.`,
      `Buckets: 0-30 / 31-60 / 61-90 / 91-180 / 180+ days; boundaries are inclusive lower, exclusive upper (day 31 begins "31-60").`,
      `Total outstanding ${formatInr(total)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// MSME 43B(h)
// ---------------------------------------------------------------------------

export interface MsmeSupplier {
  name: string;
  /** Registered as micro or small on Udyam (medium is NOT covered). */
  isMsme: boolean;
  /** Interest rate for s16 MSMED delay payments, % per annum (caller data). */
  msmeInterestRatePct: number;
}

export interface MsmeExposure {
  /** Suppliers flagged MSME. */
  suppliers: {
    name: string;
    outstanding: number;
    oldestInvoiceDate: string;
    /** Days the OLDEST unpaid invoice has been outstanding. */
    daysOutstanding: number;
    /** Balance beyond 45 days — disallowed u/s 43B(h) until paid. */
    disallowed: number;
    /** Interest u/s 16 MSMED on the disallowed balance, to the as-of date. */
    interestLiability: number;
  }[];
  /** Total add-back under 43B(h) for the tax computation. */
  totalDisallowed: number;
  totalInterestLiability: number;
  methodology: string[];
}

/**
 * MSME exposure u/s 43B(h): the unpaid balance of MSME invoices outstanding
 * beyond 45 days is added back to taxable income until paid. Interest u/s 16
 * of the MSMED Act accrues on that balance at the caller-supplied rate
 * (statutorily 3× the RBI bank rate — the rate itself is DATA, not hardcoded).
 */
export function msme43bh(input: {
  invoices: OpenInvoice[];
  suppliers: MsmeSupplier[];
  asOfDate: string;
}): MsmeExposure {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) throw new AgeingError("asOfDate must be yyyy-mm-dd.");
  const supplierByName = new Map(input.suppliers.map((s) => [s.name.trim().toLowerCase(), s] as const));

  interface Acc {
    outstanding: number;
    oldestDate: string;
    beyond45: number;
  }
  const acc = new Map<string, Acc>();

  for (const inv of input.invoices) {
    if (inv.outstanding <= 0) continue;
    const supplier = supplierByName.get(inv.counterparty.trim().toLowerCase());
    if (!supplier?.isMsme) continue;
    const days = daysOutstanding(inv.date, input.asOfDate);
    const entry = acc.get(supplier.name) ?? { outstanding: 0, oldestDate: inv.date, beyond45: 0 };
    entry.outstanding += inv.outstanding;
    if (inv.date < entry.oldestDate) entry.oldestDate = inv.date;
    // Only the portion of THIS invoice beyond 45 days adds back; the
    // days-based test is per invoice, not per supplier balance.
    if (days > 45) entry.beyond45 += inv.outstanding;
    acc.set(supplier.name, entry);
  }

  const suppliers = [...acc.entries()]
    .map(([name, e]) => {
      const cfg = supplierByName.get(name.toLowerCase())!;
      const days = daysOutstanding(e.oldestDate, input.asOfDate);
      // Interest u/s 16 runs from the day after the 45-day window closes.
      const interestDays = Math.max(0, days - 45);
      const interestLiability = Math.round((e.beyond45 * cfg.msmeInterestRatePct * interestDays) / (100 * 365));
      return {
        name,
        outstanding: e.outstanding,
        oldestInvoiceDate: e.oldestDate,
        daysOutstanding: days,
        disallowed: e.beyond45,
        interestLiability,
      };
    })
    .sort((a, b) => b.disallowed - a.disallowed);

  const totalDisallowed = suppliers.reduce((s, x) => s + x.disallowed, 0);
  const totalInterestLiability = suppliers.reduce((s, x) => s + x.interestLiability, 0);

  return {
    suppliers,
    totalDisallowed,
    totalInterestLiability,
    methodology: [
      `43B(h): unpaid MSME balances beyond 45 days from the invoice date are disallowed until paid (finance act effective MY 2024-25); assessed as at ${input.asOfDate}.`,
      `s16 MSMED interest accrues on the disallowed balance from day 46 at the caller-supplied rate(s); it is contingent on payment delay, not on the add-back.`,
      `${suppliers.length} MSME supplier(s) with exposure; disallowance ${formatInr(totalDisallowed)}; contingent interest ${formatInr(totalInterestLiability)}.`,
    ],
  };
}

/** Convenience for callers composing the tax note. */
export function msmeInterestDays(invoiceDate: string, asOfDate: string): number {
  return Math.max(0, daysOutstanding(invoiceDate, asOfDate) - 45);
}

/** Re-exported so API layers need only this module. */
export { INR };

/**
 * Effective-dated late-filing penalty schedules.
 *
 * `late-filing-exposure.ts` used to encode only the three return families whose
 * rates it could defend (GST, TDS, income tax) and return `unknown` for
 * everything else. That was honest, but it meant a company-law obligation
 * (AOC-4, MGT-7, LLP-11, DIR-3 KYC) could never be priced even though its fee
 * is published and arithmetic.
 *
 * This module is the data layer for those schedules. Each entry carries the
 * window it was in force, the fee, the citation an auditor can check, and the
 * assumptions the figure relies on. A lookup resolves the schedule in force on
 * the obligation's due date — never "today" — so a report regenerated years
 * later reproduces the same number.
 *
 * Honesty rules:
 *  - an unencoded obligation resolves to null, never to a guessed rate;
 *  - a schedule is only used inside its effective window;
 *  - beyond the point where the statute switches to an alternative fee, the
 *    per-day product is labelled `upper-bound`, not exact.
 *
 * All amounts are integer paise.
 */

import type { ExposureBasis, FilingRegime } from "@/lib/engine/late-filing-exposure";

export interface PenaltySchedule {
  id: string;
  /** Calendar task codes this schedule prices. */
  codes: string[];
  regime: FilingRegime;
  label: string;
  /** Inclusive start of the effective window (yyyy-mm-dd). */
  effectiveFrom: string;
  /** Exclusive end of the window, or null = still in force. */
  effectiveTo: string | null;
  /** Additional fee per day late, in paise. Exactly one of these is set. */
  feePerDayMinor: number | null;
  /** Flat late fee, in paise. Exactly one of these is set. */
  flatFeeMinor: number | null;
  /**
   * After this many days the statute switches to an alternative fee (for the
   * MCA forms, 12× the normal filing fee). The per-day product is then an
   * upper bound rather than the exact amount.
   */
  alternativeFeeAfterDays: number | null;
  citation: string;
  assumptions: string[];
}

/**
 * The encoded schedules. Every number here is a published fee, verified
 * against the rule named in `citation`; nothing is extrapolated.
 */
export const PENALTY_SCHEDULES: PenaltySchedule[] = [
  {
    id: "mca-additional-fee-2014",
    codes: ["AOC-4", "MGT-7", "LLP-8", "LLP-11"],
    regime: "mca-return",
    label: "MCA additional filing fee",
    effectiveFrom: "2014-04-01",
    effectiveTo: null,
    feePerDayMinor: 100_00, // ₹100 per day
    flatFeeMinor: null,
    alternativeFeeAfterDays: 180,
    citation:
      "Companies Act 2013 s.403(1) with the Companies (Registration Offices and Fees) Rules, 2014 — additional fee of ₹100 per day per document.",
    assumptions: [
      "₹100/day is charged per document; one obligation is one document here.",
      "Beyond 180 days the statute permits an alternative fee (12× the normal filing fee), so the per-day product is reported as an upper bound.",
      "No interest is added: the MCA additional fee is the whole consequence encoded here.",
    ],
  },
  {
    id: "dir-3-kyc-late-fee-2018",
    codes: ["DIR-3-KYC"],
    regime: "mca-return",
    label: "DIR-3 KYC late fee",
    effectiveFrom: "2018-04-01",
    effectiveTo: null,
    feePerDayMinor: null,
    flatFeeMinor: 5_000_00, // ₹5,000 flat
    alternativeFeeAfterDays: null,
    citation:
      "Rule 12A, Companies (Appointment and Qualification of Directors) Rules, 2014 — ₹5,000 fee where the KYC form is filed after the due date.",
    assumptions: [
      "The fee is flat: it does not grow with the number of days late.",
      "Disqualification consequences under s.164 are separate and not priced here.",
    ],
  },
];

function dayMs(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The schedule in force for a task code on a date. A malformed date resolves to
 * null rather than falling back to the newest schedule.
 */
export function penaltyScheduleFor(code: string, asOn: string): PenaltySchedule | null {
  const at = dayMs(asOn);
  if (at === null) return null;
  const matches = PENALTY_SCHEDULES.filter((schedule) => {
    if (!schedule.codes.includes(code)) return false;
    const from = dayMs(schedule.effectiveFrom);
    if (from === null || from > at) return false;
    if (schedule.effectiveTo === null) return true;
    const to = dayMs(schedule.effectiveTo);
    return to !== null && at < to;
  });
  if (matches.length === 0) return null;
  // Latest start wins when windows overlap.
  return matches.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]!;
}

export interface SchedulePenalty {
  feeMinor: number;
  basis: Extract<ExposureBasis, "exact" | "upper-bound">;
}

/**
 * Apply a schedule to a number of days late. Kept separate from the lookup so
 * the arithmetic is oracle-testable without any dates.
 */
export function applyPenaltySchedule(
  schedule: PenaltySchedule,
  daysLate: number,
): SchedulePenalty | null {
  if (!Number.isFinite(daysLate) || daysLate <= 0) return null;
  if (schedule.flatFeeMinor !== null) {
    return { feeMinor: schedule.flatFeeMinor, basis: "exact" };
  }
  if (schedule.feePerDayMinor !== null) {
    const feeMinor = daysLate * schedule.feePerDayMinor;
    const upperBound =
      schedule.alternativeFeeAfterDays !== null && daysLate > schedule.alternativeFeeAfterDays;
    return { feeMinor, basis: upperBound ? "upper-bound" : "exact" };
  }
  return null;
}

/**
 * Late-filing exposure — what being late costs, computed from the two dates the
 * firm already has: the statutory due date and the date the return was filed.
 *
 * SCOPE AND HONESTY
 *
 * These are arithmetic estimates on statutory rates, not a legal opinion. The
 * final fee/interest is determined by the portal or the Assessing Officer, and
 * an extension or a waiver can change it. Every row therefore carries the rule
 * it used, its assumptions, and a `basis`:
 *
 *   exact        every component is computable from recorded facts
 *   partial      the fee is exact but an interest component is not recorded
 *   upper-bound  a cap depends on an amount the firm has not recorded, so the
 *                figure is the maximum that could apply
 *   unknown      no rule is encoded for this obligation type
 *
 * Figures are never guessed. Where the tax amount is missing the interest is
 * `null`, not zero.
 *
 * RULES ENCODED (as at 2026, check the portal for the period in question):
 *
 *   GST return (GSTR-1 / GSTR-3B)
 *     Late fee ₹50 per day (₹25 CGST + ₹25 SGST), capped at ₹5,000 for a
 *     taxable return and ₹2,000 for a nil return. Interest u/s 50 is 18% p.a.
 *     on tax paid late — computable only when the tax amount is known.
 *
 *   TDS return (26Q / 27Q)
 *     Fee u/s 234E ₹200 per day, capped at the TDS amount. Interest u/s 201(1A)
 *     on a late deposit is a separate computation (the TDS suite owns it), so it
 *     is not double-counted here.
 *
 *   Income-tax return (ITR)
 *     Interest u/s 234A is 1% per month or part of a month on unpaid tax. The
 *     ₹234F late-filing fee is NOT included — it depends on total income and is
 *     deliberately left to the direct-tax computation.
 *
 *   Everything else (AOC-4, MGT-7, LLP-11, DIR-3 KYC, PT, advance tax, TDS
 *   payment) uses a different fee schedule under a different Act, so this
 *   engine returns `unknown` rather than inventing one.
 *
 * All amounts are integer paise.
 */

import { applyPenaltySchedule, penaltyScheduleFor } from "@/lib/engine/penalty-schedule";
import { computePtLateFee, ptLateRuleFor } from "@/lib/engine/pt-late-fee";

export type FilingRegime =
  | "gst-return"
  | "tds-return"
  | "income-tax-return"
  | "mca-return"
  | "professional-tax"
  | "other";

export type ExposureBasis = "exact" | "partial" | "upper-bound" | "unknown";

export interface LateFilingExposureInput {
  regime: FilingRegime;
  /** Calendar task code (AOC-4, DIR-3-KYC, …) — selects the penalty schedule. */
  code?: string;
  /** GST state code or state name, for professional tax. */
  state?: string | null;
  dueDate: string;
  /** Actual filing date; null while the obligation is still open. */
  filedDate: string | null;
  /** The date "still open" is measured at. */
  asOf: string;
  /** Tax paid late, in paise, when recorded. Drives the interest component. */
  taxMinor?: number | null;
  /** Nil GST return — lowers the late-fee cap from ₹5,000 to ₹2,000. */
  nilReturn?: boolean;
}

export interface LateFilingExposure {
  /** Whole days past the due date; 0 when filed on time or not yet due. */
  daysLate: number;
  filed: boolean;
  regime: FilingRegime;
  /** Statutory fee, in paise. Null when the rule cannot be applied. */
  feeMinor: number | null;
  /** Interest, in paise. Null when the tax amount or the rule is unavailable. */
  interestMinor: number | null;
  /**
   * What the firm could owe on the recorded facts. Null only when nothing is
   * computable — a partial figure is returned with `basis: "partial"`.
   */
  totalMinor: number | null;
  basis: ExposureBasis;
  /** One-line description of the rule actually applied. */
  rule: string;
  assumptions: string[];
}

const DAY_MS = 86_400_000;

const GST_FEE_PER_DAY_MINOR = 50_00; // ₹50 = 5,000 paise
const GST_CAP_TAXABLE_MINOR = 5_000_00; // ₹5,000
const GST_CAP_NIL_MINOR = 2_000_00; // ₹2,000
const TDS_FEE_PER_DAY_MINOR = 200_00; // ₹200

function dayMs(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whole days from `from` to `to`; 0 or negative means not late. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayMs(from);
  const b = dayMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** Whole months or part of a month between two dates (s.234A convention). */
export function monthsOrPartBetween(from: string, to: string): number | null {
  const a = dayMs(from);
  const b = dayMs(to);
  if (a === null || b === null) return null;
  if (b <= a) return 0;
  const start = new Date(a);
  const end = new Date(b);
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  // Any part of a month counts as a full month.
  if (end.getUTCDate() > start.getUTCDate()) months += 1;
  return Math.max(1, months);
}

function paise(value: number): number {
  return Math.round(value);
}

/** Detect the regime from the calendar's stable task code. */
export function regimeForTaskCode(code: string): FilingRegime {
  if (code.startsWith("GSTR")) return "gst-return";
  // TDS-PAYMENT is a deposit, not a return: 201(1A) interest, not 234E.
  if (code === "TDS-26Q" || code === "TDS-27Q") return "tds-return";
  if (code === "ITR") return "income-tax-return";
  // Company-law forms with an encoded, effective-dated additional fee.
  if (["AOC-4", "MGT-7", "LLP-8", "LLP-11", "DIR-3-KYC"].includes(code)) return "mca-return";
  // Professional tax is a state subject; the regime is named so the report can
  // say *why* it is unpriced instead of lumping it into "other".
  if (code === "PT-RETURN" || code === "PT") return "professional-tax";
  return "other";
}

/** Compute the exposure for one obligation. Pure. */
export function lateFilingExposure(input: LateFilingExposureInput): LateFilingExposure {
  const end = input.filedDate ?? input.asOf;
  const diff = daysBetween(input.dueDate, end);
  const daysLate = diff === null ? 0 : Math.max(0, diff);
  const filed = input.filedDate !== null;
  const tax = typeof input.taxMinor === "number" && Number.isFinite(input.taxMinor) && input.taxMinor > 0
    ? input.taxMinor
    : null;

  if (diff === null) {
    return {
      daysLate: 0,
      filed,
      regime: input.regime,
      feeMinor: null,
      interestMinor: null,
      totalMinor: null,
      basis: "unknown",
      rule: "No rule applied — one of the dates is not a calendar date.",
      assumptions: [],
    };
  }

  if (daysLate === 0) {
    return {
      daysLate: 0,
      filed,
      regime: input.regime,
      feeMinor: 0,
      interestMinor: 0,
      totalMinor: 0,
      basis: "exact",
      rule: filed ? "Filed on or before the due date." : "Not yet due.",
      assumptions: [],
    };
  }

  switch (input.regime) {
    case "gst-return": {
      const cap = input.nilReturn ? GST_CAP_NIL_MINOR : GST_CAP_TAXABLE_MINOR;
      const fee = Math.min(daysLate * GST_FEE_PER_DAY_MINOR, cap);
      const interest = tax === null ? null : paise((tax * 0.18 * daysLate) / 365);
      const assumptions = [
        `Late fee ₹50/day (₹25 CGST + ₹25 SGST), capped at ${input.nilReturn ? "₹2,000 (nil return)" : "₹5,000"}.`,
      ];
      if (interest === null) {
        assumptions.push(
          "Interest u/s 50 (18% p.a.) is not included because the tax paid late is not recorded.",
        );
      }
      return {
        daysLate,
        filed,
        regime: "gst-return",
        feeMinor: fee,
        interestMinor: interest,
        totalMinor: fee + (interest ?? 0),
        basis: interest === null ? "partial" : "exact",
        rule: `GST late fee ₹50/day (cap ₹${input.nilReturn ? "2,000" : "5,000"})${interest === null ? "" : " + 18% p.a. interest u/s 50"}.`,
        assumptions,
      };
    }

    case "tds-return": {
      const uncapped = daysLate * TDS_FEE_PER_DAY_MINOR;
      const fee = tax === null ? uncapped : Math.min(uncapped, tax);
      return {
        daysLate,
        filed,
        regime: "tds-return",
        feeMinor: fee,
        interestMinor: null,
        totalMinor: fee,
        basis: tax === null ? "upper-bound" : "exact",
        rule: "Fee u/s 234E ₹200/day, capped at the TDS amount.",
        assumptions: [
          ...(tax === null
            ? ["The TDS amount is not recorded, so the ₹200/day figure is the uncapped maximum."]
            : ["Capped at the recorded TDS amount."]),
          "Interest u/s 201(1A) on a late deposit is computed by the TDS suite, not here.",
        ],
      };
    }

    case "income-tax-return": {
      if (tax === null) {
        return {
          daysLate,
          filed,
          regime: "income-tax-return",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: "Interest u/s 234A is 1% per month or part of a month on unpaid tax.",
          assumptions: [
            "Unpaid tax is not recorded, so no interest figure is computed.",
            "The s.234F late-filing fee is not included (it depends on total income).",
          ],
        };
      }
      const months = monthsOrPartBetween(input.dueDate, end) ?? 1;
      const interest = paise(tax * 0.01 * months);
      return {
        daysLate,
        filed,
        regime: "income-tax-return",
        feeMinor: 0,
        interestMinor: interest,
        totalMinor: interest,
        basis: "partial",
        rule: `Interest u/s 234A: 1% × ${months} month(s) on unpaid tax.`,
        assumptions: ["The s.234F late-filing fee is not included (it depends on total income)."],
      };
    }

    case "mca-return": {
      // The schedule is selected by the obligation's DUE DATE, not by today's
      // date: a report regenerated later must reproduce the fee that applied
      // when the deadline passed.
      const schedule = input.code ? penaltyScheduleFor(input.code, input.dueDate) : null;
      const penalty = schedule ? applyPenaltySchedule(schedule, daysLate) : null;
      if (!schedule || !penalty) {
        return {
          daysLate,
          filed,
          regime: "mca-return",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: input.code
            ? `No MCA penalty schedule is encoded for ${input.code} on ${input.dueDate}.`
            : "No obligation code was supplied, so the MCA fee schedule cannot be selected.",
          assumptions: ["Verify the current MCA fee schedule before quoting a figure."],
        };
      }
      return {
        daysLate,
        filed,
        regime: "mca-return",
        feeMinor: penalty.feeMinor,
        interestMinor: null,
        totalMinor: penalty.feeMinor,
        basis: penalty.basis,
        rule: schedule.citation,
        assumptions: schedule.assumptions,
      };
    }

    case "professional-tax": {
      const rule = input.state ? ptLateRuleFor(input.state, input.dueDate) : null;
      if (!input.state || !rule) {
        return {
          daysLate,
          filed,
          regime: "professional-tax",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: "Professional-tax late payment is governed by each state's Act and rate schedule.",
          assumptions: [
            input.state
              ? `No encoded professional-tax rule matches "${input.state}" on ${input.dueDate}.`
              : "The client's state is not recorded on the obligation, so no figure is computed.",
          ],
        };
      }
      if (rule.status === "conflicting" || rule.monthlyInterestBps === null) {
        return {
          daysLate,
          filed,
          regime: "professional-tax",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: `${rule.stateName}: ${rule.citation}`,
          assumptions: rule.assumptions,
        };
      }
      if (tax === null) {
        return {
          daysLate,
          filed,
          regime: "professional-tax",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: `${rule.stateName}: ${rule.citation}`,
          assumptions: [
            "The tax paid late is not recorded, so interest (a percentage of that tax) cannot be computed.",
            ...rule.assumptions,
          ],
        };
      }
      const months = monthsOrPartBetween(input.dueDate, end) ?? 1;
      const computed = computePtLateFee(rule, tax, months);
      if (!computed) {
        return {
          daysLate,
          filed,
          regime: "professional-tax",
          feeMinor: null,
          interestMinor: null,
          totalMinor: null,
          basis: "unknown",
          rule: `${rule.stateName}: ${rule.citation}`,
          assumptions: rule.assumptions,
        };
      }
      return {
        daysLate,
        filed,
        regime: "professional-tax",
        feeMinor: computed.penaltyMinor,
        interestMinor: computed.interestMinor,
        totalMinor: computed.totalMinor,
        basis: "partial",
        rule: `${rule.stateName}: ${rule.citation}`,
        assumptions: [
          `Interest applied over ${months} month${months === 1 ? "" : "s"} at ${computed.monthlyBpsApplied
            .map((bps) => `${bps / 100}%`)
            .join(", ")}.`,
          ...rule.assumptions,
        ],
      };
    }

    default:
      return {
        daysLate,
        filed,
        regime: input.regime,
        feeMinor: null,
        interestMinor: null,
        totalMinor: null,
        basis: "unknown",
        rule: "No late-filing rule is encoded for this obligation type.",
        assumptions: [
          "Advance-tax and other late consequences use different schedules and are not estimated here.",
        ],
      };
  }
}

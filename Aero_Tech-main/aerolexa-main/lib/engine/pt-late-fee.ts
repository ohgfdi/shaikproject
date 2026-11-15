/**
 * Professional-tax late-payment rules for the states a firm is most likely to
 * file in.
 *
 * Unlike GST/TDS, professional tax is a state subject: the interest rate, the
 * penalty and even whether the state levies PT at all differ by Act. This module
 * encodes only rates that a primary or official source supports, and it says so
 * when sources disagree.
 *
 * Honesty rules:
 *  - no rule = no figure (the caller reports "state not recorded" or
 *    "sources conflict", never a national average);
 *  - interest needs the tax that was paid late; without it the figure is null;
 *  - a penalty that the Act leaves discretionary ("up to 50%") is NOT priced;
 *  - interest is simple, per month or part of a month, on the unpaid tax.
 *
 * All amounts are integer paise. Rates are basis points of tax per month
 * (100 bps = 1%).
 */

export type PtRuleStatus = "encoded" | "conflicting";

export interface PtLateRule {
  stateCode: string;
  stateName: string;
  status: PtRuleStatus;
  /**
   * Flat monthly interest in basis points. For a graded schedule this is the
   * rate after the graded months. Null = not priced.
   */
  monthlyInterestBps: number | null;
  /** Early months charged at a different rate (inclusive upper bound). */
  gradedInterestBps?: { upToMonth: number; bps: number }[];
  /** One-time penalty in basis points of tax due, when the Act fixes it. */
  penaltyBps: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  citation: string;
  assumptions: string[];
}

/**
 * The encoded rules. State codes are the GST state codes used by
 * `lib/engine/professional-tax.ts`.
 */
export const PT_LATE_RULES: Record<string, PtLateRule> = {
  "14": {
    stateCode: "14",
    stateName: "Maharashtra",
    status: "encoded",
    // s.9(2), w.e.f. 1 May 2017: 1.25% for the first month, 1.5% for the 2nd
    // and 3rd, 2% from the 4th month onward.
    monthlyInterestBps: 200,
    gradedInterestBps: [
      { upToMonth: 1, bps: 125 },
      { upToMonth: 3, bps: 150 },
    ],
    penaltyBps: 1_000, // 10% of tax due (s.9), after a hearing
    effectiveFrom: "2017-05-01",
    effectiveTo: null,
    citation:
      "Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975, s.9(2) (graded interest) and s.9 (penalty equal to 10% of tax due).",
    assumptions: [
      "Interest is simple, per month or part of a month, on the unpaid tax.",
      "The 10% penalty is discretionary (imposed after a hearing); it is included as the statutory amount, not as a certainty.",
      "The ₹1,000 late-return fee is a filing consequence and is not added to the tax exposure.",
    ],
  },
  "29": {
    stateCode: "29",
    stateName: "Karnataka",
    status: "encoded",
    monthlyInterestBps: 150, // 1.5% p.m., raised from 1.25% by Act 14 of 2023
    penaltyBps: 1_000, // 10% of tax due, Act 14 of 2023
    effectiveFrom: "2023-04-01",
    effectiveTo: null,
    citation:
      "Karnataka Tax on Professions, Trades, Callings and Employments Act, 1976, s.11(2) and s.12, as amended by Karnataka Act 14 of 2023 — 1.5% per month and a 10% penalty.",
    assumptions: [
      "Interest is simple, per month or part of a month, on the unpaid tax.",
      "The 10% penalty is included as the statutory amount; the Act allows the authority to impose it.",
      "Older 1.25% / 50% figures quoted by secondary sources are superseded from 1 April 2023.",
    ],
  },
  "28": {
    stateCode: "28",
    stateName: "West Bengal",
    status: "encoded",
    monthlyInterestBps: 100, // 1% p.m.
    penaltyBps: null, // "up to 50%" is discretionary and is not priced
    effectiveFrom: "1979-04-01",
    effectiveTo: null,
    citation:
      "West Bengal State Tax on Professions, Trades, Callings and Employments Act, 1979 — simple interest at 1% per month on unpaid tax; penalty up to 50% at the authority's discretion.",
    assumptions: [
      "Interest is simple, per month or part of a month, on the unpaid tax.",
      "The discretionary penalty (up to 50%) is NOT included; the total is therefore a lower bound.",
      "The rate is the one published for 2026; earlier amendments are not modelled.",
    ],
  },
  "07": {
    stateCode: "07",
    stateName: "Gujarat",
    status: "encoded",
    monthlyInterestBps: 150, // 18% p.a. = 1.5% p.m.
    penaltyBps: null,
    effectiveFrom: "1976-04-01",
    effectiveTo: null,
    citation:
      "Gujarat State Tax on Professions, Trades, Callings and Employments Act, 1976 — interest at 18% per annum on delayed payment (1.5% per month).",
    assumptions: [
      "18% per annum is applied as 1.5% per month on the unpaid tax.",
      "The separate penalty schedule is not encoded, so the total is interest only.",
    ],
  },
  "23": {
    stateCode: "23",
    stateName: "Tamil Nadu",
    status: "conflicting",
    monthlyInterestBps: null,
    penaltyBps: null,
    effectiveFrom: "1998-04-01",
    effectiveTo: null,
    citation:
      "Tamil Nadu Urban Local Bodies Act, 1998, s.117-F and the 2023 Rules — secondary sources quote both 1% and 2% per month for profession tax.",
    assumptions: [
      "Published sources disagree (1% per month under Rule 286 vs 2% per month in several payroll guides), so no figure is computed.",
      "Confirm the rate with the local body before quoting an exposure.",
    ],
  },
};

/**
 * Resolve a rule by GST state code or state name (the client profile may carry
 * either), inside the rule's effective window.
 */
export function ptLateRuleFor(state: string, asOn?: string): PtLateRule | null {
  const needle = state.trim().toLowerCase();
  if (!needle) return null;
  const direct = PT_LATE_RULES[needle];
  const byName = direct
    ? direct
    : Object.values(PT_LATE_RULES).find((rule) => rule.stateName.toLowerCase() === needle) ?? null;
  if (!byName) return null;
  if (asOn) {
    const at = Date.parse(`${asOn}T00:00:00Z`);
    if (!Number.isFinite(at)) return null;
    const from = Date.parse(`${byName.effectiveFrom}T00:00:00Z`);
    if (!Number.isFinite(from) || from > at) return null;
    if (byName.effectiveTo) {
      const to = Date.parse(`${byName.effectiveTo}T00:00:00Z`);
      if (!Number.isFinite(to) || at >= to) return null;
    }
  }
  return byName;
}

export interface PtLateComputation {
  interestMinor: number;
  /** Null when the Act leaves the penalty discretionary. */
  penaltyMinor: number | null;
  /** Interest plus any fixed penalty; a lower bound when penalty is null. */
  totalMinor: number;
  monthlyBpsApplied: number[];
}

function bid(rule: PtLateRule, month: number): number {
  const graded = rule.gradedInterestBps?.find((entry) => month <= entry.upToMonth);
  return graded?.bps ?? rule.monthlyInterestBps ?? 0;
}

/**
 * Simple interest on the unpaid tax for `monthsLate` months (each part month
 * counts as a full month), plus the fixed penalty when the Act sets one.
 */
export function computePtLateFee(
  rule: PtLateRule,
  taxMinor: number,
  monthsLate: number,
): PtLateComputation | null {
  if (rule.status !== "encoded" || rule.monthlyInterestBps === null) return null;
  if (!Number.isFinite(taxMinor) || taxMinor <= 0) return null;
  if (!Number.isFinite(monthsLate) || monthsLate <= 0) return null;

  const months = Math.floor(monthsLate);
  const monthlyBpsApplied: number[] = [];
  let interestMinor = 0;
  for (let month = 1; month <= months; month += 1) {
    const bps = bid(rule, month);
    monthlyBpsApplied.push(bps);
    interestMinor += Math.round((taxMinor * bps) / 10_000);
  }
  const penaltyMinor =
    rule.penaltyBps === null ? null : Math.round((taxMinor * rule.penaltyBps) / 10_000);
  return {
    interestMinor,
    penaltyMinor,
    totalMinor: interestMinor + (penaltyMinor ?? 0),
    monthlyBpsApplied,
  };
}

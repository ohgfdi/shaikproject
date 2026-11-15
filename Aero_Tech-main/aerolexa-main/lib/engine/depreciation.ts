/**
 * India depreciation engine — Companies Act 2013 (Schedule II) and the Income
 * tax Act, 1961 (block-of-asset WDV with the half-year rule).
 *
 * The two regimes answer different questions and must not be conflated:
 *
 *  - COMPANIES ACT depreciation is a BOOK entry. It is charged on the asset,
 *    over its useful life, on cost less residual value (residual value may not
 *    exceed 5% of original cost under Schedule II). Companies may use SLM for
 *    some classes and WDV for others.
 *  - INCOME TAX depreciation is a TAX deduction. It is charged on the BLOCK of
 *    assets on the written-down value at the block's rate, and an asset put to
 *    use for fewer than 180 days in the year of acquisition earns only HALF the
 *    rate. Because it is block-based, it cannot be derived per-asset.
 *
 * SCOPE AND HONESTY: rates and useful lives are DATA supplied by the caller;
 * the defaults are labelled with what they are (Schedule II lives / common
 * block rates). This computes the depreciation figure — it does not file an
 * ITR, and it does not model every proviso (e.g. the 32(1)(iia) additional-
 * depreciation eligibility rules beyond the caller's flag).
 *
 * Money is in MINOR UNITS (paise) as integers, matching the rest of the CA
 * engines.
 */

import { INR, formatInr } from "./india-tax";

export class DepreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepreciationError";
  }
}

/** Inclusive day count: both the from and the to date are counted. */
function daysInclusive(fromIso: string, toIso: string): number {
  return daysBetween(fromIso, toIso) + 1;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    throw new DepreciationError(`Invalid date — expected ISO yyyy-mm-dd (got "${fromIso}".."${toIso}").`);
  }
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Companies Act 2013, Schedule II — useful lives
// ---------------------------------------------------------------------------

export interface UsefulLifeClass {
  id: string;
  name: string;
  usefulLifeYears: number;
}

/** Common Schedule II Part C useful lives. Override per the actual asset class. */
export const COMPANIES_ACT_USEFUL_LIVES: readonly UsefulLifeClass[] = [
  { id: "building", name: "Building (RCC frame structure)", usefulLifeYears: 60 },
  { id: "plant-machinery", name: "Plant & machinery (general)", usefulLifeYears: 15 },
  { id: "electrical", name: "Electrical installations", usefulLifeYears: 10 },
  { id: "furniture", name: "Furniture & fittings", usefulLifeYears: 10 },
  { id: "vehicles", name: "Motor vehicles (general)", usefulLifeYears: 8 },
  { id: "computers", name: "Computers & data-processing units", usefulLifeYears: 3 },
  { id: "software", name: "Intangible — software", usefulLifeYears: 5 },
];

export interface CompaniesActDepreciationResult {
  method: "slm" | "wdv";
  cost: number;
  /** Carrying amount at the start of the period (cost in the year of purchase). */
  openingWdv: number;
  residualValue: number;
  depreciableAmount: number;
  usefulLifeYears: number;
  /** Annual depreciation for a full year on the opening carrying amount (minor units). */
  annualDepreciation: number;
  /** Depreciation for the supplied period (minor units). */
  periodDepreciation: number;
  /** Effective annual WDV rate (SLM: reported as the straight-line rate). */
  ratePct: number;
  days: number;
  methodology: string[];
}

/**
 * Companies Act depreciation for a period.
 *
 * SLM: (cost − residual) ÷ useful life, pro-rated by days, and never charged
 * below the residual value.
 * WDV: the rate r solves residual = cost·(1−r)^life, i.e.
 * r = 1 − (residual/cost)^(1/life). The rate is fixed by the ORIGINAL cost and
 * residual (Schedule II Part A), but each year's charge is on the OPENING
 * carrying amount, so pass `openingWdv` for every year after the first —
 * charging the rate on cost again would over-depreciate the asset.
 */
export function companiesActDepreciation(opts: {
  cost: number;
  usefulLifeYears: number;
  method: "slm" | "wdv";
  /** Residual value as a percentage of cost; Schedule II caps it at 5. */
  residualValuePct?: number;
  /** Period used, inclusive. Defaults to a full 365-day year. */
  from?: string;
  to?: string;
  /**
   * Carrying amount (cost less accumulated depreciation) at the start of the
   * period. Defaults to cost — correct only for the year the asset is bought.
   */
  openingWdv?: number;
}): CompaniesActDepreciationResult {
  const cost = Math.max(0, Math.round(opts.cost));
  const residualValuePct = opts.residualValuePct ?? 5;
  if (residualValuePct < 0 || residualValuePct > 5) {
    throw new DepreciationError(
      `Residual value ${residualValuePct}% exceeds the 5% ceiling in Schedule II of the Companies Act, 2013.`,
    );
  }
  if (!(opts.usefulLifeYears > 0)) {
    throw new DepreciationError("Useful life must be greater than zero years.");
  }
  if (opts.openingWdv !== undefined && opts.openingWdv < 0) {
    throw new DepreciationError("Opening carrying amount cannot be negative.");
  }
  const openingWdv = Math.max(0, Math.round(opts.openingWdv ?? cost));
  const residualValue = Math.round((cost * residualValuePct) / 100);
  const depreciableAmount = Math.max(0, cost - residualValue);
  const days = opts.from && opts.to ? daysBetween(opts.from, opts.to) : 365;
  // A full financial year can be 366 days — never charge more than one year.
  const yearFraction = Math.min(1, days / 365);
  // Depreciation stops once the carrying amount reaches the residual value.
  const chargeable = Math.max(0, openingWdv - residualValue);

  if (cost === 0) {
    return {
      method: opts.method,
      cost,
      openingWdv,
      residualValue: 0,
      depreciableAmount: 0,
      usefulLifeYears: opts.usefulLifeYears,
      annualDepreciation: 0,
      periodDepreciation: 0,
      ratePct: 0,
      days,
      methodology: ["Zero cost — nothing to depreciate."],
    };
  }

  if (opts.method === "slm") {
    const annualDepreciation = Math.round(depreciableAmount / opts.usefulLifeYears);
    const periodDepreciation = Math.min(Math.round(annualDepreciation * yearFraction), chargeable);
    return {
      method: "slm",
      cost,
      openingWdv,
      residualValue,
      depreciableAmount,
      usefulLifeYears: opts.usefulLifeYears,
      annualDepreciation,
      periodDepreciation,
      ratePct: (annualDepreciation / cost) * 100,
      days,
      methodology: [
        `SLM: (cost ${formatInr(cost)} − residual ${formatInr(residualValue)}) ÷ ${opts.usefulLifeYears} years = ${formatInr(annualDepreciation)} p.a.`,
        `Pro-rated over ${days} day(s) on the opening carrying amount ${formatInr(openingWdv)}: ${formatInr(periodDepreciation)}.`,
        openingWdv - periodDepreciation <= residualValue
          ? `Charged down to the residual value of ${formatInr(residualValue)}; no further charge.`
          : `Closing carrying amount ${formatInr(openingWdv - periodDepreciation)}.`,
      ],
    };
  }

  if (residualValue <= 0) {
    throw new DepreciationError(
      "The written-down-value method needs a non-zero residual value; at 0% the Schedule II rate is 100% and the asset would be written off in the first period. Use a 0-5% residual or the SLM method.",
    );
  }

  const wdvRate = 1 - Math.pow(residualValue / cost, 1 / opts.usefulLifeYears);
  const annualDepreciation = Math.round(openingWdv * wdvRate);
  const periodDepreciation = Math.min(
    Math.round(openingWdv - openingWdv * Math.pow(1 - wdvRate, yearFraction)),
    chargeable,
  );
  return {
    method: "wdv",
    cost,
    openingWdv,
    residualValue,
    depreciableAmount,
    usefulLifeYears: opts.usefulLifeYears,
    annualDepreciation,
    periodDepreciation,
    ratePct: wdvRate * 100,
    days,
    methodology: [
      `WDV rate on original cost = 1 − (residual/cost)^(1/life) = ${(wdvRate * 100).toFixed(2)}%.`,
      `Charge on the opening carrying amount ${formatInr(openingWdv)} for a full year = ${formatInr(annualDepreciation)}.`,
      `Pro-rated over ${days} day(s): ${formatInr(periodDepreciation)}; closing carrying amount ${formatInr(openingWdv - periodDepreciation)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Income tax Act — block-of-asset WDV
// ---------------------------------------------------------------------------

export interface BlockRate {
  id: string;
  name: string;
  ratePct: number;
}

/** Common block rates. The block — not the individual asset — carries the rate. */
export const INCOME_TAX_BLOCK_RATES: readonly BlockRate[] = [
  { id: "building-residential", name: "Residential buildings (other than hotels/boarding houses)", ratePct: 5 },
  { id: "building", name: "Non-residential buildings", ratePct: 10 },
  { id: "furniture", name: "Furniture & fittings", ratePct: 10 },
  { id: "plant-machinery", name: "Plant & machinery", ratePct: 15 },
  { id: "vehicles", name: "Motor vehicles", ratePct: 15 },
  { id: "computers", name: "Computers & software", ratePct: 40 },
  { id: "intangibles", name: "Intangible assets (know-how, patents, licences)", ratePct: 25 },
];

export interface ItDepreciationResult {
  ratePct: number;
  openingWdv: number;
  fullRateAdditions: number;
  halfRateAdditions: number;
  saleProceeds: number;
  /** Normal block depreciation (minor units). */
  normalDepreciation: number;
  /** Additional depreciation u/s 32(1)(iia) on eligible additions. */
  additionalDepreciation: number;
  totalDepreciation: number;
  closingWdv: number;
  /** Excess of sale proceeds over the block — a short-term capital gain u/s 50. */
  shortTermCapitalGain: number;
  methodology: string[];
}

/**
 * Income tax depreciation for a block of assets for a financial year.
 *
 * A new asset put to use for fewer than 180 days in the year of acquisition
 * receives HALF the block rate. The days are counted INCLUSIVELY (the day of
 * put-to-use through 31 March), so an asset put to use on 3 October has exactly
 * 180 days and takes the full rate — the familiar "before 4 October" rule.
 * `additionalEligible` marks new plant & machinery for the 32(1)(iia)
 * additional depreciation (also halved under 180 days). Sale proceeds reduce
 * the block; if they exceed it, the excess is a short-term capital gain u/s 50
 * and the closing WDV is nil.
 */
export function incomeTaxDepreciation(opts: {
  openingWdv: number;
  ratePct: number;
  fy: string;
  additions?: { amount: number; putToUseDate: string; additionalEligible?: boolean }[];
  saleProceeds?: number;
  /** Additional depreciation rate (e.g. 20 for 32(1)(iia)); omitted = none. */
  additionalDepreciationPct?: number;
}): ItDepreciationResult {
  const startYear = Number(opts.fy.slice(0, 4));
  if (!Number.isFinite(startYear)) {
    throw new DepreciationError(`Financial year must look like "2024-25"; got "${opts.fy}".`);
  }
  const fyStart = `${startYear}-04-01`;
  const fyEnd = `${startYear + 1}-03-31`;
  const openingWdv = Math.max(0, Math.round(opts.openingWdv));
  const saleProceeds = Math.max(0, Math.round(opts.saleProceeds ?? 0));

  let fullRateAdditions = 0;
  let halfRateAdditions = 0;
  let additionalDepreciation = 0;
  const additionalPct = opts.additionalDepreciationPct ?? 0;

  for (const add of opts.additions ?? []) {
    const amount = Math.max(0, Math.round(add.amount));
    if (add.putToUseDate > fyEnd) {
      throw new DepreciationError(
        `Asset put to use on ${add.putToUseDate} is after FY ${opts.fy} ends (${fyEnd}) — it cannot be an addition of this year.`,
      );
    }
    if (add.putToUseDate < fyStart) {
      throw new DepreciationError(
        `Asset put to use on ${add.putToUseDate} is before FY ${opts.fy} starts (${fyStart}) — it belongs in the opening block, not in additions.`,
      );
    }
    const daysUsed = daysInclusive(add.putToUseDate, fyEnd);
    const half = daysUsed < 180;
    if (half) halfRateAdditions += amount;
    else fullRateAdditions += amount;
    if (add.additionalEligible && additionalPct > 0) {
      additionalDepreciation += Math.round((amount * additionalPct) / (half ? 200 : 100));
    }
  }

  const normalDepreciation =
    Math.round(((openingWdv + fullRateAdditions) * opts.ratePct) / 100) +
    Math.round((halfRateAdditions * (opts.ratePct / 2)) / 100);
  const totalDepreciation = normalDepreciation + additionalDepreciation;

  const rawClosing = openingWdv + fullRateAdditions + halfRateAdditions - saleProceeds - totalDepreciation;
  const shortTermCapitalGain = rawClosing < 0 ? -rawClosing : 0;
  const closingWdv = Math.max(0, rawClosing);

  const methodology: string[] = [
    `Block opening WDV ${formatInr(openingWdv)} at ${opts.ratePct}%.`,
    `Additions: ${formatInr(fullRateAdditions)} at full rate, ${formatInr(halfRateAdditions)} at half rate (used < 180 days).`,
  ];
  if (saleProceeds > 0) methodology.push(`Sale proceeds reducing the block: ${formatInr(saleProceeds)}.`);
  methodology.push(`Normal depreciation ${formatInr(normalDepreciation)}.`);
  if (additionalDepreciation > 0)
    methodology.push(`Additional depreciation u/s 32(1)(iia) ${formatInr(additionalDepreciation)}.`);
  if (shortTermCapitalGain > 0)
    methodology.push(
      `Sale proceeds exceed the block — short-term capital gain u/s 50 of ${formatInr(shortTermCapitalGain)}; closing WDV nil.`,
    );
  methodology.push(`Closing WDV ${formatInr(closingWdv)}.`);

  return {
    ratePct: opts.ratePct,
    openingWdv,
    fullRateAdditions,
    halfRateAdditions,
    saleProceeds,
    normalDepreciation,
    additionalDepreciation,
    totalDepreciation,
    closingWdv,
    shortTermCapitalGain,
    methodology,
  };
}

/** Convenience: minor-unit rupee helper, re-exported so callers need one import. */
export const rupees = INR;

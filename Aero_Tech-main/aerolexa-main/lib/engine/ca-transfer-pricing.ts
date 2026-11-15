/**
 * Transfer pricing — S.92 to S.92F read with Rule 10B and Form 3CEB.
 *
 * SCOPE AND HONESTY: the engine is arithmetic over caller-supplied
 * uncontrolled prices and comparable data. It does not search databases of
 * comparables, does not fetch live law and does not issue a legal opinion.
 * Every statutory parameter (tolerance bands, the ₹1 crore S.94B de-minimis,
 * the 30% EBITDA cap) is a labelled constant the caller can override, so a
 * Finance Act / notification change is the caller's to own.
 *
 * Money is in MINOR UNITS (paise) as integers, matching every CA engine.
 */

export class TransferPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferPricingError";
  }
}

// ---------------------------------------------------------------------------
// Rule 10B tolerance bands (labelled; caller overrides per notification)
// ---------------------------------------------------------------------------

export type ToleranceClass = "wholesale-trading" | "retail-trading" | "other";

/** Rule 10B(1)(ii): ±1% wholesale, ±5% retail trading, ±3% in all other cases. */
export const DEFAULT_TOLERANCE_PCT: Record<ToleranceClass, number> = {
  "wholesale-trading": 1,
  "retail-trading": 5,
  other: 3,
};

export function tolerancePctFor(cls: ToleranceClass): number {
  return DEFAULT_TOLERANCE_PCT[cls];
}

// ---------------------------------------------------------------------------
// Arithmetic mean of comparables + the Rule 10B arm's length range
// ---------------------------------------------------------------------------

export interface ArmLengthRange {
  n: number;
  arithmeticMean: number;
  tolerancePct: number;
  lower: number;
  upper: number;
  /** Rule 10B wording: mean ± tolerance × mean. */
  basis: string;
}

/** Arithmetic mean of the comparables, rounded to the nearest paise. */
export function arithmeticMean(comparables: readonly number[]): number {
  if (comparables.length === 0) throw new TransferPricingError("At least one comparable is required.");
  const total = comparables.reduce((s, c) => s + c, 0);
  return Math.round(total / comparables.length);
}

/** The ±tolerance% band around the arithmetic mean (Rule 10B(1)(ii)).
 *
 * The band edges are kept EXACT (mean ± tolerance × mean, no integer
 * rounding): rounding the delta would collapse fractional bands — e.g. a TNMM
 * operating-margin band of 10 ± 0.3 would round to a single point — and would
 * silently widen or narrow the statutory range.
 */
export function armLengthRange(comparables: readonly number[], tolerancePct: number): ArmLengthRange {
  if (tolerancePct < 0) throw new TransferPricingError("Tolerance cannot be negative.");
  const mean = arithmeticMean(comparables);
  const delta = (mean * tolerancePct) / 100;
  return {
    n: comparables.length,
    arithmeticMean: mean,
    tolerancePct,
    lower: mean - delta,
    upper: mean + delta,
    basis: `arithmetic mean ± ${tolerancePct}% (Rule 10B(1)(ii))`,
  };
}

export type TpVerdict = "within-band" | "adjusted-down" | "adjusted-up";

export interface TpAdjustment {
  verdict: TpVerdict;
  /** Price/income to adjust TO when outside the band — the arithmetic mean. */
  armLengthFigure: number;
  /** Absolute adjustment in minor units; 0 when within band. */
  adjustment: number;
  range: ArmLengthRange;
}

/** S.92C(1) as-amended: if within the band, ALP = the transaction price itself. */
export function applyArmLengthTest(actual: number, comparables: readonly number[], tolerancePct: number): TpAdjustment {
  if (comparables.length === 0) throw new TransferPricingError("At least one comparable is required.");
  const range = armLengthRange(comparables, tolerancePct);
  if (actual >= range.lower && actual <= range.upper) {
    return { verdict: "within-band", armLengthFigure: actual, adjustment: 0, range };
  }
  // Outside the band: adjustment to the arithmetic mean.
  const mean = range.arithmeticMean;
  if (actual > mean) {
    return { verdict: "adjusted-down", armLengthFigure: mean, adjustment: actual - mean, range };
  }
  return { verdict: "adjusted-up", armLengthFigure: mean, adjustment: mean - actual, range };
}

// ---------------------------------------------------------------------------
// Method wrappers (Rule 10B(a)–(f)) — each reduces to the band test on its
// own tested figure, with the method label carried on the result.
// ---------------------------------------------------------------------------

export type TpMethod = "CUP" | "RPM" | "CPLM" | "TNMM" | "PSM";

export interface MethodResult extends TpAdjustment {
  method: TpMethod;
  /** What was tested: price, gross margin, OM, or the split itself. */
  testedFigure: string;
}

/** CUP / RPM / Cost Plus: the actual price (or price-derived margin) vs comparables. */
export function methodPriceTest(
  method: "CUP" | "RPM" | "CPLM",
  actual: number,
  comparables: readonly number[],
  tolerancePct: number,
): MethodResult {
  return { method, testedFigure: "price", ...applyArmLengthTest(actual, comparables, tolerancePct) };
}

/** TNMM: operating-margin (OM) level test — tested party OM vs comparable OMs. */
export function methodTnmm(
  testedOmPct: number,
  comparableOmPcts: readonly number[],
  tolerancePct: number,
): { method: TpMethod; testedFigure: string; omResult: TpAdjustment } {
  return {
    method: "TNMM",
    testedFigure: "operating margin (%)",
    omResult: applyArmLengthTest(testedOmPct, comparableOmPcts, tolerancePct),
  };
}

/**
 * Profit split (Rule 10B(f)): combined profit split by relative contribution
 * weights; each party's split is tested only for internal consistency — the
 * split itself IS the arm's length result, so the returned adjustment is 0
 * and the split shares are the deliverable.
 */
export function profitSplit(
  combinedProfit: number,
  weights: readonly number[],
): { splits: number[]; totalCheck: number; weightsSum: number } {
  if (weights.length === 0) throw new TransferPricingError("At least one contribution weight is required.");
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) throw new TransferPricingError("Contribution weights must sum to a positive number.");
  const splits = weights.map((w) => Math.round((combinedProfit * w) / sum));
  // Largest-remainder rounding so splits always re-sum to the combined profit.
  const drift = combinedProfit - splits.reduce((s, x) => s + x, 0);
  if (drift !== 0) {
    let bestIdx = 0;
    for (let i = 1; i < splits.length; i++) {
      if (weights[i]! > weights[bestIdx]!) bestIdx = i;
    }
    splits[bestIdx]! += drift;
  }
  return { splits, totalCheck: splits.reduce((s, x) => s + x, 0), weightsSum: sum };
}

// ---------------------------------------------------------------------------
// Multiple-year data (Rule 10B(4)): 3-year weighted mean of comparables
// ---------------------------------------------------------------------------

/**
 * Where multiple-year data is used, the current-year comparable is weighted 3,
 * the previous year 2, the year before that 1 — the standard rule-10B(4)
 * practice — unless the caller supplies explicit weights.
 */
export function multipleYearWeightedMean(
  yearlyValues: readonly number[],
  weights?: readonly number[],
): { weightedMean: number; weightsUsed: number[] } {
  if (yearlyValues.length === 0) throw new TransferPricingError("At least one year of data is required.");
  const w = weights ?? yearlyValues.map((_, i) => i + 1); // oldest → lightest
  if (w.length !== yearlyValues.length) {
    throw new TransferPricingError("Weights and years must have the same length.");
  }
  const totalW = w.reduce((s, x) => s + x, 0);
  const totalV = yearlyValues.reduce((s, v, i) => s + v * w[i]!, 0);
  return { weightedMean: Math.round(totalV / totalW), weightsUsed: [...w] };
}

// ---------------------------------------------------------------------------
// S.94B thin capitalisation
// ---------------------------------------------------------------------------

export interface ThinCap94BResult {
  interestExpense: number;
  ebitda: number;
  excessInterest: number;
  thirtyPctEbitda: number;
  deMinimis: number;
  disallowance: number;
  carryForward: number;
  basis: string;
}

/**
 * S.94B: interest expenditure paid to a non-resident AE exceeding
 * max(30% of EBITDA, ₹1 crore) is disallowed; the excess is carried forward
 * for 8 AYs. The ₹1 crore de-minimis: total interest ≤ ₹1 crore is never hit.
 */
export function thinCapitalisation94B(
  interestExpense: number,
  ebitda: number,
  deMinimis = 1_00_00_000 * 100, // ₹1 crore in paise
): ThinCap94BResult {
  if (interestExpense < 0 || ebitda < 0) {
    throw new TransferPricingError("Interest expense and EBITDA must be non-negative.");
  }
  const excessInterest = Math.max(0, interestExpense - deMinimis);
  const thirtyPctEbitda = Math.round((ebitda * 30) / 100);
  const cap = Math.max(thirtyPctEbitda, deMinimis);
  // Disallowance = interest − max(30% of EBITDA, ₹1 crore); carried forward 8 AYs.
  const dis = Math.max(0, interestExpense - cap);
  return {
    interestExpense,
    ebitda,
    excessInterest,
    thirtyPctEbitda,
    deMinimis,
    disallowance: dis,
    carryForward: dis,
    basis: "S.94B: disallowance = interest − max(30% of EBITDA, ₹1 crore); excess carried forward 8 AYs",
  };
}

// ---------------------------------------------------------------------------
// Form 3CEB aggregate
// ---------------------------------------------------------------------------

export interface Form3cebTransaction {
  /** Short description of the international transaction / SDT. */
  description: string;
  type: "international" | "sdt";
  method: TpMethod;
  /** Transaction value in minor units. */
  valueMinor: number;
  /** Suggested adjustment computed by the method tests, if any. */
  adjustmentMinor: number;
}

export interface Form3cebSummary {
  totalTransactions: number;
  internationalValue: number;
  sdtValue: number;
  totalValue: number;
  totalAdjustment: number;
  byMethod: { method: TpMethod; count: number; value: number }[];
  /** Form 3CEB requires the HIGHEST-valued transaction per method to be stated. */
  highestByMethod: { method: TpMethod; description: string; value: number }[];
  basis: string;
}

export function form3cebSummary(transactions: readonly Form3cebTransaction[]): Form3cebSummary {
  if (transactions.length === 0) throw new TransferPricingError("At least one transaction is required.");
  const internationalValue = transactions
    .filter((t) => t.type === "international")
    .reduce((s, t) => s + t.valueMinor, 0);
  const sdtValue = transactions.filter((t) => t.type === "sdt").reduce((s, t) => s + t.valueMinor, 0);

  const byMethodMap = new Map<TpMethod, { count: number; value: number; highest: Form3cebTransaction | null }>();
  for (const t of transactions) {
    const row = byMethodMap.get(t.method) ?? { count: 0, value: 0, highest: null };
    row.count += 1;
    row.value += t.valueMinor;
    if (!row.highest || t.valueMinor > row.highest.valueMinor) row.highest = t;
    byMethodMap.set(t.method, row);
  }
  const byMethod = [...byMethodMap.entries()].map(([method, row]) => ({
    method,
    count: row.count,
    value: row.value,
  }));
  const highestByMethod = [...byMethodMap.entries()]
    .filter(([, row]) => row.highest !== null)
    .map(([method, row]) => ({ method, description: row.highest!.description, value: row.highest!.valueMinor }));

  return {
    totalTransactions: transactions.length,
    internationalValue,
    sdtValue,
    totalValue: internationalValue + sdtValue,
    totalAdjustment: transactions.reduce((s, t) => s + t.adjustmentMinor, 0),
    byMethod,
    highestByMethod,
    basis: "Form 3CEB aggregates: international + SDT values, per-method counts, highest-value transaction per method",
  };
}

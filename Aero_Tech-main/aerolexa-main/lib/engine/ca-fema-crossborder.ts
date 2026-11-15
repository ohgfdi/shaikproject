/**
 * FEMA / cross-border engine — the determinable computations behind
 * FC-GPR/FC-TRS reporting, ODI financial commitment, ECB pricing and LRS/TCS.
 *
 * SCOPE AND HONESTY: FEMA practice is deadline + limit + pricing-guideline
 * arithmetic over caller-supplied facts. The engine does not file on any
 * portal, does not fetch live FX rates and does not give legal advice.
 * Limits (USD 250k LRS, 400% ODI net-worth, benchmark spread caps) are
 * labelled constants the caller can override, so a regulation change is the
 * caller's to own.
 *
 * Money is in MINOR UNITS (paise) as integers, matching every CA engine.
 */

export class FemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FemaError";
  }
}

// ---------------------------------------------------------------------------
// Date arithmetic — days between ISO dates (UTC, no DST surprises)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
function parseIso(iso: string): number {
  const t = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(t)) throw new FemaError(`Invalid date: ${iso}`);
  return t;
}
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// FC-GPR / FC-TRS — reporting deadlines and pricing-guideline tests
// ---------------------------------------------------------------------------

export interface FcgprResult {
  allotmentDate: string;
  dueDate: string;
  filedOn: string | null;
  daysLate: number;
  onTime: boolean;
  /** Pricing-guideline test: issue price must not be below the fair-value floor. */
  pricing: {
    issuePriceMinor: number;
    fairValueMinor: number;
    compliant: boolean;
    shortfallMinor: number;
    basis: string;
  };
}

/** FC-GPR is due within 30 days of allotment of shares to a non-resident. */
export const FCGPR_DAYS = 30;

export function fcgpr(input: {
  allotmentDate: string;
  filedOn?: string | null;
  issuePriceMinor: number;
  fairValueMinor: number;
}): FcgprResult {
  if (input.issuePriceMinor <= 0) throw new FemaError("Issue price must be positive.");
  if (input.fairValueMinor <= 0) throw new FemaError("Fair value must be positive.");
  const due = new Date(parseIso(input.allotmentDate) + FCGPR_DAYS * DAY_MS).toISOString().slice(0, 10);
  const filedOn = input.filedOn ?? null;
  const daysLate = filedOn ? Math.max(0, daysBetween(due, filedOn)) : 0;
  const compliant = input.issuePriceMinor >= input.fairValueMinor;
  return {
    allotmentDate: input.allotmentDate,
    dueDate: due,
    filedOn,
    daysLate,
    onTime: daysLate === 0,
    pricing: {
      issuePriceMinor: input.issuePriceMinor,
      fairValueMinor: input.fairValueMinor,
      compliant,
      shortfallMinor: compliant ? 0 : input.fairValueMinor - input.issuePriceMinor,
      basis: "Pricing guidelines: issue price to a non-resident must not be below fair value (DCF/NPV floor)",
    },
  };
}

export interface FctrsResult {
  direction: "resident-to-non-resident" | "non-resident-to-resident";
  transferPriceMinor: number;
  fairValueMinor: number;
  compliant: boolean;
  /** R2N below fair value / N2R above fair value — the deviation amount. */
  deviationMinor: number;
  basis: string;
}

/**
 * Pricing guidelines for transfer of shares by/from a non-resident:
 * R → N must not be below fair value; N → R must not exceed fair value.
 */
export function fctrs(input: {
  direction: "resident-to-non-resident" | "non-resident-to-resident";
  transferPriceMinor: number;
  fairValueMinor: number;
}): FctrsResult {
  if (input.transferPriceMinor <= 0 || input.fairValueMinor <= 0) {
    throw new FemaError("Transfer price and fair value must be positive.");
  }
  const r2n = input.direction === "resident-to-non-resident";
  const compliant = r2n
    ? input.transferPriceMinor >= input.fairValueMinor
    : input.transferPriceMinor <= input.fairValueMinor;
  return {
    direction: input.direction,
    transferPriceMinor: input.transferPriceMinor,
    fairValueMinor: input.fairValueMinor,
    compliant,
    deviationMinor: compliant ? 0 : Math.abs(input.transferPriceMinor - input.fairValueMinor),
    basis: r2n
      ? "Pricing guidelines: resident→non-resident transfer price must not be below fair value"
      : "Pricing guidelines: non-resident→resident transfer price must not exceed fair value",
  };
}

// ---------------------------------------------------------------------------
// ODI — financial commitment limits (400% of net worth)
// ---------------------------------------------------------------------------

export interface OdiLimitResult {
  netWorthMinor: number;
  pctOfNetWorth: number;
  approvedByRbiMinor: number;
  limitMinor: number;
  totalFinancialCommitmentMinor: number;
  headroomMinor: number;
  withinLimit: boolean;
  basis: string;
}

/** ODI financial commitment: 400% of the Indian party's net worth (last audited BS), or the RBI-approved amount. */
export const ODI_PCT_OF_NET_WORTH = 400;

export function odiLimit(input: {
  netWorthMinor: number;
  approvedByRbiMinor?: number;
  totalFinancialCommitmentMinor: number;
}): OdiLimitResult {
  if (input.netWorthMinor < 0) throw new FemaError("Net worth cannot be negative.");
  if (input.totalFinancialCommitmentMinor < 0) throw new FemaError("Financial commitment cannot be negative.");
  const statutory = Math.round((input.netWorthMinor * ODI_PCT_OF_NET_WORTH) / 100);
  const limit = Math.max(statutory, input.approvedByRbiMinor ?? 0);
  return {
    netWorthMinor: input.netWorthMinor,
    pctOfNetWorth: ODI_PCT_OF_NET_WORTH,
    approvedByRbiMinor: input.approvedByRbiMinor ?? 0,
    limitMinor: limit,
    totalFinancialCommitmentMinor: input.totalFinancialCommitmentMinor,
    headroomMinor: Math.max(0, limit - input.totalFinancialCommitmentMinor),
    withinLimit: input.totalFinancialCommitmentMinor <= limit,
    basis: "ODI: financial commitment ≤ 400% of net worth (last audited balance sheet) or the RBI-approved amount",
  };
}

// ---------------------------------------------------------------------------
// ECB — ceiling rate on the benchmark (SOFR) + spread cap
// ---------------------------------------------------------------------------

export interface EcbRateResult {
  benchmarkPct: number;
  spreadCapPct: number;
  ceilingPct: number;
  allInPct: number;
  compliant: boolean;
  excessPct: number;
  basis: string;
}

/**
 * ECB pricing: all-in cost (benchmark + spread) must not exceed the
 * benchmark + the applicable spread cap. The default spread cap of 450 bps
 * is the commonly referenced ceiling for average-maturity ECBs; override it
 * per the current Master Direction.
 */
export const ECB_DEFAULT_SPREAD_CAP_PCT = 4.5;

export function ecbRate(input: { benchmarkPct: number; spreadPct: number; spreadCapPct?: number }): EcbRateResult {
  if (input.benchmarkPct < 0 || input.spreadPct < 0) throw new FemaError("Rates cannot be negative.");
  const spreadCapPct = input.spreadCapPct ?? ECB_DEFAULT_SPREAD_CAP_PCT;
  const ceilingPct = round6(input.benchmarkPct + spreadCapPct);
  const allInPct = round6(input.benchmarkPct + input.spreadPct);
  return {
    benchmarkPct: input.benchmarkPct,
    spreadCapPct,
    ceilingPct,
    allInPct,
    compliant: allInPct <= ceilingPct,
    excessPct: Math.max(0, round6(allInPct - ceilingPct)),
    basis: `ECB pricing: benchmark + spread must not exceed benchmark + ${spreadCapPct}% spread cap`,
  };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// LRS + TCS
// ---------------------------------------------------------------------------

/** USD 250,000 per financial year per individual, in USD minor units (cents). */
export const LRS_LIMIT_USD_MINOR = 25_000_000;

export interface LrsResult {
  amountUsdMinor: number;
  limitUsdMinor: number;
  withinLimit: boolean;
  remittancesLeftUsdMinor: number;
  tcsRatePct: number;
  tcsAmountMinor: number;
  basis: string;
}

/**
 * LRS headroom + TCS: 5% up to ₹7 lakh of INR remittance value in the FY,
 * 20% beyond (education/medical loans excepted — the caller models those
 * separately).
 *
 * UNIT HONESTY: the LRS limit is USD; the TCS threshold is INR. The two are
 * NEVER compared directly — the threshold test runs on `inrEquivalentMinor`
 * (the caller's INR-paise value of the FY remittances). Without it, the rate
 * defaults to 5% with an explicit basis note saying the threshold test was
 * not run. `tcsRatePct` may also be supplied when the caller already knows
 * the applicable rate.
 */
export const TCS_THRESHOLD_MINOR = 7_00_000 * 100; // ₹7 lakh in paise
export const TCS_LOW_PCT = 5;
export const TCS_HIGH_PCT = 20;

export function lrsTcs(input: {
  /** This remittance in USD cents. */
  amountUsdMinor: number;
  /** Prior remittances in the FY, USD cents. */
  priorYearRemittancesUsdMinor?: number;
  /** FY INR (paise) remittance value for the TCS ₹7-lakh threshold test. */
  inrEquivalentMinor?: number;
  tcsRatePct?: number;
}): LrsResult {
  if (input.amountUsdMinor < 0) throw new FemaError("Remittance amount cannot be negative.");
  const prior = input.priorYearRemittancesUsdMinor ?? 0;
  const total = prior + input.amountUsdMinor;
  const withinLimit = total <= LRS_LIMIT_USD_MINOR;
  let tcsRatePct: number;
  let tcsBasis: string;
  if (input.tcsRatePct !== undefined) {
    tcsRatePct = input.tcsRatePct;
    tcsBasis = `TCS ${tcsRatePct}% (caller-supplied rate)`;
  } else if (input.inrEquivalentMinor !== undefined) {
    tcsRatePct = input.inrEquivalentMinor > TCS_THRESHOLD_MINOR ? TCS_HIGH_PCT : TCS_LOW_PCT;
    tcsBasis = `TCS ${tcsRatePct}% — INR value ${input.inrEquivalentMinor} vs ₹7-lakh threshold (${TCS_THRESHOLD_MINOR} paise)`;
  } else {
    tcsRatePct = TCS_LOW_PCT;
    tcsBasis =
      "TCS defaulted to 5% — supply inrEquivalentMinor to run the ₹7-lakh threshold test (USD and INR are never compared directly)";
  }
  const tcsAmountMinor = Math.round((input.amountUsdMinor * tcsRatePct) / 100);
  return {
    amountUsdMinor: input.amountUsdMinor,
    limitUsdMinor: LRS_LIMIT_USD_MINOR,
    withinLimit,
    remittancesLeftUsdMinor: Math.max(0, LRS_LIMIT_USD_MINOR - total),
    tcsRatePct,
    tcsAmountMinor,
    basis: `LRS: USD 250,000/FY/individual; ${tcsBasis} (5% to ₹7 lakh, 20% beyond — education/medical loans excepted)`,
  };
}

/**\
 * Closing calculator — retained earnings, opening carry-forward,
 * year-end lock, and comparative-period support for Indian CA practice.
 *
 * Money is in MINOR UNITS (paise) as integers, matching accounting.ts
 * and the ratio engines. All computations are pure functions (no DB, no randomness),
 * so they can be pinned by unit tests.
 */

// no longer needed

export class ClosingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClosingError";
  }
}

/** Financial year bounds: FY "2025-26" runs from 2025-04-01 to 2026-03-31. */
function fyBounds(fy: string): { _from: string; _to: string } {
  const y = Number(fy.slice(0, 4));
  if (!Number.isFinite(y) || !/^\d{4}-\d{2}$/.test(fy)) {
    throw new ClosingError(`fy must look like "2025-26"; got "${fy}".`);
  }
  return { _from: `${y}-04-01`, _to: `${y + 1}-03-31` };
}

/** Shift an ISO date by whole days (UTC-safe). */
function _shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Opening carry-forward: closing net block / equity of the prior period. */
export interface OpeningCarryForward {
  /** Prior period's closing net block (assets - liabilities). */
  priorClosingNetBlock: number;
  /** Prior period's profit/loss (may be negative = loss). */
  priorPeriodProfit: number;
  /** Equity brought forward from prior period. */
  equityBroughtForward: number;
}

/** Compute opening carry-forward from a prior period's ledger. */
export function computeOpeningCarryForward(
  priorLedgerEntries: readonly { account: string; amount: number }[],
  priorPeriod: string,
): OpeningCarryForward {
  const { _from: _priorFrom, _to: _priorTo } = fyBounds(priorPeriod);
  // Sum all debits and credits in the prior period to get net profit.
  // Positive net profit increases equity; negative (loss) decreases it.
  let debits = 0;
  let credits = 0;

  for (const entry of priorLedgerEntries) {
    if (entry.amount > 0) {
      debits += entry.amount;
    } else {
      credits += -entry.amount;
    }
  }

  const netProfit = debits - credits; // positive = profit, negative = loss
  const equityBroughtForward = netProfit; // carry-forward = prior period's result

  return {
    priorClosingNetBlock: 0, // callers supply this from the balance sheet
    priorPeriodProfit: netProfit,
    equityBroughtForward,
  };
}

/** Year-end lock: verify that no postings exist after the FY end date. */
export function verifyYearEndLock(
  entries: readonly { account: string; amount: number; date: string }[],
  fy: string,
): { locked: boolean; violatingEntries: readonly { date: string; amount: number }[] } {
  const { _from: _fyFrom, _to: _fyTo } = fyBounds(fy);
  const violations: { date: string; amount: number }[] = [];

  for (const entry of entries) {
    if (entry.date > _fyTo) {
      violations.push({ date: entry.date, amount: entry.amount });
    }
  }

  return {
    locked: violations.length === 0,
    violatingEntries: violations as readonly { date: string; amount: number }[],
  };
}

/** Comparative periods: compute side-by-side figures for two financial years. */
export interface ComparativePeriods {
  /** Current period figures. */
  current: {
    fy: string;
    netProfit: number;
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  };
  /** Prior period figures. */
  prior: {
    fy: string;
    netProfit: number;
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  };
  /** Year-over-year change percentages. */
  yoyChange: {
    netProfitPct: number;
    totalAssetsPct: number;
    totalEquityPct: number;
  };
}

/** Compute comparative periods from two ledger snapshots. */
export function computeComparativePeriods(
  currentEntries: readonly { account: string; amount: number; date: string }[],
  priorEntries: readonly { account: string; amount: number; date: string }[],
  currentFy: string,
  priorFy: string,
): ComparativePeriods {
  const { _from: currentFrom, _to: currentTo } = fyBounds(currentFy);
  const { _from: priorFrom, _to: priorTo } = fyBounds(priorFy);

  // Current period: sum all entries within the FY range
  let currentDebits = 0;
  let currentCredits = 0;
  let currentAssets = 0;
  let currentLiabilities = 0;

  for (const entry of currentEntries) {
    if (entry.date < currentFrom || entry.date > currentTo) continue;
    if (entry.amount > 0) {
      currentDebits += entry.amount;
      // Assume positive amounts on debit-normal accounts are assets/expenses
      currentAssets += entry.amount;
    } else {
      currentCredits += -entry.amount;
      // Assume negative amounts (credits) on liability/equity accounts
      currentLiabilities += -entry.amount;
    }
  }

  // Prior period: same computation
  let priorDebits = 0;
  let priorCredits = 0;
  let priorAssets = 0;
  let priorLiabilities = 0;

  for (const entry of priorEntries) {
    if (entry.date < priorFrom || entry.date > priorTo) continue;
    if (entry.amount > 0) {
      priorDebits += entry.amount;
      priorAssets += entry.amount;
    } else {
      priorCredits += -entry.amount;
      priorLiabilities += -entry.amount;
    }
  }

  const currentNetProfit = currentDebits - currentCredits;
  const currentTotalEquity = currentAssets - currentLiabilities; // simplified

  const priorNetProfit = priorDebits - priorCredits;
  const priorTotalEquity = priorAssets - priorLiabilities;

  // YoY change percentages (handle division by zero)
  const netProfitPct =
    priorNetProfit !== 0 ? ((currentNetProfit - priorNetProfit) / Math.abs(priorNetProfit)) * 100 : 0;
  const totalAssetsPct = priorAssets !== 0 ? ((currentAssets - priorAssets) / Math.abs(priorAssets)) * 100 : 0;
  const totalEquityPct =
    priorTotalEquity !== 0 ? ((currentTotalEquity - priorTotalEquity) / Math.abs(priorTotalEquity)) * 100 : 0;

  return {
    current: {
      fy: currentFy,
      netProfit: currentNetProfit,
      totalAssets: currentAssets,
      totalLiabilities: currentLiabilities,
      totalEquity: currentTotalEquity,
    },
    prior: {
      fy: priorFy,
      netProfit: priorNetProfit,
      totalAssets: priorAssets,
      totalLiabilities: priorLiabilities,
      totalEquity: priorTotalEquity,
    },
    yoyChange: {
      netProfitPct,
      totalAssetsPct,
      totalEquityPct,
    },
  };
}

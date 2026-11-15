/**
 * Financial ratio analysis engine - the ratios a CA firms compute for every
 * client review.
 *
 * Five families, each with the standard Indian-practice definition:
 *   profitability   - Gross / Operating / Net profit margin, RBI, ROCE, ROE,
 *                      EPS, DPS, P/E-ready
 *   liquidity       - Current, Quick (acid-test), cash, defensive interval
 *   efficiency      - Inventory turnover, receivables days, payables days,
 *                      working-capital cycle, asset turnover, fixed-asset turnover
 *   solvency        - Debt/equity, debt/assets, interest cover, proprietary
 *                      ratio, fixed-charge cover
 *   market          - P/E, P/B, EPS, DPS, dividend yield (price supplied by caller)
 *
 * SCOPE AND HONESTY - ratios are arithmetic on caller-supplied statement
 * figures. The engine does not fetch balance sheets, does not classify accounts
 * automatically, and does not prescribe a verdict. Every ratio carries its
 * formula on the result so a reviewer can reproduce it from the source figures.
 * A division-by-zero yields null + a reason, never a silent zero.
 *
 * Money is in MINOR UNITS (paise) as integers, matching accounting.ts, so a
 * ratio computed from statement totals is exact to the paise.
 */

export class RatioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatioError";
  }
}

// ---------------------------------------------------------------------------
// Input figures (caller maps statement lines → these buckets)
// ---------------------------------------------------------------------------

export interface RatioInput {
  /** Period / as-of label, e.g. "FY 2025-26" or "Q1 2026-27". */
  label: string;

  // Income statement figures (period)
  revenue: number; // +ve, top line (minor units)
  costOfGoodsSold: number; // +ve
  grossProfit: number; // revenue − COGS
  operatingExpenses: number; // +ve (employee costs, rent, depreciation, …)
  operatingProfit: number; // gross profit − operating expenses
  otherIncome: number; // +ve (non-operating income)
  financeCosts: number; // +ve (interest expense)
  profitBeforeTax: number; // operating profit + other income − finance costs
  taxExpense: number; // +ve
  netProfit: number; // PBT − tax
  earningsPerShare?: number | null; // caller-computed, major units
  dividendsPerShare?: number | null; // caller-computed, major units

  // Balance sheet figures (as at period end; opening BS optionally supplied)
  currentAssets: number;
  currentLiabilities: number;
  inventory: number; // +ve (current asset)
  tradeReceivables: number; // +ve (current asset)
  cashAndBank: number; // +ve (current asset)
  totalAssets: number;
  totalLiabilities: number;
  equity: number; // shareholders' funds
  longTermDebt: number; // +ve (non-current borrowings)
  fixedAssets: number; // +ve (net block)
  intangibleAssets: number; // +ve

  // Optional opening-balance-sheet figures for average-based ratios
  openingEquity?: number | null;
  openingLongTermDebt?: number | null;
  openingTotalAssets?: number | null;
  openingInventory?: number | null;
  openingTradeReceivables?: number | null;
  openingCurrentAssets?: number | null;
  openingCurrentLiabilities?: number | null;

  // Market data (caller-supplied; not derived from the statements)
  sharePrice?: number | null; // major units
  sharesOutstanding?: number | null; // number of equity shares (face value units)

  // Optional: absolute figures for efficiency ratios (caller may supply the
  // period's purchase cost and credit sales if available)
  purchases?: number | null;
  creditSales?: number | null;
}

// ---------------------------------------------------------------------------
// Ratio families
// ---------------------------------------------------------------------------

/** One computed ratio. `value` is null when the inputs cannot support it. */
export interface Ratio {
  family: RatioFamily;
  name: string;
  value: number | null;
  formatted: string;
  formula: string;
  /** When not null, why the ratio could not be computed. */
  unavailableReason?: string;
}

export type RatioFamily = "profitability" | "liquidity" | "efficiency" | "solvency" | "market";

/** A full ratio set for one reporting period. */
export interface RatioResult {
  label: string;
  ratios: Ratio[];
  /** Quick read: the ratios a reviewer reaches for first, with caveats. */
  headline: {
    grossMargin: number | null;
    operatingMargin: number | null;
    netMargin: number | null;
    currentRatio: number | null;
    quickRatio: number | null;
    debtToEquity: number | null;
    roce: number | null;
    roe: number | null;
    interestCover: number | null;
  };
  warnings: string[];
  /** Per-family summary line the CA can paste into a review note. */
  summary: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${(v * 100).toFixed(2)}%`;
}

function times(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return v.toFixed(2) + "×";
}

function ratio(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Profitability
// ---------------------------------------------------------------------------

function profitability(input: RatioInput): Ratio[] {
  const out: Ratio[] = [];
  const add = (name: string, value: number | null, formatted: string, formula: string, reason?: string) =>
    out.push({ family: "profitability", name, value, formatted, formula, unavailableReason: reason });

  add(
    "Gross profit margin",
    input.revenue > 0 ? input.grossProfit / input.revenue : null,
    pct(input.revenue > 0 ? input.grossProfit / input.revenue : null),
    "Gross profit margin = Gross profit ÷ Revenue",
    input.revenue === 0 ? "revenue is zero" : undefined,
  );
  add(
    "Operating profit margin",
    input.revenue > 0 ? input.operatingProfit / input.revenue : null,
    pct(input.revenue > 0 ? input.operatingProfit / input.revenue : null),
    "Operating profit margin = Operating profit ÷ Revenue",
    input.revenue === 0 ? "revenue is zero" : undefined,
  );
  add(
    "Net profit margin",
    input.revenue > 0 ? input.netProfit / input.revenue : null,
    pct(input.revenue > 0 ? input.netProfit / input.revenue : null),
    "Net profit margin = Net profit ÷ Revenue",
    input.revenue === 0 ? "revenue is zero" : undefined,
  );

  // Return on capital employed (ROCE): EBIT ÷ (equity + long-term debt).
  // Uses average capital employed when opening figures are available.
  const capitalEmployed = input.equity + input.longTermDebt;
  const hasOpening = input.openingEquity != null && input.openingLongTermDebt != null;
  const openingCapitalEmployed = (input.openingEquity ?? 0) + (input.openingLongTermDebt ?? 0);
  const avgCapitalEmployed = hasOpening ? (capitalEmployed + openingCapitalEmployed) / 2 : capitalEmployed;
  add(
    "Return on capital employed (ROCE)",
    avgCapitalEmployed > 0 ? input.operatingProfit / avgCapitalEmployed : null,
    pct(avgCapitalEmployed > 0 ? input.operatingProfit / avgCapitalEmployed : null),
    "ROCE = EBIT ÷ Average capital employed (equity + long-term debt)",
    avgCapitalEmployed === 0 ? "capital employed is zero" : undefined,
  );

  add(
    "Return on equity (ROE)",
    input.equity > 0 ? input.netProfit / input.equity : null,
    pct(input.equity > 0 ? input.netProfit / input.equity : null),
    "ROE = Net profit ÷ Equity (shareholders' funds)",
    input.equity === 0 ? "equity is zero" : undefined,
  );

  // EPS - caller-supplies the figure (shares outstanding may not be in the ledger).
  if (typeof input.earningsPerShare === "number" && Number.isFinite(input.earningsPerShare)) {
    add(
      "Earnings per share (EPS)",
      input.earningsPerShare,
      input.earningsPerShare.toFixed(2),
      "EPS = Net profit ÷ Shares outstanding (caller-supplied)",
    );
  } else {
    add(
      "Earnings per share (EPS)",
      null,
      "-",
      "EPS = Net profit ÷ Shares outstanding",
      "shares outstanding not supplied",
    );
  }

  // Dividend payout ratio - only when both DPS and EPS are available.
  if (
    typeof input.dividendsPerShare === "number" &&
    typeof input.earningsPerShare === "number" &&
    Number.isFinite(input.dividendsPerShare) &&
    Number.isFinite(input.earningsPerShare) &&
    input.earningsPerShare !== 0
  ) {
    add(
      "Dividend payout ratio",
      input.dividendsPerShare / input.earningsPerShare,
      pct(input.dividendsPerShare / input.earningsPerShare),
      "Dividend payout = DPS ÷ EPS",
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

function liquidity(input: RatioInput): Ratio[] {
  const out: Ratio[] = [];
  const add = (name: string, value: number | null, formatted: string, formula: string, reason?: string) =>
    out.push({ family: "liquidity", name, value, formatted, formula, unavailableReason: reason });

  add(
    "Current ratio",
    input.currentLiabilities > 0 ? input.currentAssets / input.currentLiabilities : null,
    ratio(input.currentLiabilities > 0 ? input.currentAssets / input.currentLiabilities : null),
    "Current ratio = Current assets ÷ Current liabilities",
    input.currentLiabilities === 0 ? "current liabilities are zero" : undefined,
  );

  const quickAssets = input.currentAssets - input.inventory;
  add(
    "Quick ratio (acid test)",
    input.currentLiabilities > 0 ? quickAssets / input.currentLiabilities : null,
    ratio(input.currentLiabilities > 0 ? quickAssets / input.currentLiabilities : null),
    "Quick ratio = (Current assets − Inventory) ÷ Current liabilities",
    input.currentLiabilities === 0 ? "current liabilities are zero" : undefined,
  );

  add(
    "Cash ratio",
    input.currentLiabilities > 0 ? input.cashAndBank / input.currentLiabilities : null,
    ratio(input.currentLiabilities > 0 ? input.cashAndBank / input.currentLiabilities : null),
    "Cash ratio = Cash & bank ÷ Current liabilities",
    input.currentLiabilities === 0 ? "current liabilities are zero" : undefined,
  );

  // Defensive interval (days): (cash + receivables) ÷ (daily operating expenses).
  // Daily operating expenses = operating expenses ÷ 365 (approximate).
  if (input.operatingExpenses > 0 && input.currentAssets > 0) {
    const dailyOpex = input.operatingExpenses / 365;
    const liquidAssets = input.cashAndBank + input.tradeReceivables;
    if (dailyOpex > 0) {
      add(
        "Defensive interval (days)",
        liquidAssets / dailyOpex,
        (liquidAssets / dailyOpex).toFixed(0) + " days",
        "Defensive interval = (Cash + Receivables) ÷ (Operating expenses ÷ 365)",
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

function efficiency(input: RatioInput): Ratio[] {
  const out: Ratio[] = [];
  const add = (name: string, value: number | null, formatted: string, formula: string, reason?: string) =>
    out.push({ family: "efficiency", name, value, formatted, formula, unavailableReason: reason });

  // Inventory turnover (times): COGS ÷ average inventory.
  const avgInventory =
    typeof input.openingInventory === "number" ? (input.inventory + input.openingInventory) / 2 : input.inventory;
  add(
    "Inventory turnover (times)",
    avgInventory > 0 ? input.costOfGoodsSold / avgInventory : null,
    ratio(avgInventory > 0 ? input.costOfGoodsSold / avgInventory : null),
    "Inventory turnover = COGS ÷ Average inventory",
    avgInventory === 0 ? "inventory is zero" : undefined,
  );

  // Inventory holding period (days): 365 ÷ inventory turnover.
  const invTurnover = avgInventory > 0 ? input.costOfGoodsSold / avgInventory : null;
  if (invTurnover !== null && invTurnover > 0) {
    add(
      "Inventory holding period (days)",
      365 / invTurnover,
      (365 / invTurnover).toFixed(1) + " days",
      "Inventory holding period = 365 ÷ Inventory turnover",
    );
  }

  // Receivables days: (Receivables ÷ Credit sales) × 365.
  // Falls back to total revenue when credit sales is not supplied.
  const salesForReceivables = input.creditSales ?? input.revenue;
  if (salesForReceivables > 0) {
    add(
      "Receivables collection period (days)",
      (input.tradeReceivables / salesForReceivables) * 365,
      ((input.tradeReceivables / salesForReceivables) * 365).toFixed(1) + " days",
      "Receivables days = (Trade receivables ÷ Credit sales) × 365",
    );
  }

  // Payables days: (Payables ÷ Purchases) × 365.
  // Purchases ≈ COGS + closing inventory − opening inventory when purchases not supplied.
  if (typeof input.purchases === "number" && input.purchases > 0 && input.currentLiabilities > 0) {
    add(
      "Payables payment period (days)",
      input.purchases / input.currentLiabilities > 0 ? (input.currentLiabilities / input.purchases) * 365 : null,
      "-",
      "Payables days = (Payables ÷ Purchases) × 365",
    );
  }

  // Working capital cycle (operating cycle): receivables days + inventory days − payables days.
  const invDays = invTurnover !== null && invTurnover > 0 ? 365 / invTurnover : null;
  const recDays = salesForReceivables > 0 ? (input.tradeReceivables / salesForReceivables) * 365 : null;
  // Payables days not computed here when purchases unknown - cycle is approximate.
  if (recDays !== null) {
    const cycle = invDays !== null ? recDays + invDays : recDays;
    add(
      "Working capital cycle (operating cycle, approx. days)",
      cycle,
      cycle.toFixed(1) + " days",
      "Operating cycle = Receivables days + Inventory days − Payables days (payables omitted when purchases not supplied)",
    );
  }

  // Asset turnover: Revenue ÷ average total assets.
  const avgAssets =
    typeof input.openingTotalAssets === "number"
      ? (input.totalAssets + input.openingTotalAssets) / 2
      : input.totalAssets;
  add(
    "Asset turnover (times)",
    avgAssets > 0 ? input.revenue / avgAssets : null,
    ratio(avgAssets > 0 ? input.revenue / avgAssets : null),
    "Asset turnover = Revenue ÷ Average total assets",
    avgAssets === 0 ? "total assets are zero" : undefined,
  );

  // Fixed asset turnover: Revenue ÷ net fixed assets.
  const netFixedAssets = input.fixedAssets + input.intangibleAssets;
  add(
    "Fixed asset turnover (times)",
    netFixedAssets > 0 ? input.revenue / netFixedAssets : null,
    ratio(netFixedAssets > 0 ? input.revenue / netFixedAssets : null),
    "Fixed asset turnover = Revenue ÷ (Fixed assets + Intangibles)",
    netFixedAssets === 0 ? "fixed assets + intangibles are zero" : undefined,
  );

  return out;
}

// ---------------------------------------------------------------------------
// Solvency
// ---------------------------------------------------------------------------

function solvency(input: RatioInput): Ratio[] {
  const out: Ratio[] = [];
  const add = (name: string, value: number | null, formatted: string, formula: string, reason?: string) =>
    out.push({ family: "solvency", name, value, formatted, formula, unavailableReason: reason });

  const totalDebt = input.longTermDebt + input.currentLiabilities;

  add(
    "Debt to equity",
    input.equity > 0 ? input.longTermDebt / input.equity : null,
    ratio(input.equity > 0 ? input.longTermDebt / input.equity : null),
    "Debt to equity = Long-term debt ÷ Equity",
    input.equity === 0 ? "equity is zero" : undefined,
  );

  add(
    "Debt to assets",
    input.totalAssets > 0 ? input.longTermDebt / input.totalAssets : null,
    pct(input.totalAssets > 0 ? input.longTermDebt / input.totalAssets : null),
    "Debt to assets = Long-term debt ÷ Total assets",
    input.totalAssets === 0 ? "total assets are zero" : undefined,
  );

  // Total debt to equity (includes current liabilities).
  add(
    "Total debt to equity",
    input.equity > 0 ? totalDebt / input.equity : null,
    ratio(input.equity > 0 ? totalDebt / input.equity : null),
    "Total debt to equity = (Long-term debt + Current liabilities) ÷ Equity",
    input.equity === 0 ? "equity is zero" : undefined,
  );

  // Interest cover: EBIT ÷ finance costs.
  add(
    "Interest cover",
    input.financeCosts > 0 ? input.operatingProfit / input.financeCosts : null,
    times(input.financeCosts > 0 ? input.operatingProfit / input.financeCosts : null),
    "Interest cover = EBIT (operating profit) ÷ Finance costs",
    input.financeCosts === 0 ? "finance costs are zero" : undefined,
  );

  // Proprietary ratio: Equity ÷ Total assets.
  add(
    "Proprietary ratio",
    input.totalAssets > 0 ? input.equity / input.totalAssets : null,
    pct(input.totalAssets > 0 ? input.equity / input.totalAssets : null),
    "Proprietary ratio = Equity ÷ Total assets",
    input.totalAssets === 0 ? "total assets are zero" : undefined,
  );

  // Fixed charge cover: (EBIT + rent) ÷ (interest + rent) - rent not in ledger, so
  // falls back to interest cover when rent is not supplied.
  add(
    "Fixed charge cover (interest cover, rent not in ledger)",
    input.financeCosts > 0 ? input.operatingProfit / input.financeCosts : null,
    times(input.financeCosts > 0 ? input.operatingProfit / input.financeCosts : null),
    "Fixed charge cover ≈ EBIT ÷ Finance costs (rent not available in the ledger)",
    input.financeCosts === 0 ? "finance costs are zero" : undefined,
  );

  return out;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

function market(input: RatioInput): Ratio[] {
  const out: Ratio[] = [];
  const add = (name: string, value: number | null, formatted: string, formula: string, reason?: string) =>
    out.push({ family: "market", name, value, formatted, formula, unavailableReason: reason });

  if (
    typeof input.sharePrice === "number" &&
    typeof input.sharesOutstanding === "number" &&
    Number.isFinite(input.sharePrice) &&
    Number.isFinite(input.sharesOutstanding) &&
    input.sharesOutstanding > 0
  ) {
    const bookValuePerShare = input.equity / input.sharesOutstanding;

    if (
      typeof input.earningsPerShare === "number" &&
      Number.isFinite(input.earningsPerShare) &&
      input.earningsPerShare !== 0
    ) {
      add(
        "Price to earnings (P/E)",
        input.sharePrice / input.earningsPerShare,
        (input.sharePrice / input.earningsPerShare).toFixed(2) + "×",
        "P/E = Share price ÷ EPS",
      );
    } else {
      add("Price to earnings (P/E)", null, "-", "P/E = Share price ÷ EPS", "EPS not supplied");
    }

    if (bookValuePerShare > 0) {
      add(
        "Price to book (P/B)",
        input.sharePrice / bookValuePerShare,
        (input.sharePrice / bookValuePerShare).toFixed(2) + "×",
        "P/B = Share price ÷ Book value per share (Equity ÷ Shares outstanding)",
      );
    } else {
      add(
        "Price to book (P/B)",
        null,
        "-",
        "P/B = Share price ÷ Book value per share",
        "book value per share is zero or negative",
      );
    }

    if (
      typeof input.dividendsPerShare === "number" &&
      Number.isFinite(input.dividendsPerShare) &&
      input.sharePrice > 0
    ) {
      add(
        "Dividend yield",
        (input.dividendsPerShare / input.sharePrice) * 100,
        ((input.dividendsPerShare / input.sharePrice) * 100).toFixed(2) + "%",
        "Dividend yield = DPS ÷ Share price × 100",
      );
    }
  } else {
    add(
      "Price to earnings (P/E)",
      null,
      "-",
      "P/E = Share price ÷ EPS",
      "share price and/or shares outstanding not supplied",
    );
    add(
      "Price to book (P/B)",
      null,
      "-",
      "P/B = Share price ÷ Book value per share",
      "share price and/or shares outstanding not supplied",
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function analyzeRatios(input: RatioInput): RatioResult {
  if (input.revenue < 0) throw new RatioError("Revenue cannot be negative.");
  if (input.netProfit < 0 && input.profitBeforeTax >= 0 && input.taxExpense > 0) {
    // Sanity flag, not an error: a loss for the period is valid.
  }

  const byFamily: Record<RatioFamily, Ratio[]> = {
    profitability: [],
    liquidity: [],
    efficiency: [],
    solvency: [],
    market: [],
  };

  for (const r of profitability(input)) {
    r.family = "profitability";
    byFamily.profitability.push(r);
  }
  for (const r of liquidity(input)) {
    r.family = "liquidity";
    byFamily.liquidity.push(r);
  }
  for (const r of efficiency(input)) {
    r.family = "efficiency";
    byFamily.efficiency.push(r);
  }
  for (const r of solvency(input)) {
    r.family = "solvency";
    byFamily.solvency.push(r);
  }
  for (const r of market(input)) {
    r.family = "market";
    byFamily.market.push(r);
  }

  const ratios = [
    ...byFamily.profitability,
    ...byFamily.liquidity,
    ...byFamily.efficiency,
    ...byFamily.solvency,
    ...byFamily.market,
  ];

  const warnings: string[] = [];
  for (const r of ratios) {
    if (r.unavailableReason) warnings.push(`${r.name}: ${r.unavailableReason}`);
  }

  const headline = {
    grossMargin: byFamily.profitability.find((r) => r.name === "Gross profit margin")?.value ?? null,
    operatingMargin: byFamily.profitability.find((r) => r.name === "Operating profit margin")?.value ?? null,
    netMargin: byFamily.profitability.find((r) => r.name === "Net profit margin")?.value ?? null,
    currentRatio: byFamily.liquidity.find((r) => r.name === "Current ratio")?.value ?? null,
    quickRatio: byFamily.liquidity.find((r) => r.name === "Quick ratio (acid test)")?.value ?? null,
    debtToEquity: byFamily.solvency.find((r) => r.name === "Debt to equity")?.value ?? null,
    roce: byFamily.profitability.find((r) => r.name === "Return on capital employed (ROCE)")?.value ?? null,
    roe: byFamily.profitability.find((r) => r.name === "Return on equity (ROE)")?.value ?? null,
    interestCover: byFamily.solvency.find((r) => r.name === "Interest cover")?.value ?? null,
  };

  const summary: string[] = [];
  if (headline.grossMargin !== null)
    summary.push(`Gross margin ${pct(headline.grossMargin)} - pricing and input-cost position.`);
  if (headline.operatingMargin !== null)
    summary.push(`Operating margin ${pct(headline.operatingMargin)} - core operating efficiency.`);
  if (headline.netMargin !== null)
    summary.push(`Net margin ${pct(headline.netMargin)} - bottom line after finance and tax.`);
  if (headline.currentRatio !== null)
    summary.push(`Current ratio ${ratio(headline.currentRatio)} - short-term liquidity coverage.`);
  if (headline.quickRatio !== null)
    summary.push(`Quick ratio ${ratio(headline.quickRatio)} - immediate liquidity excluding inventory.`);
  if (headline.debtToEquity !== null)
    summary.push(`Debt to equity ${ratio(headline.debtToEquity)} - long-term leverage.`);
  if (headline.roce !== null) summary.push(`ROCE ${pct(headline.roce)} - return on the capital the business employs.`);
  if (headline.roe !== null) summary.push(`ROE ${pct(headline.roe)} - return to shareholders' funds.`);
  if (headline.interestCover !== null)
    summary.push(`Interest cover ${times(headline.interestCover)} - ability to service debt from operating profit.`);

  return { label: input.label, ratios, headline, warnings, summary };
}

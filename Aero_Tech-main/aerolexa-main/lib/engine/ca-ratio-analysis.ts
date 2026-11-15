/**
 * Financial ratio analysis — common ratios computed from statement-line inputs.
 *
 * The engine does not memorize accounts; the caller maps its statement lines to
 * the canonical keys below. Missing inputs simply mean the ratio is not
 * computed rather than fabricated.
 *
 * Money is in MINOR UNITS (paise) as integers internally; ratios are unitless
 * percentages or times.
 */

export type RatioFamily =
  "liquidity" | "solvency" | "profitability" | "efficiency" | "turnover" | "workingCapital" | "cashFlow";

export interface RatioRow {
  family: RatioFamily;
  name: string;
  formula: string;
  value: number | null;
  benchmark?: number | null;
  verdict?: string;
}

export interface FsRatioResult {
  ratios: RatioRow[];
  warnings: string[];
  methodology: string[];
}

function line(lines: { key: string; amount: number }[], key: string): number | null {
  const found = lines.find((l) => l.key === key);
  return found ? found.amount : null;
}

function pct(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0 || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return (num / den) * 100;
}

function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0 || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return num / den;
}

function benchmarkVerdict(
  name: string,
  value: number | null,
  benchmark: number | null,
  better: "higher" | "lower",
): string | undefined {
  if (value === null || benchmark === null) return undefined;
  if (better === "higher") {
    return value >= benchmark
      ? `${name} is at or above the benchmark (${benchmark}).`
      : `${name} is below the benchmark (${benchmark}).`;
  }
  return value <= benchmark
    ? `${name} is at or below the benchmark (${benchmark}).`
    : `${name} is above the benchmark (${benchmark}).`;
}

export function computeRatios(input: {
  lines: { key: string; amount: number }[];
  families?: RatioFamily[];
  peerBenchmarks?: { ratio: string; value: number }[];
}): FsRatioResult {
  const {
    lines,
    families = ["liquidity", "solvency", "profitability", "efficiency", "turnover", "workingCapital", "cashFlow"],
    peerBenchmarks = [],
  } = input;

  const b = (name: string) => peerBenchmarks.find((p) => p.ratio === name)?.value ?? null;

  const rows: RatioRow[] = [];

  const liquidity: RatioRow[] = [];
  // Current ratio
  const currentAssets = line(lines, "current-assets");
  const currentLiabilities = line(lines, "current-liabilities");
  const currentRatio = ratio(currentAssets, currentLiabilities);
  if (currentRatio !== null)
    liquidity.push({
      family: "liquidity",
      name: "Current ratio",
      formula: "Current assets / Current liabilities",
      value: currentRatio,
      benchmark: b("Current ratio"),
      verdict: benchmarkVerdict("Current ratio", currentRatio, b("Current ratio"), "higher"),
    });
  // Quick ratio
  const inventory = line(lines, "inventory");
  const quickAssets = currentAssets !== null && inventory !== null ? currentAssets - inventory : null;
  const quickRatio = ratio(quickAssets, currentLiabilities);
  if (quickRatio !== null)
    liquidity.push({
      family: "liquidity",
      name: "Quick ratio",
      formula: "(Current assets - Inventory) / Current liabilities",
      value: quickRatio,
      benchmark: b("Quick ratio"),
      verdict: benchmarkVerdict("Quick ratio", quickRatio, b("Quick ratio"), "higher"),
    });
  // Cash ratio
  const cash = line(lines, "cash-and-bank");
  const cashRatio = ratio(cash, currentLiabilities);
  if (cashRatio !== null)
    liquidity.push({
      family: "liquidity",
      name: "Cash ratio",
      formula: "Cash and bank / Current liabilities",
      value: cashRatio,
      benchmark: b("Cash ratio"),
      verdict: benchmarkVerdict("Cash ratio", cashRatio, b("Cash ratio"), "higher"),
    });
  // Working capital
  if (currentAssets !== null && currentLiabilities !== null) {
    liquidity.push({
      family: "liquidity",
      name: "Working capital",
      formula: "Current assets - Current liabilities",
      value: (currentAssets - currentLiabilities) / 100,
      benchmark: b("Working capital"),
      verdict: undefined,
    });
  }
  rows.push(...liquidity);

  const solvency: RatioRow[] = [];
  const equity = line(lines, "equity");
  const totalDebt = line(lines, "total-debt");
  const totalAssets = line(lines, "total-assets");
  const de = ratio(totalDebt, equity);
  if (de !== null)
    solvency.push({
      family: "solvency",
      name: "Debt-to-equity",
      formula: "Total debt / Equity",
      value: de,
      benchmark: b("Debt-to-equity"),
      verdict: benchmarkVerdict("Debt-to-equity", de, b("Debt-to-equity"), "lower"),
    });
  const da = pct(totalDebt, totalAssets);
  if (da !== null)
    solvency.push({
      family: "solvency",
      name: "Debt-to-assets",
      formula: "Total debt / Total assets × 100",
      value: da,
      benchmark: b("Debt-to-assets"),
      verdict: benchmarkVerdict("Debt-to-assets", da, b("Debt-to-assets"), "lower"),
    });
  const ebit = line(lines, "ebit");
  const interest = line(lines, "interest-expense");
  const coff = ratio(ebit, interest);
  if (coff !== null)
    solvency.push({
      family: "solvency",
      name: "Interest coverage",
      formula: "EBIT / Interest expense",
      value: coff,
      benchmark: b("Interest coverage"),
      verdict: benchmarkVerdict("Interest coverage", coff, b("Interest coverage"), "higher"),
    });
  rows.push(...solvency);

  const profitability: RatioRow[] = [];
  const revenue = line(lines, "revenue");
  const grossProfit = line(lines, "gross-profit");
  const ebitda = line(lines, "ebitda");
  const ebitLine = line(lines, "ebit");
  const netProfit = line(lines, "net-profit");
  if (grossProfit !== null && revenue !== null && revenue !== 0)
    profitability.push({
      family: "profitability",
      name: "Gross profit margin",
      formula: "Gross profit / Revenue × 100",
      value: (grossProfit / revenue) * 100,
      benchmark: b("Gross profit margin"),
      verdict: benchmarkVerdict(
        "Gross profit margin",
        (grossProfit / revenue) * 100,
        b("Gross profit margin"),
        "higher",
      ),
    });
  if (ebitda !== null && revenue !== null && revenue !== 0)
    profitability.push({
      family: "profitability",
      name: "EBITDA margin",
      formula: "EBITDA / Revenue × 100",
      value: (ebitda / revenue) * 100,
      benchmark: b("EBITDA margin"),
      verdict: benchmarkVerdict("EBITDA margin", (ebitda / revenue) * 100, b("EBITDA margin"), "higher"),
    });
  if (ebitLine !== null && revenue !== null && revenue !== 0)
    profitability.push({
      family: "profitability",
      name: "EBIT margin",
      formula: "EBIT / Revenue × 100",
      value: (ebitLine / revenue) * 100,
      benchmark: b("EBIT margin"),
      verdict: benchmarkVerdict("EBIT margin", (ebitLine / revenue) * 100, b("EBIT margin"), "higher"),
    });
  if (netProfit !== null && revenue !== null && revenue !== 0)
    profitability.push({
      family: "profitability",
      name: "Net profit margin",
      formula: "Net profit / Revenue × 100",
      value: (netProfit / revenue) * 100,
      benchmark: b("Net profit margin"),
      verdict: benchmarkVerdict("Net profit margin", (netProfit / revenue) * 100, b("Net profit margin"), "higher"),
    });
  if (equity !== null && netProfit !== null && equity !== 0)
    profitability.push({
      family: "profitability",
      name: "Return on equity (ROE)",
      formula: "Net profit / Equity × 100",
      value: (netProfit / equity) * 100,
      benchmark: b("Return on equity (ROE)"),
      verdict: benchmarkVerdict(
        "Return on equity (ROE)",
        (netProfit / equity) * 100,
        b("Return on equity (ROE)"),
        "higher",
      ),
    });
  if (totalAssets !== null && netProfit !== null && totalAssets !== 0)
    profitability.push({
      family: "profitability",
      name: "Return on assets (ROA)",
      formula: "Net profit / Total assets × 100",
      value: (netProfit / totalAssets) * 100,
      benchmark: b("Return on assets (ROA)"),
      verdict: benchmarkVerdict(
        "Return on assets (ROA)",
        (netProfit / totalAssets) * 100,
        b("Return on assets (ROA)"),
        "higher",
      ),
    });
  rows.push(...profitability);

  const efficiency: RatioRow[] = [];
  const purchases = line(lines, "purchases");
  const averageInventory = line(lines, "average-inventory");
  if (purchases !== null && averageInventory !== null && averageInventory !== 0)
    efficiency.push({
      family: "efficiency",
      name: "Inventory turnover",
      formula: "Purchases / Average inventory",
      value: purchases / averageInventory,
      benchmark: b("Inventory turnover"),
      verdict: benchmarkVerdict("Inventory turnover", purchases / averageInventory, b("Inventory turnover"), "higher"),
    });
  const debtors = line(lines, "debtors");
  if (revenue !== null && debtors !== null && debtors !== 0)
    efficiency.push({
      family: "efficiency",
      name: "Debtor days",
      formula: "Debtors / Revenue × 365",
      value: (debtors / revenue) * 365,
      benchmark: b("Debtor days"),
      verdict: benchmarkVerdict("Debtor days", (debtors / revenue) * 365, b("Debtor days"), "lower"),
    });
  const creditors = line(lines, "creditors");
  if (purchases !== null && creditors !== null && creditors !== 0)
    efficiency.push({
      family: "efficiency",
      name: "Creditor days",
      formula: "Creditors / Purchases × 365",
      value: (creditors / purchases) * 365,
      benchmark: b("Creditor days"),
      verdict: benchmarkVerdict("Creditor days", (creditors / purchases) * 365, b("Creditor days"), "higher"),
    });
  rows.push(...efficiency);

  const turnover: RatioRow[] = [];
  if (revenue !== null && totalAssets !== null && totalAssets !== 0)
    turnover.push({
      family: "turnover",
      name: "Asset turnover",
      formula: "Revenue / Total assets",
      value: revenue / totalAssets,
      benchmark: b("Asset turnover"),
      verdict: benchmarkVerdict("Asset turnover", revenue / totalAssets, b("Asset turnover"), "higher"),
    });
  if (revenue !== null && equity !== null && equity !== 0)
    turnover.push({
      family: "turnover",
      name: "Equity turnover",
      formula: "Revenue / Equity",
      value: revenue / equity,
      benchmark: b("Equity turnover"),
      verdict: benchmarkVerdict("Equity turnover", revenue / equity, b("Equity turnover"), "higher"),
    });
  if (purchases !== null && totalAssets !== null && totalAssets !== 0)
    turnover.push({
      family: "turnover",
      name: "Inventory turnover (on assets)",
      formula: "Purchases / Total assets",
      value: purchases / totalAssets,
      benchmark: b("Inventory turnover (on assets)"),
      verdict: benchmarkVerdict(
        "Inventory turnover (on assets)",
        purchases / totalAssets,
        b("Inventory turnover (on assets)"),
        "higher",
      ),
    });
  rows.push(...turnover);

  const workingCapital: RatioRow[] = [];
  const wc = currentAssets !== null && currentLiabilities !== null ? currentAssets - currentLiabilities : null;
  const salesWC = line(lines, "revenue");
  if (wc !== null && salesWC !== null && salesWC !== 0)
    workingCapital.push({
      family: "workingCapital",
      name: "Working capital per rupee of sales",
      formula: "Working capital / Revenue",
      value: wc / salesWC,
      benchmark: b("Working capital per rupee of sales"),
      verdict: benchmarkVerdict(
        "Working capital per rupee of sales",
        wc / salesWC,
        b("Working capital per rupee of sales"),
        "lower",
      ),
    });
  rows.push(...workingCapital);

  const cashFlow: RatioRow[] = [];
  const operatingCashFlow = line(lines, "operating-cash-flow");
  const ocfMargin = pct(operatingCashFlow, revenue);
  if (ocfMargin !== null)
    cashFlow.push({
      family: "cashFlow",
      name: "Operating cash flow margin",
      formula: "Operating cash flow / Revenue × 100",
      value: ocfMargin,
      benchmark: b("Operating cash flow margin"),
      verdict: benchmarkVerdict("Operating cash flow margin", ocfMargin, b("Operating cash flow margin"), "higher"),
    });
  const ocfToNet = ratio(operatingCashFlow, netProfit);
  if (ocfToNet !== null)
    cashFlow.push({
      family: "cashFlow",
      name: "Cash conversion (OCF / Net profit)",
      formula: "Operating cash flow / Net profit",
      value: ocfToNet,
      benchmark: b("Cash conversion (OCF / Net profit)"),
      verdict: benchmarkVerdict(
        "Cash conversion (OCF / Net profit)",
        ocfToNet,
        b("Cash conversion (OCF / Net profit)"),
        "higher",
      ),
    });
  const capex = line(lines, "capex");
  const fcf = operatingCashFlow !== null && capex !== null ? operatingCashFlow - capex : null;
  if (fcf !== null)
    cashFlow.push({
      family: "cashFlow",
      name: "Free cash flow (OCF - Capex)",
      formula: "Operating cash flow - Capex",
      value: fcf / 100,
      benchmark: b("Free cash flow (OCF - Capex)"),
      verdict: undefined,
    });
  rows.push(...cashFlow);

  const allowed = new Set(families);
  const filtered = rows.filter((r) => allowed.has(r.family));

  const warnings: string[] = [];
  if (!currentAssets && !currentLiabilities)
    warnings.push("Liquidity ratios are not computed: current assets and current liabilities are both missing.");
  if (!equity && !totalDebt) warnings.push("Solvency ratios are not computed: equity and total debt are both missing.");
  if (!revenue) warnings.push("Profitability ratios that depend on revenue are not computed: revenue is missing.");

  return {
    ratios: filtered,
    warnings,
    methodology: [
      "Ratios are computed from statement-line inputs keyed by canonical keys (e.g. current-assets, total-debt, ebit, revenue).",
      "A ratio is omitted rather than fabricated when its inputs are missing or its denominator is zero.",
      "Peer benchmarks are optional; when present they are shown alongside the computed ratio and a plain-language verdict.",
    ],
  };
}

/**
 * Financial statement analysis — common-size (vertical) + horizontal
 * (year-over-year) analysis for the IS, BS and CF.
 *
 * This module is the "base" engine behind the fsanalysis kind. It is pure
 * arithmetic on caller-supplied statement lines and intentionally does not
 * fetch accounts, assume an opening balance sheet, or assign a verdict.
 *
 * Money is in MINOR UNITS (paise) as integers.
 */

export interface IsLine {
  key: string;
  label: string;
  amount: number;
}

export interface BsLine {
  key: string;
  label: string;
  amount: number;
}

export interface CfLine {
  key: string;
  label: string;
  amount: number;
}

export interface StatementPair {
  currentLabel: string;
  priorLabel: string;
  currentIs: IsLine[];
  priorIs: IsLine[] | null;
  currentBs: BsLine[];
  priorBs: BsLine[] | null;
  currentCf: CfLine[];
  priorCf: CfLine[] | null;
  revenueBase?: number | null;
  totalAssetsBase?: number | null;
  cashFlowBase?: number | null;
}

export interface AnalyzedLine {
  key: string;
  label: string;
  currentAmount: number;
  commonSizePct: number | null;
  priorAmount: number | null;
  absoluteChange: number | null;
  pctChange: number | null;
}

export interface FinancialAnalysisResult {
  currentLabel: string;
  priorLabel: string | null;
  isCommonSize: AnalyzedLine[];
  bsCommonSize: AnalyzedLine[];
  cfCommonSize: AnalyzedLine[];
  bases: { isBase: number | null; bsBase: number | null; cfBase: number | null };
  isHorizontalHighlights: string[];
  bsHorizontalHighlights: string[];
  cfHorizontalHighlights: string[];
  warnings: string[];
  methodology: string[];
}

function commonSize(amount: number, base: number | null): number | null {
  if (base === null || base === 0 || !Number.isFinite(amount)) return null;
  return (amount / base) * 100;
}

function horizontal(current: number, prior: number | null): { absolute: number | null; pct: number | null } {
  if (prior === null || !Number.isFinite(current)) return { absolute: null, pct: null };
  const absolute = current - prior;
  if (prior === 0) return { absolute, pct: null };
  return { absolute, pct: (absolute / Math.abs(prior)) * 100 };
}

function analyzeLines<T extends { key: string; label: string; amount: number }>(
  current: T[],
  prior: T[] | null,
  base: number | null,
): AnalyzedLine[] {
  const priorMap = new Map<string, number>();
  if (prior) {
    for (const l of prior) priorMap.set(l.key, l.amount);
  }
  return current.map((l) => {
    const cs = commonSize(l.amount, base);
    const priorAmount = priorMap.get(l.key) ?? null;
    const h = horizontal(l.amount, priorAmount);
    return {
      key: l.key,
      label: l.label,
      currentAmount: l.amount,
      commonSizePct: cs,
      priorAmount,
      absoluteChange: h.absolute,
      pctChange: h.pct,
    };
  });
}

function derivedIsBase(currentIs: IsLine[]): number | null {
  const positive = currentIs.filter((l) => l.amount > 0);
  if (!positive.length) return null;
  let best: number | null = null;
  for (const l of positive) {
    if (best === null || l.amount > best) best = l.amount;
  }
  return best;
}

function derivedBsBase(currentBs: BsLine[]): number | null {
  let s = 0;
  let any = false;
  for (const l of currentBs) {
    if (l.amount > 0) {
      s += l.amount;
      any = true;
    }
  }
  return any ? s : null;
}

function derivedCfBase(currentCf: CfLine[]): number | null {
  // For a cash-flow statement the "base" is usually the net change in cash or
  // the opening cash balance; here we fall back to the line with the largest
  // absolute magnitude, which is a reasonable neutral default for a comp-size
  // scaffold. Callers can override cashFlowBase.
  let best: number | null = null;
  for (const l of currentCf) {
    const abs = Math.abs(l.amount);
    if (best === null || abs > Math.abs(best)) best = l.amount;
  }
  return best;
}

function highlights(lines: AnalyzedLine[], base: number | null, baseLabel: string): string[] {
  const out: string[] = [];
  if (!base || base === 0) {
    out.push(`${baseLabel} base could not be determined - common-size percentages are not computed.`);
    return out;
  }
  const revenueLine = lines.find((l) => l.key === "revenue");
  if (revenueLine && revenueLine.commonSizePct !== null) {
    out.push(
      `Revenue ${revenueLine.label} is ${revenueLine.commonSizePct.toFixed(1)}% of ${baseLabel} (the ${baseLabel} base itself).`,
    );
  }
  const movers = lines.filter(
    (l): l is AnalyzedLine & { pctChange: number } =>
      l.pctChange !== null && Math.abs(l.pctChange) >= 10 && l.currentAmount !== 0,
  );
  for (const m of movers.slice(0, 6)) {
    const direction = m.pctChange >= 0 ? "up" : "down";
    out.push(
      `${m.label} ${direction} ${Math.abs(m.pctChange).toFixed(1)}% vs the prior period (absolute change ${m.absoluteChange === null ? "n/a" : String(m.absoluteChange)}).`,
    );
  }
  return out;
}

export function analyzeStatements(pair: StatementPair): FinancialAnalysisResult {
  const isBase = pair.revenueBase ?? derivedIsBase(pair.currentIs);
  const bsBase = pair.totalAssetsBase ?? derivedBsBase(pair.currentBs);
  const cfBase = pair.cashFlowBase ?? derivedCfBase(pair.currentCf);

  const isCommonSize = analyzeLines(pair.currentIs, pair.priorIs, isBase);
  const bsCommonSize = analyzeLines(pair.currentBs, pair.priorBs, bsBase);
  const cfCommonSize = analyzeLines(pair.currentCf, pair.priorCf, cfBase);

  const warnings: string[] = [];
  if (isBase === null || isBase === 0)
    warnings.push("Income statement common-size could not be computed: no revenue base for the current period.");
  if (bsBase === null || bsBase === 0)
    warnings.push("Balance sheet common-size could not be computed: total assets base is zero or not derivable.");
  if (cfBase === null || cfBase === 0)
    warnings.push("Cash-flow common-size could not be computed: cash-flow base is zero or not derivable.");

  return {
    currentLabel: pair.currentLabel,
    priorLabel: pair.priorIs || pair.priorBs || pair.priorCf ? pair.priorLabel : null,
    isCommonSize,
    bsCommonSize,
    cfCommonSize,
    bases: { isBase, bsBase, cfBase },
    isHorizontalHighlights: highlights(isCommonSize, isBase, "revenue"),
    bsHorizontalHighlights: highlights(bsCommonSize, bsBase, "total assets"),
    cfHorizontalHighlights: highlights(cfCommonSize, cfBase, "cash-flow base"),
    warnings,
    methodology: [
      `Common-size income statement: each line as a percentage of ${isBase !== null ? String(isBase) : "the revenue base"}.`,
      `Common-size balance sheet: each line as a percentage of ${bsBase !== null ? String(bsBase) : "total assets"}.`,
      `Common-size cash-flow statement: each line as a percentage of ${cfBase !== null ? String(cfBase) : "the cash-flow base"}.`,
      pair.priorIs || pair.priorBs || pair.priorCf
        ? `Horizontal analysis vs ${pair.priorLabel}: absolute and percentage change on matching keys.`
        : "No prior period supplied - horizontal analysis is skipped.",
    ],
  };
}

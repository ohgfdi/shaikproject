/**
 * ITR Schedules Engine — partnership/LLP profit-sharing, Book Reference Income,
 * MAT book, foreign company status, dividend/specified income, alternate
 * minimum tax, FATCA/CRS, and foreign assets/reporting schedules.
 *
 * This supplements `itr-json-utility.ts` (which builds the top-level form
 * wrapper and personal/general info) with the detailed schedule bodies that
 * the current ITR JSON/XML schema expects for ITR-3, ITR-4, ITR-5, ITR-6,
 * and ITR-7.
 *
 * Money is in MINOR UNITS (paise) as integers, matching `india-tax.ts`.
 *
 * SCOPE AND HONESTY:
 *   Schedules are built from the caller-supplied figures. Rates, thresholds,
 *   and form-layout details are the commonly referenced ones and are surfaced
 *   on the result so a reviewer can verify them against the current Finance
 *   Act and the CBDT ITR schema for the assessment year. This engine builds
 *   the schedule payload; it does not file a return and does not issue a legal
 *   opinion.
 */

import { formatInr, CorporateRegime } from "./india-tax";

export { INR, formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A line item in any schedule — label, amount (minor units), and optional notes. */
export interface ScheduleLine {
  label: string;
  amount: number; // minor units
  /** Column index when a schedule has multiple numeric columns. */
  col?: number;
  notes?: string;
}

/** A schedule block with a title, an ordered list of lines, and optional sub-schedules. */
export interface ScheduleBlock {
  header: string;
  /** Serial numbers when the schedule is a numbered list. */
  serial?: boolean;
  lines: ScheduleLine[];
  /** Sub-schedules keyed by a short code, e.g. "S" for Schedule S. */
  sub?: Record<string, ScheduleBlock>;
  totalLabel?: string;
  notes?: string[];
}

/** A full ITR payload that bundles general info (from itr-json-utility) with every schedule. */
export interface ITRSchedulePayload {
  formType: "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  assessmentYear: string;
  /** General info block — normally produced by itr-json-utility's validators. */
  general: Record<string, unknown>;
  /** Top-level income and tax blocks that the schema exposes. */
  income: Record<string, number>;
  tax: Record<string, number>;
  /** Every schedule, keyed by its schema code. */
  schedules: Record<string, ScheduleBlock>;
  /** Flat JSON-serialisable representation for the external filing schema. */
  toJson(): unknown;
  /** XML-ish serialisation (indented) for offline/fallback filing. */
  toXml(): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(label: string, amount: number, col?: number, notes?: string): ScheduleLine {
  return { label, amount, col, notes };
}

function total(label: string, amount: number): ScheduleLine {
  return { label, amount, notes: "Total" };
}

function sub(title: string, lines: ScheduleLine[], totalLabel?: string): ScheduleBlock {
  return { header: title, serial: true, lines, totalLabel, notes: [] };
}

/** Round to minor units. */
function r(n: number): number {
  return Math.round(n);
}

// ---------------------------------------------------------------------------
// Schedule EI — Exempt Income (applies to ITR-2/3/5/6)
// ---------------------------------------------------------------------------

export interface ExemptIncome {
  agricultural?: number;
  dividendMutualFund?: number; // u/s 10(34) - exempt dividend from MFs
  dividendDomesticCompany?: number; // u/s 10(34) - exempt dividend
  kantangible?: number; // industrial premises u/s 10(34) - not used in current forms
  scholarship?: number; // u/s 10(16)
  characteristic?: never;
  notes?: string[];
}

export function scheduleEI(input: ExemptIncome): ScheduleBlock {
  const lines: ScheduleLine[] = [];
  let idx = 1;
  if (input.agricultural && input.agricultural > 0) {
    lines.push(line(`${idx++}. Agricultural income u/s 10(1)`, input.agricultural));
  }
  if (input.dividendMutualFund && input.dividendMutualFund > 0) {
    lines.push(line(`${idx++}. Exempt dividend from mutual funds u/s 10(34)`, input.dividendMutualFund));
  }
  if (input.dividendDomesticCompany && input.dividendDomesticCompany > 0) {
    lines.push(line(`${idx++}. Exempt dividend from domestic company u/s 10(34)`, input.dividendDomesticCompany));
  }
  if (input.scholarship && input.scholarship > 0) {
    lines.push(line(`${idx++}. Scholarship u/s 10(16)`, input.scholarship));
  }
  return sub("Schedule EI — Exempt Income", lines, "Total exempt income");
}

// ---------------------------------------------------------------------------
// Schedule DI — Deductions (Chapter VI-A) — extended for all assessees
// ---------------------------------------------------------------------------

export interface ChapterVΙADeductions {
  section80C: number; // LIC, PPF, NSC, tuition, ELSS, etc. (max 1.5L)
  section80CCC: number; // pension funds
  section80CCD1: number; // NPS employee contribution
  section80CCD2: number; // NPS employer contribution (not subject to 1.5L cap)
  section80CCD1B: number; // NPS additional (max 50K)
  section80D: number; // medical insurance
  section80DDB: number; // medical treatment of specified diseases
  section80E: number; // education loan interest
  section80G: number; // donations
  section80GGA: number; // donations for scientific research
  section80GGB: number; // donations by companies
  section80GG: number; // HRA for non-HRA employees
  section80TTA: number; // savings account interest
  section80TTB: number; // senior citizen interest
  section80RRB: number; // royalty income
  section80U: number; // disability
  other: number; // any other deduction
  notes?: string[];
}

export function scheduleDI(input: ChapterVΙADeductions, _regime: "old"): ScheduleBlock {
  const lines: ScheduleLine[] = [];
  let idx = 1;
  const add = (label: string, amt: number) => {
    if (amt > 0) lines.push(line(`${idx++}. ${label}`, amt));
  };
  add("Deductions u/s 80C (LIC, PPF, NSC, tuition, ELSS, etc.)", input.section80C);
  add("Deductions u/s 80CCC (Pension funds)", input.section80CCC);
  add("Deductions u/s 80CCD(1) (NPS - employee)", input.section80CCD1);
  add("Deductions u/s 80CCD(2) (NPS - employer)", input.section80CCD2);
  add("Deductions u/s 80CCD(1B) (NPS - additional)", input.section80CCD1B);
  add("Deductions u/s 80D (Medical insurance)", input.section80D);
  add("Deductions u/s 80DDB (Medical treatment)", input.section80DDB);
  add("Deductions u/s 80E (Education loan interest)", input.section80E);
  add("Deductions u/s 80G (Donations)", input.section80G);
  add("Deductions u/s 80GGA (Donations - research)", input.section80GGA);
  add("Deductions u/s 80GGB (Donations by company)", input.section80GGB);
  add("Deductions u/s 80GG (HRA for non-HRA)", input.section80GG);
  add("Deductions u/s 80TTA (Savings account interest)", input.section80TTA);
  add("Deductions u/s 80TTB (Senior citizen interest)", input.section80TTB);
  add("Deductions u/s 80RRB (Royalty)", input.section80RRB);
  add("Deductions u/s 80U (Disability)", input.section80U);
  add("Other deductions", input.other);

  const deductionTotal = lines.reduce((s, l) => s + l.amount, 0);
  lines.push(total("Total deductions u/s Chapter VI-A", deductionTotal));
  lines.push(line("Less: Exceeding limits / inadmissible amounts", 0));
  return sub("Schedule DI — Deductions u/s Chapter VI-A", lines, "Net deduction");
}

// ---------------------------------------------------------------------------
// Schedule BP — Income from Business or Profession (ITR-3/ITR-5 core)
// ---------------------------------------------------------------------------

export interface BusinessIncomeSchedule {
  /** Trading account. */
  salesOrTurnover: number;
  purchases: number;
  closingStock: number;
  grossProfit: number;
  /** P&L account — indirect expenses. */
  indirectExpenses: {
    salary: number;
    rent: number;
    electricity: number;
    repairs: number;
    depreciation: number;
    interestPaid: number;
    other: number;
  };
  totalIndirectExpenses: number;
  netProfitAsPerBooks: number;
  /** Adjustments u/s 40(a)(ia) — TDS not deducted. */
  disallowanceTdNotDeducted?: number;
  /** Adjustments u/s 40(a)(iaa) — TCS not collected. */
  disallowanceTcsNotCollected?: number;
  /** Disallowed expenditures u/s 40. */
  disallowedExpenses?: number;
  /** Disallowed personal expenses u/s 37(1). */
  disallowedPersonal?: number;
  /** Expenditure not wholly for business u/s 37. */
  notWhollyBusiness?: number;
  /** Family income of partner - not allowed. */
  partnerFamilyIncome?: number;
  /** Expenditure incurred in respect of income not taxable. */
  nonTaxableIncomeExp?: number;
  /** Any other add-backs. */
  otherAddBacks?: number;
  /** Total add-backs. */
  totalAddBacks?: number;
  /** Deductions allowable u/s 33 - depreciation not in P&L. */
  depreciationNotClaimed?: number;
  /** Interest on housing loan for let out property - already in HRA. */
  housingLoanInterest?: number;
  /** Other deductible items. */
  otherDeductions?: number;
  totalDeductions?: number;
  /** Income from business/profession as per return. */
  businessIncomeReturn: number;
  notes?: string[];
}

export function scheduleBP(input: BusinessIncomeSchedule): ScheduleBlock {
  const addBacks = [
    input.disallowanceTdNotDeducted ?? 0,
    input.disallowanceTcsNotCollected ?? 0,
    input.disallowedExpenses ?? 0,
    input.disallowedPersonal ?? 0,
    input.notWhollyBusiness ?? 0,
    input.partnerFamilyIncome ?? 0,
    input.nonTaxableIncomeExp ?? 0,
    input.otherAddBacks ?? 0,
  ].reduce((s, v) => s + v, 0);

  const deductions = [
    input.depreciationNotClaimed ?? 0,
    input.housingLoanInterest ?? 0,
    input.otherDeductions ?? 0,
  ].reduce((s, v) => s + v, 0);

  const totalExpenses =
    input.indirectExpenses.salary +
    input.indirectExpenses.rent +
    input.indirectExpenses.electricity +
    input.indirectExpenses.repairs +
    input.indirectExpenses.depreciation +
    input.indirectExpenses.interestPaid +
    input.indirectExpenses.other;

  const lines: ScheduleLine[] = [
    line("Part A — Trading Account", 0, 0, ""),
    line("1. Sales / Turnover", input.salesOrTurnover),
    line("2. Purchases", input.purchases),
    line("3. Closing Stock", input.closingStock),
    total("4. Gross Profit (1 - 2 + 3)", input.grossProfit),
    line("Part B — Expenses", 0, 0, ""),
    line("5. Salary / Wages", input.indirectExpenses.salary),
    line("6. Rent / Lease", input.indirectExpenses.rent),
    line("7. Electricity", input.indirectExpenses.electricity),
    line("8. Repairs & Maintenance", input.indirectExpenses.repairs),
    line("9. Depreciation as per P&L", input.indirectExpenses.depreciation),
    line("10. Interest Paid", input.indirectExpenses.interestPaid),
    line("11. Other Expenses", input.indirectExpenses.other),
    total("12. Total Indirect Expenses", totalExpenses),
    line("Part C — Net Profit As Per Books", 0, 0, ""),
    total("13. Net Profit as per Books (4 - 12)", input.netProfitAsPerBooks),
    line("Part D — Add-backs (Disallowed/Unexplained)", 0, 0, ""),
    line("14. Disallowance u/s 40(a)(ia) — TDS not deducted", input.disallowanceTdNotDeducted ?? 0),
    line("15. Disallowance u/s 40(a)(iaa) — TCS not collected", input.disallowanceTcsNotCollected ?? 0),
    line("16. Disallowed expenditure u/s 40", input.disallowedExpenses ?? 0),
    line("17. Personal expenses not allowed u/s 37(1)", input.disallowedPersonal ?? 0),
    line("18. Expenditure not wholly for business u/s 37", input.notWhollyBusiness ?? 0),
    line("19. Partner family income disallowed", input.partnerFamilyIncome ?? 0),
    line("20. Expenditure for non-taxable income", input.nonTaxableIncomeExp ?? 0),
    line("21. Other add-backs", input.otherAddBacks ?? 0),
    total("22. Total Add-backs", addBacks),
    line("Part E — Deductions", 0, 0, ""),
    line("23. Depreciation not claimed in P&L (u/s 33)", input.depreciationNotClaimed ?? 0),
    line("24. Interest on housing loan (adjustment)", input.housingLoanInterest ?? 0),
    line("25. Other deductions", input.otherDeductions ?? 0),
    total("26. Total Deductions", deductions),
    line("Part F — Computation", 0, 0, ""),
    line("27. Net Profit as per Books", input.netProfitAsPerBooks),
    line("28. Add: Total Add-backs", addBacks),
    line("29. Less: Total Deductions", deductions),
    total("30. Income from Business/Profession (as per return)", input.businessIncomeReturn),
  ];

  return sub("Schedule BP — Income from Business or Profession", lines, "Business Income");
}

// ---------------------------------------------------------------------------
// Schedule PLC — Profit and Loss Account for companies (ITR-6)
// ---------------------------------------------------------------------------

export interface CompanyPL {
  revenueFromOperations: number;
  otherIncome: number;
  totalRevenue: number;
  expenses: {
    materialConsumption: number;
    purchases: number;
    employeesBenefit: number;
    financeCosts: number;
    depreciation: number;
    otherExpenses: number;
  };
  totalExpenses: number;
  profitBeforeTax: number;
  taxProvisions: number;
  profitAfterTax: number;
  notes?: string[];
}

export function schedulePLC(input: CompanyPL): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Part A — Revenue from Operations", 0, 0, ""),
    line("1. Revenue from Operations (Turnover)", input.revenueFromOperations),
    line("2. Other Income", input.otherIncome),
    total("3. Total Revenue", input.totalRevenue),
    line("Part B — Expenses", 0, 0, ""),
    line("4. Cost of Materials Consumed", input.expenses.materialConsumption),
    line("5. Purchases of Stock-in-Trade", input.expenses.purchases),
    line("6. Employees Benefits", input.expenses.employeesBenefit),
    line("7. Finance Costs (Interest)", input.expenses.financeCosts),
    line("8. Depreciation & Amortisation", input.expenses.depreciation),
    line("9. Other Expenses", input.expenses.otherExpenses),
    total("10. Total Expenses", input.totalExpenses),
    line("Part C — Profit", 0, 0, ""),
    total("11. Profit Before Tax (3 - 10)", input.profitBeforeTax),
    line("12. Tax Provision (current + deferred)", input.taxProvisions),
    total("13. Profit After Tax", input.profitAfterTax),
  ];

  return sub("Schedule PLC — Profit & Loss Account", lines, "PAT");
}

// ---------------------------------------------------------------------------
// Schedule CYM — Computation of Tax on Company (ITR-6)
// ---------------------------------------------------------------------------

export interface CompanyTaxComputation {
  totalIncome: number;
  /** MCA book profit (for MAT u/s 115JB). */
  bookProfitMCA?: number;
  /** Alternative minimum tax base for companies u/s 115JB. */
  matBase?: number;
  /** Alternate minimum tax computed. */
  matAmount?: number;
  regime: CorporateRegime;
  surcharge: number;
  cess: number;
  tds: number;
  advanceTax: number;
  selfAssessmentTax: number;
  notes?: string[];
}

export function scheduleCYM(input: CompanyTaxComputation): ScheduleBlock {
  const regime = input.regime;
  const normalTax = r((input.totalIncome * regime.ratePct) / 100);

  // Surcharge computation (plain, without marginal relief — at schedule level).
  let surchargeAmt = 0;
  let surchargePct = 0;
  for (const band of regime.surcharge) {
    if (input.totalIncome > band.above) {
      surchargePct = band.ratePct;
      surchargeAmt = r((normalTax * band.ratePct) / 100);
    }
  }
  const cessAmt = r(((normalTax + surchargeAmt) * regime.cessPct) / 100);
  const totalTaxNormal = normalTax + surchargeAmt + cessAmt;

  // MAT
  const matRatePct = regime.minimumTaxPct ?? 0;
  const matApplicable = input.bookProfitMCA != null && matRatePct > 0;
  const matTax = matApplicable ? r(((input.bookProfitMCA ?? 0) * matRatePct) / 100) : 0;
  const matFinal = matTax > totalTaxNormal ? matTax : 0;
  const payableTax = matFinal > 0 ? matFinal : totalTaxNormal;

  const lines: ScheduleLine[] = [
    line("Part A — Normal Provisions", 0, 0, ""),
    line("1. Total Income", input.totalIncome),
    line(`2. Tax at ${regime.ratePct}% (normal provisions)`, normalTax),
    line(`3. Surcharge at ${surchargePct}%`, surchargeAmt),
    line(`4. Cess @ ${regime.cessPct}%`, cessAmt),
    total("5. Tax under normal provisions (2 + 3 + 4)", totalTaxNormal),
    line("Part B — MAT u/s 115JB (if applicable)", 0, 0, ""),
    line("6. Book Profit as per MCA", input.bookProfitMCA ?? 0),
    line(`7. MAT rate (${matRatePct}%)`, 0),
    line("8. Tax computed on Book Profit", matTax),
    line("9. Surcharge on MAT tax", 0),
    line("10. Cess on MAT tax", 0),
    total("11. Total MAT tax (8 + 9 + 10)", matTax),
    line("Part C — Payable Tax", 0, 0, ""),
    line("12. Higher of Normal / MAT", payableTax),
    line("13. Less: TDS", input.tds),
    line("14. Less: Advance Tax", input.advanceTax),
    line("15. Less: Self-Assessment Tax", input.selfAssessmentTax),
    total("16. Net Tax Payable / (Refundable)", r(payableTax - input.tds - input.advanceTax - input.selfAssessmentTax)),
  ];

  return sub("Schedule CYM — Computation of Tax (Company)", lines, "Net Tax");
}

// ---------------------------------------------------------------------------
// Schedule PMT — Partnership / LLP profit sharing (ITR-5)
// ---------------------------------------------------------------------------

export interface PartnershipProfitSharing {
  /** Firm name and PAN. */
  firmName: string;
  firmPan: string;
  /** Total income before profit sharing. */
  totalIncomeBeforeShare: number;
  /** Weighted average rate of tax (for disclosure). */
  weightedAvgTaxRate?: number;
  /** Taxable income of the firm. */
  taxableIncomeOfFirm: number;
  /** Tax borne by the firm. */
  taxBorneByFirm: number;
  /** Surcharge on firm tax. */
  surchargeOnFirm: number;
  /** Cess on firm. */
  cessOnFirm: number;
  totalTaxOfFirm: number;
  /** TDS on firm income. */
  tdsOnFirmIncome: number;
  /** Partner details — name, PAN, share of profit, share of tax, share of TDS. */
  partners: {
    name: string;
    pan: string;
    sharePercentage: number; // e.g. 40 for 40%
    shareOfProfit: number; // minor units
    shareOfTax: number; // minor units
    shareOfTds: number; // minor units
    shareOfCess: number; // minor units
    /** Whether the partner is a firm, company, individual, etc. */
    partnerType: "individual" | "huf" | "company" | "firm" | "llp" | "aop" | "trust" | "other";
  }[];
  notes?: string[];
}

export function schedulePMT(input: PartnershipProfitSharing): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Part A — Firm Details", 0, 0, ""),
    line("1. Name of the Firm", 0, 0, input.firmName),
    line("2. PAN of the Firm", 0, 0, input.firmPan),
    line("Part B — Firm Tax Computation", 0, 0, ""),
    line("3. Total Income before Profit Sharing", input.totalIncomeBeforeShare),
    line("4. Taxable Income of the Firm", input.taxableIncomeOfFirm),
    line("5. Weighted Average Tax Rate (disclosure)", input.weightedAvgTaxRate ?? 0),
    line("6. Tax Borne by the Firm", input.taxBorneByFirm),
    line("7. Surcharge on Firm Tax", input.surchargeOnFirm),
    line("8. Cess on Firm Tax", input.cessOnFirm),
    total("9. Total Tax of the Firm (6 + 7 + 8)", input.totalTaxOfFirm),
    total("10. Less: TDS on Firm Income", input.tdsOnFirmIncome),
    total("11. Net Tax Payable by Firm", r(input.totalTaxOfFirm - input.tdsOnFirmIncome)),
    line("Part C — Profit Sharing among Partners", 0, 0, ""),
    line("Sl. No.", 0, 0, "Partner Name"),
    line("PAN", 0, 0, "Share %"),
    line("Share of Profit", 0, 0, "Share of Tax"),
    line("Share of TDS", 0, 0, "Share of Cess"),
    line("Total (Tax + TDS)", 0, 0, ""),
  ];

  let idx = 1;
  for (const p of input.partners) {
    const totalForPartner = p.shareOfTax + p.shareOfTds + p.shareOfCess;
    lines.push(line(`${idx++}. ${p.name}`, p.shareOfProfit));
    lines.push(line(`   PAN: ${p.pan}`, 0, 0, ""));
    lines.push(line(`   Share %: ${p.sharePercentage}%`, 0, 0, ""));
    lines.push(line(`   Share of Tax: ${formatInr(p.shareOfTax)}`, 0, 0, ""));
    lines.push(line(`   Share of TDS: ${formatInr(p.shareOfTds)}`, 0, 0, ""));
    lines.push(line(`   Share of Cess: ${formatInr(p.shareOfCess)}`, 0, 0, ""));
    lines.push(line(`   Total: ${formatInr(totalForPartner)}`, totalForPartner));
    lines.push(line("", 0));
  }

  const totalPartnerTax = input.partners.reduce((s, p) => s + p.shareOfTax, 0);
  const totalPartnerTds = input.partners.reduce((s, p) => s + p.shareOfTds, 0);
  const totalPartnerCess = input.partners.reduce((s, p) => s + p.shareOfCess, 0);
  const totalPartnerTotal = input.partners.reduce((s, p) => s + p.shareOfTax + p.shareOfTds + p.shareOfCess, 0);

  lines.push(total("Total for all Partners — Tax", totalPartnerTax));
  lines.push(total("Total for all Partners — TDS", totalPartnerTds));
  lines.push(total("Total for all Partners — Cess", totalPartnerCess));
  lines.push(total("Grand Total (Tax + TDS + Cess)", totalPartnerTotal));

  return sub("Schedule PMT — Profit Sharing among Partners", lines, "Total");
}

// ---------------------------------------------------------------------------
// Schedule PITR-5 — Income details for Firms, LLPs, AOP, BOI, ITR-5 core
// ---------------------------------------------------------------------------

export interface ITR5IncomeSchedule {
  /** Business or profession income. */
  businessIncome: number;
  /** House property income (less loss). */
  houseProperty: number;
  capitalGains: {
    shortTerm: number;
    longTerm: number;
    total: number;
  };
  otherSources: number;
  /** Agricultural income (exempt but computed). */
  agriculturalIncome: number;
  /** Income from other sources — specified income. */
  specifiedIncome: {
    dividend: number;
    interest: number;
    rent: number;
    royalty: number;
    winnings: number;
    other: number;
  };
  totalIncome: number;
  notes?: string[];
}

export function schedulePITR5Income(input: ITR5IncomeSchedule): ScheduleBlock {
  const specifiedTotal =
    input.specifiedIncome.dividend +
    input.specifiedIncome.interest +
    input.specifiedIncome.rent +
    input.specifiedIncome.royalty +
    input.specifiedIncome.winnings +
    input.specifiedIncome.other;

  const lines: ScheduleLine[] = [
    line("Schedule — Heads of Income", 0, 0, ""),
    line("1. Income from Business or Profession", input.businessIncome),
    line("2. Income from House Property (net)", input.houseProperty),
    line("3. Capital Gains", 0, 0, ""),
    line("   3A. Short-term Capital Gains", input.capitalGains.shortTerm),
    line("   3B. Long-term Capital Gains", input.capitalGains.longTerm),
    line("   3C. Total Capital Gains", input.capitalGains.total),
    line("4. Income from Other Sources — Specified", 0, 0, ""),
    line("   4A. Dividend income", input.specifiedIncome.dividend),
    line("   4B. Interest income", input.specifiedIncome.interest),
    line("   4C. Rent income", input.specifiedIncome.rent),
    line("   4D. Royalty income", input.specifiedIncome.royalty),
    line("   4E. Winnings (lottery, crossword, etc.)", input.specifiedIncome.winnings),
    line("   4F. Other specified income", input.specifiedIncome.other),
    total("   4G. Total Specified Income", specifiedTotal),
    line("5. Exempt Agricultural Income (disclosure)", input.agriculturalIncome),
    total("6. TOTAL INCOME (1 + 2 + 3C + 4G + 5 where taxable)", input.totalIncome),
  ];

  return sub("Schedule — Heads of Income (ITR-5)", lines, "Total Income");
}

// ---------------------------------------------------------------------------
// Schedule MAT — Alternate Minimum Tax (for individuals/HUF with business
// income claiming AMT u/s 115JD, and for companies)
// ---------------------------------------------------------------------------

export interface AMTSchedule {
  /** For individuals/HUF: total income before adjustments. */
  totalIncome: number;
  /** Book profit for companies u/s 115JB. */
  bookProfit?: number;
  /** Adjustments to book profit (add-backs/less). Defaults to zero when omitted. */
  adjustments?: {
    additions: number; // expenses not deductible
    deductions: number; // income not taxable
    lessReserve: number; // less reserve/ provision
    plusReserve: number; // plus reserve
  };
  /** AMT base after adjustments. */
  amtBase: number;
  /** AMT rate (18.5% for non-corporate assessees u/s 115JD; corporation at 15% u/s 115JB). */
  amtRate: number;
  /** AMT computed. */
  amtComputed: number;
  /** Normal tax computed. */
  normalTax: number;
  /** AMT payable (higher of the two). */
  amtPayable: number;
  /** Surcharge on AMT. */
  surcharge: number;
  /** Cess. */
  cess: number;
  totalAmtPayable: number;
  /** AMT credit utilised and carried forward. */
  amtCreditUtilised: number;
  amtCreditCarriedForward: number;
  notes?: string[];
}

/** Convenience constructor for empty adjustments. */
export function amtEmptyAdjustments(): {
  additions: number;
  deductions: number;
  lessReserve: number;
  plusReserve: number;
} {
  return { additions: 0, deductions: 0, lessReserve: 0, plusReserve: 0 };
}

export function scheduleMAT(input: AMTSchedule): ScheduleBlock {
  const adj = input.adjustments ?? { additions: 0, deductions: 0, lessReserve: 0, plusReserve: 0 };
  const lines: ScheduleLine[] = [
    line("Part A — Alternate Minimum Tax Computation", 0, 0, ""),
    line("1. Total Income (as per return)", input.totalIncome),
    line("Part B — Book Profit Adjustments (Companies u/s 115JB)", 0, 0, ""),
    line("2. Net Profit as shown in P&L", input.bookProfit ?? 0),
    line("3. Add: Items not deductible as per law", adj.additions),
    line("4. Less: Items not taxable as per law", adj.deductions),
    line("5. Less: Reserve/Provision (if any)", adj.lessReserve),
    line("6. Add: Reserve/Provision (if any)", adj.plusReserve),
    total("7. Book Profit (2 + 3 - 4 - 5 + 6)", input.amtBase),
    line("Part C — AMT Computation", 0, 0, ""),
    line(`8. AMT Rate (${input.amtRate}%)`, 0),
    line("9. AMT on Adjusted Total Income / Book Profit", input.amtComputed),
    line("10. Normal Tax on Total Income", input.normalTax),
    total("11. AMT Payable (higher of 9 & 10)", input.amtPayable),
    line("12. Surcharge on AMT", input.surcharge),
    line("13. Cess on AMT", input.cess),
    total("14. TOTAL AMT PAYABLE (11 + 12 + 13)", input.totalAmtPayable),
    line("Part D — AMT Credit", 0, 0, ""),
    line("15. AMT Credit Utilised in Current Year", input.amtCreditUtilised),
    line("16. AMT Credit Carried Forward", input.amtCreditCarriedForward),
  ];

  return sub("Schedule MAT/AMT — Alternate Minimum Tax", lines, "Total AMT Payable");
}

// ---------------------------------------------------------------------------
// Schedule FSI — Foreign Source Income (ITR-2/3/5/6)
// ---------------------------------------------------------------------------

export interface ForeignSourceIncome {
  countryName: string;
  countryCode: string; // ISO 2-letter
  /** Income from the country. */
  incomeFromCountry: number;
  /** Tax payable in the country (foreign tax). */
  foreignTaxPaid: number;
  /** Section under which the income is taxable in India (e.g. 9(1)(i), 9(1)(ii), etc.). */
  taxableSection?: string;
  /** Whether the income is taken into account for AMT/MAT purposes. */
  includedInAmt: boolean;
  /** Type of income. */
  incomeType: "business" | "property" | "capital gains" | "dividend" | "interest" | "other";
}

export interface FSISchedule {
  foreignSources: ForeignSourceIncome[];
  /** Total foreign income. */
  totalForeignIncome: number;
  totalForeignTaxPaid: number;
  /** Credit u/s 90/90A (lower of Indian tax and foreign tax). */
  taxCreditAllowed: number;
  /** Remaining credit to be carried forward. */
  creditCarryForward: number;
  notes?: string[];
}

export function scheduleFSI(input: FSISchedule): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule FSI — Income from Foreign Sources", 0, 0, ""),
    line("Sl. No.   Country        Income (₹)     Foreign Tax Paid     Section     Income Type", 0, 0, ""),
  ];

  let idx = 1;
  for (const fs of input.foreignSources) {
    lines.push(
      line(
        `${idx++}   ${fs.countryName} (${fs.countryCode})`,
        fs.incomeFromCountry,
        0,
        `${fs.foreignTaxPaid} | ${fs.taxableSection ?? "—"} | ${fs.incomeType}`,
      ),
    );
  }

  lines.push(total("Total Foreign Income", input.totalForeignIncome));
  lines.push(total("Total Foreign Tax Paid", input.totalForeignTaxPaid));
  lines.push(line("Tax Credit u/s 90/90A (lower of Indian tax & foreign tax)", input.taxCreditAllowed));
  lines.push(line("Credit to be carried forward", input.creditCarryForward));

  return sub("Schedule FSI — Foreign Source Income", lines, "Total");
}

// ---------------------------------------------------------------------------
// Schedule TR — Tax on Specified Income (Dividend, Interest, etc.)
// ---------------------------------------------------------------------------

export interface SpecifiedIncomeTax {
  /** Dividend income (exempt in hands of receiver but disclose). */
  dividendIncome: number;
  /** Interest income from deposits, bonds, etc. */
  interestIncome: number;
  /** Rental income from letting of property. */
  rentalIncome: number;
  /** Royalty income. */
  royaltyIncome: number;
  /** Winnings from lottery, crossword, etc. (30% flat + cess). */
  winningsIncome: number;
  /** Other specified income. */
  otherSpecifiedIncome: number;
  /** Total specified income. */
  totalSpecifiedIncome: number;
  /** Special tax rate for winnings (30% u/s 115BB). */
  winningsTaxRate: number;
  /** Tax on winnings. */
  taxOnWinnings: number;
  /** Normal tax on other specified income. */
  taxOnOtherSpecified: number;
  totalSpecifiedTax: number;
  notes?: string[];
}

export function scheduleTR(input: SpecifiedIncomeTax): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule TR — Tax on Specified Income", 0, 0, ""),
    line("Part A — Disaggregation of Specified Income", 0, 0, ""),
    line("1. Dividend Income (exempt u/s 10(34) - disclose)", input.dividendIncome),
    line("2. Interest Income (taxable)", input.interestIncome),
    line("3. Rental Income (taxable)", input.rentalIncome),
    line("4. Royalty Income (taxable)", input.royaltyIncome),
    line("5. Winnings from Lottery/Crossword/etc. u/s 115BB", input.winningsIncome),
    line("6. Other Specified Income", input.otherSpecifiedIncome),
    total("7. Total Specified Income (1 to 6)", input.totalSpecifiedIncome),
    line("Part B — Special Rate Taxation", 0, 0, ""),
    line("8. Winnings — Taxable at 30% u/s 115BB", input.winningsIncome),
    line(`9. Tax on Winnings @ ${input.winningsTaxRate}%`, input.taxOnWinnings),
    line("Part C — Normal Rate Taxation", 0, 0, ""),
    line(
      "10. Other Specified Income (taxable at normal rates)",
      input.dividendIncome +
        input.interestIncome +
        input.rentalIncome +
        input.royaltyIncome +
        input.otherSpecifiedIncome,
    ),
    line("11. Tax on Other Specified Income (at normal slab rates)", input.taxOnOtherSpecified),
    total("12. Total Tax on Specified Income (9 + 11)", input.totalSpecifiedTax),
  ];

  return sub("Schedule TR — Tax on Specified Income", lines, "Total Tax on Specified Income");
}

// ---------------------------------------------------------------------------
// Schedule FL — Foreign Assets / Foreign Accounts (FATCA/CRS reporting)
// ---------------------------------------------------------------------------

export interface ForeignAsset {
  /** Asset type. */
  assetType:
    "foreignBankAccount" | "foreignImmovableProperty" | "foreignFinancialAsset" | "foreignTrust" | "foreignCorporation";
  /** Country name and ISO code. */
  countryName: string;
  countryCode: string;
  /** Account/asset number or identifier. */
  accountNumber?: string;
  /** Peak balance or value during the year. */
  peakValue?: number;
  /** Average balance or value. */
  averageValue?: number;
  /** Whether the account was operational during the year. */
  isOperational: boolean;
  /** Interest/dividend income from the asset. */
  incomeFromAsset: number;
  /** Date of account opening. */
  accountOpened?: string;
  /** Date of account closing (if applicable). */
  accountClosed?: string;
}

export interface FLSchedule {
  foreignAssets: ForeignAsset[];
  /** Total number of foreign accounts/ assets. */
  totalCount: number;
  /** Total peak value. */
  totalPeakValue: number;
  /** Total income from foreign assets. */
  totalForeignAssetIncome: number;
  /** FATCA/CRS compliance declaration. */
  fatcaCrsStatus: "furnished" | "notFurnished" | "notApplicable";
  notes?: string[];
}

export function scheduleFL(input: FLSchedule): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule FL — Foreign Assets / Foreign Accounts (FATCA / CRS)", 0, 0, ""),
    line("Part A — Declaration", 0, 0, ""),
    line("1. FATCA/CRS Status", 0, 0, input.fatcaCrsStatus.toUpperCase()),
    line("Part B — Foreign Assets Detail", 0, 0, ""),
    line(
      "Sl. No.   Asset Type           Country        Account/Ref No.        Peak Value     Average Value   Operational   Income from Asset   Opened   Closed",
      0,
      0,
      "",
    ),
  ];

  let idx = 1;
  for (const fa of input.foreignAssets) {
    const val = fa.peakValue ?? 0;
    lines.push(
      line(
        `${idx++}   ${fa.assetType.replace("foreign", "").replace("BankAccount", "Bank Acc").replace("ImmovableProperty", "Immovable Prop").replace("FinancialAsset", "Financial Asset").replace("Trust", "Trust").replace("Corporation", "Corp")}`,
        0,
        0,
        `${fa.countryName} (${fa.countryCode}) | ${fa.accountNumber ?? "—"} | ${formatInr(val)} | ${formatInr(fa.averageValue ?? 0)} | ${fa.isOperational ? "Yes" : "No"} | ${formatInr(fa.incomeFromAsset)} | ${fa.accountOpened ?? "—"} | ${fa.accountClosed ?? "—"}`,
      ),
    );
  }

  lines.push(total("Total Number of Foreign Accounts/Assets", input.totalCount));
  lines.push(total("Total Peak Value of Foreign Assets", input.totalPeakValue));
  lines.push(total("Total Income from Foreign Assets", input.totalForeignAssetIncome));

  return sub("Schedule FL — Foreign Assets & Accounts", lines, "Total");
}

// ---------------------------------------------------------------------------
// Schedule FA — Foreign Assets (for ITR-2/3 residents with foreign income)
// ---------------------------------------------------------------------------

export interface FASchedule {
  /** For residents with foreign assets or foreign income. */
  hasForeignAssets: boolean;
  hasForeignIncome: boolean;
  foreignAssets: ForeignAsset[];
  foreignIncome: FSISchedule;
  /** Statement whether the assessee is a resident and ordinarily resident. */
  residentStatus: "resident" | "non-resident" | "not ordinarily resident";
  notes?: string[];
}

export function scheduleFA(input: FASchedule): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule FA — Foreign Assets and Foreign Income", 0, 0, ""),
    line("1. Resident Status", 0, 0, input.residentStatus.toUpperCase()),
    line("2. Has Foreign Assets?", 0, 0, input.hasForeignAssets ? "Yes" : "No"),
    line("3. Has Foreign Income?", 0, 0, input.hasForeignIncome ? "Yes" : "No"),
    line("Part A — Foreign Assets (same as Schedule FL)", 0, 0, ""),
    line("4. Number of Foreign Accounts/Assets", input.foreignAssets.length),
  ];

  let totalPeak = 0;
  for (const fa of input.foreignAssets) {
    totalPeak += fa.peakValue ?? 0;
  }
  lines.push(line("5. Total Peak Value", totalPeak));
  lines.push(line("6. Total Income from Foreign Assets", input.foreignIncome.totalForeignIncome));

  // The FSI schedule body is rendered by scheduleFSI for the caller's own use;
  // this block only cross-references it.
  lines.push(line("", 0));
  lines.push(line("7. Schedule FSI — Foreign Source Income (see below)", 0, 0, ""));

  return sub("Schedule FA — Foreign Assets & Income", lines, "Total");
}

// ---------------------------------------------------------------------------
// Schedule AL — Assets and Liabilities (end of year)
// ---------------------------------------------------------------------------

export interface AssetLiabilityItem {
  /** Type of asset or liability. */
  type:
    | "building"
    | "land"
    | "motorVehicle"
    | "bankBalance"
    | "cash"
    | "machinery"
    | "furniture"
    | "investment"
    | "bookDebts"
    | "otherAsset"
    | "securedLiability"
    | "unsecuredLiability"
    | "otherLiability";
  description: string;
  value: number; // minor units
}

export interface ALSCHEDULE {
  assets: AssetLiabilityItem[];
  liabilities: AssetLiabilityItem[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  notes?: string[];
}

export function scheduleAL(input: ALSCHEDULE): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule AL — Assets and Liabilities as at [31st March]", 0, 0, ""),
    line("Part A — Assets", 0, 0, ""),
    line("Sl. No.   Type          Description              Value (₹)", 0, 0, ""),
  ];

  let idx = 1;
  for (const a of input.assets) {
    lines.push(line(`${idx++}   ${a.type.replace(/([A-Z])/g, " $1").trim()}`, a.value, 0, a.description));
  }

  lines.push(total("Total Assets", input.totalAssets));
  lines.push(line("Part B — Liabilities", 0, 0, ""));
  idx = 1;
  for (const l of input.liabilities) {
    lines.push(line(`${idx++}   ${l.type.replace(/([A-Z])/g, " $1").trim()}`, l.value, 0, l.description));
  }
  lines.push(total("Total Liabilities", input.totalLiabilities));
  lines.push(total("Net Worth (Assets - Liabilities)", input.netWorth));

  return sub("Schedule AL — Assets & Liabilities", lines, "Net Worth");
}

// ---------------------------------------------------------------------------
// Schedule OMP — Overseas Master Data / Specified Person (for ITR-6 foreign
// company disclosure)
// ---------------------------------------------------------------------------

export interface ForeignCompanyStatus {
  /** Whether the company is a foreign company. */
  isForeignCompany: boolean;
  /** Country of incorporation. */
  countryOfIncorporation?: string;
  /** Date of incorporation. */
  dateOfIncorporation?: string;
  /** Place of effective management (POEM). */
  poemCountry?: string;
  /** Whether the company is a controlled foreign company (CFC) under 904. */
  isCFC: boolean;
  /** Whether the company qualifies as a notified venture capital company. */
  isNVCC: boolean;
  /** Whether the company is a unit-linked insurance policy. */
  isULIP: boolean;
  notes?: string[];
}

export function scheduleOMP(input: ForeignCompanyStatus): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule OMP — Overseas / Foreign Company Status", 0, 0, ""),
    line("1. Is Foreign Company?", 0, 0, input.isForeignCompany ? "Yes" : "No"),
    line("2. Country of Incorporation", 0, 0, input.countryOfIncorporation ?? "—"),
    line("3. Date of Incorporation", 0, 0, input.dateOfIncorporation ?? "—"),
    line("4. Place of Effective Management (POEM)", 0, 0, input.poemCountry ?? "—"),
    line("5. Controlled Foreign Company (CFC) u/s 904?", 0, 0, input.isCFC ? "Yes" : "No"),
    line("6. Notified Venture Capital Company?", 0, 0, input.isNVCC ? "Yes" : "No"),
    line("7. Unit-Linked Insurance Policy (ULIP)?", 0, 0, input.isULIP ? "Yes" : "No"),
  ];

  return sub("Schedule OMP — Overseas Master Profile", lines, "Status");
}

// ---------------------------------------------------------------------------
// Schedule TDS — TDS/TCS deductions (common across all forms)
// ---------------------------------------------------------------------------

export interface TDSDeduction {
  deductorName: string;
  deductorPan: string;
  section: string; // e.g. "194A", "194C", "194J", etc.
  amountCredited: number;
  tdsDeducted: number;
  tdsDeposited: number;
  challanNumber?: string;
  challanDate?: string;
  remarks?: string;
}

export interface TDSSCHEDULE {
  tdsDeductions: TDSDeduction[];
  tcsCollected: {
    collectorName: string;
    section: string;
    amountCollected: number;
    tcsDeposited: number;
  }[];
  totalTdsDeducted: number;
  totalTdsDeposited: number;
  totalTcsCollected: number;
  totalTcsDeposited: number;
  notes?: string[];
}

export function scheduleTDS(input: TDSSCHEDULE): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule TDS — Tax Deducted at Source / Tax Collected at Source", 0, 0, ""),
    line("Part A — TDS Details", 0, 0, ""),
    line(
      "Sl. No.   Deductor Name   PAN   Section   Amount Credited   TDS Deducted   TDS Deposited   Challan No.   Challan Date",
      0,
      0,
      "",
    ),
    line("Part B — TCS Details", 0, 0, ""),
  ];

  let idx = 1;
  for (const td of input.tdsDeductions) {
    lines.push(
      line(
        `${idx++}   ${td.deductorName}`,
        td.amountCredited,
        0,
        `${td.deductorPan} | ${td.section} | ${formatInr(td.tdsDeducted)} | ${formatInr(td.tdsDeposited)} | ${td.challanNumber ?? "—"} | ${td.challanDate ?? "—"}`,
      ),
    );
  }

  lines.push(total("Total TDS Deducted", input.totalTdsDeducted));
  lines.push(total("Total TDS Deposited", input.totalTdsDeposited));

  lines.push(line("Part B — TCS Details", 0, 0, ""));
  idx = 1;
  for (const tc of input.tcsCollected) {
    lines.push(
      line(
        `${idx++}   ${tc.collectorName}`,
        tc.amountCollected,
        0,
        `${tc.section} | ${formatInr(tc.amountCollected)} | ${formatInr(tc.tcsDeposited)}`,
      ),
    );
  }

  lines.push(total("Total TCS Collected", input.totalTcsCollected));
  lines.push(total("Total TCS Deposited", input.totalTcsDeposited));

  return sub("Schedule TDS — TDS/TCS", lines, "Total TDS/TCS");
}

// ---------------------------------------------------------------------------
// Schedule SPI — Statement of Profit from Speculation Business (ITR-5/6)
// ---------------------------------------------------------------------------

export interface SpeculationBusiness {
  turnover: number;
  expenses: number;
  netProfit: number;
  /** Whether this is a speculative business. */
  isSpeculative: boolean;
}

export function scheduleSPI(input: SpeculationBusiness): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule SPI — Speculative Business Income", 0, 0, ""),
    line("1. Turnover from Speculative Business", input.turnover),
    line("2. Total Expenses", input.expenses),
    total("3. Net Profit from Speculation (1 - 2)", input.netProfit),
    line(
      "4. Nature of Speculative Business",
      0,
      0,
      input.isSpeculative ? "Speculation business u/s 43(5)" : "Non-speculative",
    ),
  ];

  return sub("Schedule SPI — Speculation Business", lines, "Net Profit");
}

// ---------------------------------------------------------------------------
// Schedule PT — Pension & Annuity (ITR-1/2)
// ---------------------------------------------------------------------------

export interface PensionIncome {
  grossPension: number;
  standardDeduction: number;
  netPension: number;
  /** Family pension if any. */
  familyPension: number;
  /** Commuted pension value. */
  commutedPension: number;
  /** Uncommuted pension. */
  uncommutedPension: number;
}

export function schedulePT(input: PensionIncome): ScheduleBlock {
  const lines: ScheduleLine[] = [
    line("Schedule PT — Pension & Annuity", 0, 0, ""),
    line("1. Gross Pension (Commuted + Uncommuted)", input.grossPension),
    line("2. Less: Standard Deduction (30%)", input.standardDeduction),
    total("3. Net Taxable Pension (1 - 2)", input.netPension),
    line("Part B — Family Pension", 0, 0, ""),
    line("4. Family Pension Received", input.familyPension),
    line(
      "5. Standard Deduction on Family Pension (33.33% or ₹15,000 whichever less)",
      Math.min(input.familyPension * 0.3333, 15000),
    ),
    total("6. Net Family Pension Taxable", input.familyPension - Math.min(input.familyPension * 0.3333, 15000)),
    line("Part C — Commuted & Uncommuted", 0, 0, ""),
    line("7. Commuted Pension (tax exempt subject to limits)", input.commutedPension),
    line("8. Uncommuted Pension (taxable)", input.uncommutedPension),
  ];

  return sub("Schedule PT — Pension & Annuity", lines, "Net Taxable Pension");
}

// ---------------------------------------------------------------------------
// ITR Schedule Payload builder
// ---------------------------------------------------------------------------

export function buildITRSchedulePayload(opts: {
  formType: "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  assessmentYear: string;
  general: Record<string, unknown>;
  schedules: Record<string, ScheduleBlock>;
  income: Record<string, number>;
  tax: Record<string, number>;
}): ITRSchedulePayload {
  return {
    formType: opts.formType,
    assessmentYear: opts.assessmentYear,
    general: opts.general,
    income: opts.income,
    tax: opts.tax,
    schedules: opts.schedules,
    toJson() {
      return {
        ...this.general,
        form_type: this.formType,
        assessment_year: this.assessmentYear,
        income: this.income,
        tax: this.tax,
        schedules: this.schedules,
      };
    },
    toXml() {
      const esc = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const indent = (n: number) => "  ".repeat(n);
      const lines: string[] = [];
      lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
      lines.push(`<ITR form_type="${esc(this.formType)}" assessment_year="${esc(this.assessmentYear)}">`);
      // General info.
      lines.push(`${indent(1)}<General>`);
      for (const [k, v] of Object.entries(this.general)) {
        const val = typeof v === "string" ? esc(v) : v;
        lines.push(`${indent(2)}<Item name="${esc(k)}">${val}</Item>`);
      }
      lines.push(`${indent(1)}</General>`);
      // Income.
      lines.push(`${indent(1)}<Income>`);
      for (const [k, v] of Object.entries(this.income)) {
        lines.push(`${indent(2)}<Item name="${esc(k)}">${v}</Item>`);
      }
      lines.push(`${indent(1)}</Income>`);
      // Tax.
      lines.push(`${indent(1)}<Tax>`);
      for (const [k, v] of Object.entries(this.tax)) {
        lines.push(`${indent(2)}<Item name="${esc(k)}">${v}</Item>`);
      }
      lines.push(`${indent(1)}</Tax>`);
      // Schedules.
      lines.push(`${indent(1)}<Schedules>`);
      for (const [code, sched] of Object.entries(this.schedules)) {
        const s = sched as ScheduleBlock;
        lines.push(`${indent(2)}<Schedule code="${esc(code)}">`);
        lines.push(`${indent(3)}<header>${esc(s.header)}</header>`);
        lines.push(`${indent(3)}<Lines>`);
        s.lines.forEach((l) => {
          const amt = l.notes && l.notes.startsWith("Total") ? ` total="${esc(l.notes)}"` : ``;
          const noteAttr = l.notes && !l.notes.startsWith("Total") ? ` note="${esc(l.notes)}"` : ``;
          const colAttr = l.col !== undefined ? ` col="${l.col}"` : ``;
          lines.push(`${indent(4)}<Line${colAttr}${noteAttr}${amt}>${esc(l.label)}: ${l.amount}</Line>`);
        });
        lines.push(`${indent(3)}</Lines>`);
        if (s.notes && s.notes.length > 0) {
          lines.push(`${indent(3)}<Notes>`);
          for (const n of s.notes) {
            lines.push(`${indent(4)}<Note>${esc(n)}</Note>`);
          }
          lines.push(`${indent(3)}</Notes>`);
        }
        // Sub-schedules.
        if (s.sub) {
          for (const [subCode, subSched] of Object.entries(s.sub)) {
            lines.push(`${indent(3)}<SubSchedule code="${esc(subCode)}">`);
            lines.push(`${indent(4)}<header>${esc(subSched.header)}</header>`);
            lines.push(`${indent(4)}<Lines>`);
            const sub = subSched as ScheduleBlock;
            sub.lines.forEach((l) => {
              const attr = l.notes ? ` note="${esc(l.notes)}"` : ``;
              lines.push(`${indent(5)}<Line${attr}>${esc(l.label)}: ${l.amount}</Line>`);
            });
            lines.push(`${indent(4)}</Lines>`);
            lines.push(`${indent(3)}</SubSchedule>`);
          }
        }
        lines.push(`${indent(2)}</Schedule>`);
      }
      lines.push(`${indent(1)}</Schedules>`);
      lines.push(`</ITR>`);
      return lines.join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a full ITR-5 payload for a partnership/LLP
// ---------------------------------------------------------------------------

export interface ITR5FullInput {
  general: Record<string, unknown>;
  /** Income heads. */
  income: ITR5IncomeSchedule;
  /** Business computation. */
  business: BusinessIncomeSchedule;
  /** Profit sharing. */
  profitSharing: PartnershipProfitSharing;
  /** Deductions. */
  deductions: ChapterVΙADeductions;
  /** Foreign income. */
  foreign: FSISchedule;
  /** Foreign assets. */
  foreignAssets: FLSchedule;
  /** Specified income. */
  specifiedIncome: SpecifiedIncomeTax;
  /** AMT/MAT. */
  mat: AMTSchedule;
  /** TDS. */
  tds: TDSSCHEDULE;
  /** Total income (computed). */
  totalIncome: number;
  /** Regime tax computation summary. */
  taxSummary: {
    taxBeforeRebate: number;
    rebate: number;
    surcharge: number;
    cess: number;
    totalTax: number;
    tds: number;
    advanceTax: number;
    selfAssessmentTax: number;
    netPayable: number;
  };
}

export function buildITR5Payload(input: ITR5FullInput): ITRSchedulePayload {
  const scheds: Record<string, ScheduleBlock> = {
    BP: scheduleBP(input.business),
    PITR5: schedulePITR5Income(input.income),
    PMT: schedulePMT(input.profitSharing),
    DI: scheduleDI(input.deductions, "old"),
    FSI: scheduleFSI(input.foreign),
    FL: scheduleFL(input.foreignAssets),
    TR: scheduleTR(input.specifiedIncome),
    MAT: scheduleMAT(input.mat),
    TDS: scheduleTDS(input.tds),
    AL: scheduleAL({
      assets: [],
      liabilities: [],
      totalAssets: 0,
      totalLiabilities: 0,
      netWorth: 0,
    }),
    SPI: scheduleSPI({ turnover: 0, expenses: 0, netProfit: 0, isSpeculative: false }),
    EI: scheduleEI({}),
  };

  // Remove empty schedules.
  for (const key of Object.keys(scheds)) {
    const block = scheds[key];
    if (block && block.lines.filter((l) => l.amount !== 0 && l.label !== "").length === 0) {
      delete scheds[key];
    }
  }

  return buildITRSchedulePayload({
    formType: "ITR-5",
    assessmentYear: (input.general["assessment_year"] as string) ?? "2025-26",
    general: input.general,
    schedules: scheds,
    income: {
      "Total Income from Business": input.income.businessIncome,
      "Total Income from House Property": input.income.houseProperty,
      "Total Capital Gains": input.income.capitalGains?.total ?? 0,
      "Total Other Sources Income": input.income.otherSources,
      "Total Specified Income":
        input.income.specifiedIncome.dividend +
        input.income.specifiedIncome.interest +
        input.income.specifiedIncome.rent +
        input.income.specifiedIncome.royalty +
        input.income.specifiedIncome.winnings +
        input.income.specifiedIncome.other,
      "Gross Total Income": input.totalIncome,
    },
    tax: {
      "Tax Before Rebate": input.taxSummary.taxBeforeRebate,
      "Rebate u/s 87A": input.taxSummary.rebate,
      Surcharge: input.taxSummary.surcharge,
      Cess: input.taxSummary.cess,
      "Total Tax Liability": input.taxSummary.totalTax,
      "Less: TDS": input.taxSummary.tds,
      "Less: Advance Tax": input.taxSummary.advanceTax,
      "Less: Self-Assessment Tax": input.taxSummary.selfAssessmentTax,
      "Net Tax Payable/(Refundable)": input.taxSummary.netPayable,
    },
  });
}

// ---------------------------------------------------------------------------
// Convenience: build a full ITR-6 payload for a company
// ---------------------------------------------------------------------------
export interface ITR6FullInput {
  general: Record<string, unknown>;
  /** P&L. */
  pl: CompanyPL;
  /** Business computation. */
  business: BusinessIncomeSchedule;
  /** Company tax computation. */
  taxComputation: CompanyTaxComputation;
  /** Foreign income. */
  foreign: FSISchedule;
  /** Foreign assets. */
  foreignAssets: FLSchedule;
  /** Foreign company status. */
  foreignCompanyStatus: ForeignCompanyStatus;
  /** Specified income. */
  specifiedIncome: SpecifiedIncomeTax;
  /** AMT/MAT. */
  mat: AMTSchedule;
  /** TDS. */
  tds: TDSSCHEDULE;
  /** Total income. */
  totalIncome: number;
  notes?: string[];
}

export function buildITR6Payload(input: ITR6FullInput): ITRSchedulePayload {
  const scheds: Record<string, ScheduleBlock> = {
    PLC: schedulePLC(input.pl as CompanyPL),
    CYM: scheduleCYM(input.taxComputation),
    FSI: scheduleFSI(input.foreign),
    FL: scheduleFL(input.foreignAssets),
    OMP: scheduleOMP(input.foreignCompanyStatus),
    TR: scheduleTR(input.specifiedIncome),
    MAT: scheduleMAT(input.mat),
    TDS: scheduleTDS(input.tds),
    AL: scheduleAL({
      assets: [],
      liabilities: [],
      totalAssets: 0,
      totalLiabilities: 0,
      netWorth: 0,
    }),
    BP: scheduleBP(input.business),
    EI: scheduleEI({}),
  };

  for (const key of Object.keys(scheds)) {
    const block = scheds[key];
    if (block && block.lines.filter((l) => l.amount !== 0 && l.label !== "").length === 0) {
      delete scheds[key];
    }
  }

  return buildITRSchedulePayload({
    formType: "ITR-6",
    assessmentYear: (input.general["assessment_year"] as string) ?? "2025-26",
    general: input.general,
    schedules: scheds,
    income: {
      "Revenue from Operations": input.pl.revenueFromOperations,
      "Other Income": input.pl.otherIncome,
      "Total Income": input.totalIncome,
      "Business Income": input.business.businessIncomeReturn,
      "Capital Gains": input.foreign.totalForeignIncome,
    },
    tax: {
      "Normal Tax": 0, // computed in scheduleCYM
      "MAT u/s 115JB": 0, // computed in scheduleCYM
      Surcharge: 0, // computed in scheduleCYM
      Cess: 0, // computed in scheduleCYM
      "Total Tax": 0, // computed in scheduleCYM
      "Less: TDS": input.tds.totalTdsDeducted,
      "Less: Advance Tax": input.taxComputation.advanceTax,
      "Less: Self-Assessment Tax": input.taxComputation.selfAssessmentTax,
      "Net Tax Payable/(Refundable)": 0, // computed in scheduleCYM
    },
  });
}

// ---------------------------------------------------------------------------
// Convenience: build a full ITR-3 payload for individual/HUF with business
// ---------------------------------------------------------------------------

export interface ITR3FullInput {
  general: Record<string, unknown>;
  /** Business computation. */
  business: BusinessIncomeSchedule;
  /** House property. */
  houseProperty?: number;
  /** Capital gains. */
  capitalGains?: { shortTerm: number; longTerm: number; total: number };
  /** Other sources. */
  otherSources?: number;
  /** Agricultural income. */
  agriculturalIncome?: number;
  /** Deductions. */
  deductions: ChapterVΙADeductions;
  /** Foreign income. */
  foreign: FSISchedule;
  /** Foreign assets. */
  foreignAssets: FLSchedule;
  /** Specified income. */
  specifiedIncome: SpecifiedIncomeTax;
  /** AMT. */
  mat: AMTSchedule;
  /** TDS. */
  tds: TDSSCHEDULE;
  /** Total income. */
  totalIncome: number;
  /** Tax summary. */
  taxSummary: {
    taxBeforeRebate: number;
    rebate: number;
    surcharge: number;
    cess: number;
    totalTax: number;
    tds: number;
    advanceTax: number;
    selfAssessmentTax: number;
    netPayable: number;
  };
}

export function buildITR3Payload(input: ITR3FullInput): ITRSchedulePayload {
  const scheds: Record<string, ScheduleBlock> = {
    BP: scheduleBP(input.business),
    DI: scheduleDI(input.deductions, "old"),
    FSI: scheduleFSI(input.foreign),
    FL: scheduleFL(input.foreignAssets),
    TR: scheduleTR(input.specifiedIncome),
    MAT: scheduleMAT(input.mat),
    TDS: scheduleTDS(input.tds),
    AL: scheduleAL({
      assets: [],
      liabilities: [],
      totalAssets: 0,
      totalLiabilities: 0,
      netWorth: 0,
    }),
    EI: scheduleEI({
      agricultural: input.agriculturalIncome ?? 0,
    }),
    SPI: scheduleSPI({ turnover: 0, expenses: 0, netProfit: 0, isSpeculative: false }),
    PT: schedulePT({
      grossPension: 0,
      standardDeduction: 0,
      netPension: 0,
      familyPension: 0,
      commutedPension: 0,
      uncommutedPension: 0,
    }),
  };

  for (const key of Object.keys(scheds)) {
    const block = scheds[key];
    if (block && block.lines.filter((l) => l.amount !== 0 && l.label !== "").length === 0) {
      delete scheds[key];
    }
  }

  const houseProperty = input.houseProperty ?? 0;
  const capitalGains = input.capitalGains ?? { shortTerm: 0, longTerm: 0, total: 0 };
  const otherSources = input.otherSources ?? 0;

  return buildITRSchedulePayload({
    formType: "ITR-3",
    assessmentYear: (input.general["assessment_year"] as string) ?? "2025-26",
    general: input.general,
    schedules: scheds,
    income: {
      "Salary Income": 0, // ITR-3 with more detail
      "House Property Income": houseProperty,
      "Capital Gains": capitalGains.total,
      "Business/Profession Income": input.business.businessIncomeReturn,
      "Other Sources Income": otherSources,
      "Agricultural Income (exempt)": input.agriculturalIncome ?? 0,
      "Gross Total Income": input.totalIncome,
    },
    tax: input.taxSummary,
  });
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

export interface ITRScheduleValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateITR5Payload(p: ITRSchedulePayload): ITRScheduleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (p.formType !== "ITR-5") errors.push("formType must be ITR-5");
  if (!p.assessmentYear.match(/^\d{4}-\d{2}$/)) errors.push("assessmentYear must be yyyy-mm");

  // Required schedules.
  if (!p.schedules["BP"]) errors.push("Schedule BP (Business/Profession) is required for ITR-5");
  if (!p.schedules["PMT"]) errors.push("Schedule PMT (Profit Sharing) is required for ITR-5");

  // Income and tax totals.
  const income = p.income;
  const grossIncome = income["Gross Total Income"] ?? 0;
  if (grossIncome <= 0) warnings.push("Gross Total Income appears to be zero or negative");

  const tax = p.tax;
  const totalTax = tax["Total Tax Liability"] ?? 0;
  if (totalTax < 0) warnings.push("Total Tax Liability is negative — check computations");

  const netPayable = tax["Net Tax Payable/(Refundable)"] ?? 0;
  if (netPayable < 0 && tax["Less: TDS"] === undefined) warnings.push("Refundable amount without TDS recorded");

  return { valid: errors.length === 0, errors, warnings };
}

export function validateITR6Payload(p: ITRSchedulePayload): ITRScheduleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (p.formType !== "ITR-6") errors.push("formType must be ITR-6");
  if (!p.assessmentYear.match(/^\d{4}-\d{2}$/)) errors.push("assessmentYear must be yyyy-mm");

  if (!p.schedules["PLC"]) errors.push("Schedule PLC (P&L) is required for ITR-6");
  if (!p.schedules["CYM"]) errors.push("Schedule CYM (Tax Computation) is required for ITR-6");

  return { valid: errors.length === 0, errors, warnings };
}

export function validateITR3Payload(p: ITRSchedulePayload): ITRScheduleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (p.formType !== "ITR-3") errors.push("formType must be ITR-3");
  if (!p.assessmentYear.match(/^\d{4}-\d{2}$/)) errors.push("assessmentYear must be yyyy-mm");

  if (!p.schedules["BP"]) errors.push("Schedule BP (Business/Profession) is required for ITR-3");

  return { valid: errors.length === 0, errors, warnings };
}

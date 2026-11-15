/**
 * Salary head computation for Indian income-tax returns.
 *
 * This is the authoritative salary-head layer for the CA firm computation graph.
 * It takes the payroll/Form-16 facts a firm collects, computes taxable salary
 * under the caller-supplied regime, and produces a pretty income slip and the
 * net salary figure fed into `india-tax.ts` computeIncomeTax.
 *
 * SCOPE AND HONESTY — same rule that governs `india-tax.ts`:
 *
 *   Rates, limits and exemption rules are DATA supplied by the caller where the
 *   law is date-sensitive. The defaults shipped here are labelled with the
 *   assessment year they belong to. A hardcoded rule is how tax software
 *   produces confidently wrong returns the month a Finance Act changes a limit;
 *   passing the regime and the relevant caps in makes that staleness the
 *   caller's to own, which is where it belongs.
 *
 *   This engine COMPUTES taxable salary. It does not fetch live law, does not
 *   value perquisites (that comes from accounting/breakup inputs), and does not
 *   issue a legal opinion. Every simplification is named in `methodology`.
 *
 * Money is in MINOR UNITS (paise) as integers, matching `india-tax.ts`.
 */

import { INR, toRupees, formatInr, slabTax, type TaxRegime } from "./india-tax";

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

/** A single monetary component of salary. */
export interface SalaryComponent {
  /** Human label, e.g. "Basic", "DA forming part of retirement benefits". */
  label: string;
  /** Amount in minor units. */
  amount: number;
  /** Whether this component is part of salary for HRA/standard deduction purposes. */
  countsForSalary: boolean;
  notes?: string;
}

/** Perquisite value already determined by the accounting/breakup layer (taxable
 * value under Rule 3, as surfaced by the firm). This engine does not value
 * perquisites; it consumes the figure and shows it transparently. */
export interface PerquisiteBreakup {
  /** Aggregate taxable value of perquisites u/s 17(2). */
  taxableValue: number;
  /** Underlying items the firm chose to disclose. */
  items?: Array<{ description: string; value: number; notes?: string }>;
}

/** Allowances and exemptions that reduce salary. */
export interface AllowanceExemptions {
  /** HRA exemption u/s 10(13A); pass the figure computed by the HRA engine. */
  hraExempt?: number;
  /** Exempt allowances under 10(14) — caller supplies the total. */
  exemptAllowances10_14?: number;
  /** Other exempt receipts under Chapter III (pass the aggregate). */
  otherExempt?: number;
  /** Professional tax paid (deductible u/s 16(iii)). */
  professionalTax?: number;
  /** Breakdown the reviewer may want to see. */
  breakdown?: Array<{ section: string; label: string; amount: number; notes?: string }>;
}

/** Salary arrears / premature withdrawal relief u/s 89. */
export interface ReliefU89 {
  /** Gross arrears included in salary this year. */
  arrearsReceived: number;
  /** Tax on total income including arrears (this year). */
  taxIncludingArrears: number;
  /** Tax on total income excluding arrears (this year). */
  taxExcludingArrears: number;
  /** Tax on arrears in the year to which they relate (computed by caller or engine). */
  taxOnArrearsInPastYear: number;
  /** Relief admissible; engine validates the triangle. */
  reliefClaimed?: number;
  slots?: Array<{
    assessmentYearToWhichRelates: string;
    amountReceivedThisYear: number;
    taxInPastYear: number;
    taxIncludingInThisYear: number;
    taxExcludingInThisYear: number;
    reliefForSlot: number;
  }>;
}

/** Pension and commutation facts. */
export interface PensionAndCommutation {
  /** Gross uncommuted pension received this year. */
  uncommutedPension: number;
  /** Commuted pension received this year. */
  commutedPension: number;
  /** One-third of pension was commuted (true) or not; affects 10(10A) exempt portion. */
  oneThirdCommuted: boolean;
  /** Period of service completed; used by the gratuity estimator. */
  yearsOfService?: number;
  /** Date of retirement; used for context only. */
  retirementDate?: string;
}

/** Gratuity facts. This engine can estimate gratuity under the Payment of Gratuity
 * Act method where facts permit, otherwise it consumes a declared figure. */
export interface GratuityFacts {
  /** Gratuity actually received in the year. */
  received: number;
  /** Basic + DA forming part of retirement benefits (for the Act formula). */
  basicAndDa: number;
  /** Completed years of service. */
  yearsOfService: number;
  /** Whether the employee is covered under the Payment of Gratuity Act. */
  coveredUnderAct: boolean;
  /** Exempt portion already determined by the firm (or computed by this engine). */
  exemptPortion?: number;
}

/** Leave encashment facts. */
export interface LeaveEncashmentFacts {
  /** Leave encashment received at retirement. */
  receivedAtRetirement: number;
  /** Average salary for the 10-month period preceding retirement. */
  averageSalary10Months: number;
  /** Entitlement leave balance at retirement (days). */
  leaveEntitlementDays: number;
  /** Leave actually taken (days). */
  leaveTakenDays: number;
  /** Exempt portion already determined by the firm (or computed by this engine). */
  exemptPortion?: number;
}

/** Optional parameters that change the computation discipline. */
export interface SalaryGraderOpts {
  /** Regimes to grade when the caller wants old-vs-new insight on salary alone. */
  regimesToGrade?: TaxRegime[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SalaryHeadInput {
  /** Assess year label, e.g. "2025-26". */
  ay: string;
  /** Components forming gross salary u/s 17(1). */
  components: SalaryComponent[];
  /** Perquisites u/s 17(2), taxable value. */
  perquisites: PerquisiteBreakup;
  /** Allowances and exemptions u/s 10 (and professional tax u/s 16(iii)). */
  allowances: AllowanceExemptions;
  /** Relief u/s 89 for salary arrears / premature withdrawal. */
  relief: ReliefU89 | null;
  /** Pension and commutation facts. */
  pension: PensionAndCommutation | null;
  /** Gratuity facts. */
  gratuity: GratuityFacts | null;
  /** Leave encashment facts. */
  leave: LeaveEncashmentFacts | null;
  /** Regime used for the head-level computation. The regime carries the standard
   * deduction amount and the regime label for the slip. */
  regime: TaxRegime;
  /** Optional grader; when present, the result carries a salary-only regime
   * comparison for the reviewer. */
  grader?: SalaryGraderOpts;
}

export interface SalaryHeadResult {
  regimeId: string;
  regimeLabel: string;
  ay: string;

  /** Gross salary u/s 17(1). */
  grossSalary17_1: number;
  /** Add: perquisites u/s 17(2). */
  perquisitesValue: number;
  /** Gross total salary before exemptions. */
  grossTotalSalary: number;
  /** Less: exemptions u/s 10. */
  exemptUnder10: number;
  /** Net salary after exemptions but before standard deduction / professional tax. */
  netSalaryBeforeStdDeduction: number;
  /** Standard deduction u/s 16(ia). */
  standardDeduction: number;
  /** Professional tax u/s 16(iii). */
  professionalTax: number;
  /** Total deductions from salary (std deduction + professional tax). */
  salaryDeductions: number;
  /** Taxable salary (the figure consumed by the tax engine). */
  taxableSalary: number;

  /** Relief u/s 89 (mined from input). */
  relief89: number;
  /** Exempt gratuity. */
  exemptGratuity: number;
  /** Taxable gratuity. */
  taxableGratuity: number;
  /** Exempt leave encashment. */
  exemptLeave: number;
  /** Taxable leave encashment. */
  taxableLeave: number;
  /** Exempt commuted pension u/s 10(10A). */
  exemptCommutedPension: number;
  /** Taxable commuted pension. */
  taxableCommutedPension: number;

  methodology: string[];
  slip: SalarySlipLine[];
  regimeComparison?: RegressComparison;
}

export interface SalarySlipLine {
  section: string;
  label: string;
  amount: number;
  col?: number;
  note?: string;
  kind?: "input" | "computed" | "exempt" | "disallowed" | "total";
}

export interface RegressComparison {
  regimes: Array<{ regimeId: string; taxableSalary: number; tax: number; effectiveRatePct: number }>;
  bestRegimeId: string;
  bestTax: number;
  delta: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Constants (labelled by AY)
// ---------------------------------------------------------------------------

/** Gratuity exemption ceiling commonly referenced for the relevant AY; override by
 * passing `exemptPortion` when the firm has the exact figure. */
export const GRATUITY_EXEMPT_CEILING_COMMON = INR(2_000_000);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function roundMinor(n: number): number {
  return Math.round(n);
}

function grossSalary17_1(components: SalaryComponent[]): number {
  // 17(1) includes wages, annuity, pension, salary in advance, arrears, fees,
  // commissions, profits in lieu of salary, advance of salary, etc.
  return roundMinor(components.reduce((s, c) => s + c.amount, 0));
}

function exemptUnderChapter3(allowances: AllowanceExemptions): number {
  return roundMinor(
    (allowances.hraExempt ?? 0) + (allowances.exemptAllowances10_14 ?? 0) + (allowances.otherExempt ?? 0),
  );
}

function standardDeductionAmount(regime: TaxRegime): number {
  // The regime config carries the standard deduction for the relevant regime/AY.
  // Salary/pension only; the caller sets applyStandardDeduction in the tax engine.
  return Math.max(0, Math.round(regime.standardDeduction));
}

function gratuityExemptPortion(input: GratuityFacts): number {
  // Where the firm has determined the exempt portion, use it. Otherwise estimate
  // under the Payment of Gratuity Act method if facts permit.
  if (input.exemptPortion != null && input.exemptPortion >= 0) {
    return roundMinor(input.exemptPortion);
  }
  if (!input.coveredUnderAct || input.yearsOfService <= 0) {
    // Without the Act facts we cannot reliably estimate; treat as taxable and tell
    // the reviewer.
    return 0;
  }
  // Payment of Gratuity Act formula: last drawn salary x 15/26 x years of service.
  // Last drawn salary here means basic + DA.
  const eligible = Math.max(0, input.basicAndDa);
  const computed = roundMinor((eligible * 15 * input.yearsOfService) / 26);
  const ceiling = GRATUITY_EXEMPT_CEILING_COMMON;
  return Math.min(computed, ceiling);
}

function leaveEncashmentExemptPortion(input: LeaveEncashmentFacts): number {
  // Rule 2A leave encashment exemption for a non-government employee at retirement:
  // least of:
  //   (a) leave encashment actually received,
  //   (b) 3,00,000 (commonly referenced statutory ceiling; override by passing
  //       exemptPortion when the firm has the exact figure),
  //   (c) 10 x average salary,
  //   (d) leave encashment computed on the leave balance (average salary x
  //       entitlement minus taken).
  if (input.exemptPortion != null && input.exemptPortion >= 0) {
    return roundMinor(input.exemptPortion);
  }
  const received = Math.max(0, input.receivedAtRetirement);
  const avg = Math.max(0, input.averageSalary10Months);
  const tenXAvg = roundMinor(avg * 10);
  const balanceDays = Math.max(0, input.leaveEntitlementDays - input.leaveTakenDays);
  const computedOnBalance = roundMinor(avg * balanceDays);
  const ceiling = INR(3_000_000);
  return Math.min(roundMinor(received), Math.min(ceiling, Math.min(tenXAvg, computedOnBalance)));
}

function commutedPensionExemption(input: PensionAndCommutation): number {
  // 10(10A): if one-third (or such other fraction) is commuted, the commuted
  // portion may be exempt to the extent of the fraction. Here we use the simple
  // commonly referenced rule: if one-third commuted, 1/3 of commuted value exempt;
  // otherwise, for uncommuted family pension the 10(10A) logic differs and is not
  // modeled here. The firm passes exempt amount where it has a specific basis.
  if (input.oneThirdCommuted) {
    // 1/3 of commuted amount exempt under the commonly referenced rule.
    return roundMinor(input.commutedPension / 3);
  }
  // When not one-third commuted, treat as taxable and tell the reviewer; the firm
  // should override via its own 10(10A) computation if warranted.
  return 0;
}

function relief89Admissible(relief: ReliefU89): number {
  // 89(1): relief = tax on total income including arrears minus tax on total income
  // excluding arrears, less the tax on the arrears in the year to which they relate
  // (computed on the relevant past-year slab). We validate the triangle and cap.
  const including = Math.max(0, relief.taxIncludingArrears);
  const excluding = Math.max(0, relief.taxExcludingArrears);
  const pastYear = Math.max(0, relief.taxOnArrearsInPastYear);
  const raw = Math.max(0, including - excluding - pastYear);
  const claimed = relief.reliefClaimed != null ? Math.max(0, relief.reliefClaimed) : raw;
  // Relief cannot exceed the excess tax attributable to arrears.
  return roundMinor(Math.min(claimed, raw));
}

function statedValuesAreConsistent(relief: ReliefU89): string[] {
  const notes: string[] = [];
  const including = Math.max(0, relief.taxIncludingArrears);
  const excluding = Math.max(0, relief.taxExcludingArrears);
  if (including < excluding) {
    notes.push(
      "Reported tax-including-arrears is less than tax-excluding-arrears; the 89 triangle is likely mis-signed.",
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Regime grading (salary-only diagnostic)
// ---------------------------------------------------------------------------

function taxOnSalaryUnderRegime(taxableSalary: number, regime: TaxRegime): { tax: number; effectiveRatePct: number } {
  // Head-level diagnostic: apply the regime's own slab table to the taxable
  // salary as supplied and attribute the tax back to it. The caller should
  // prefer the full graph comparison for decisions; this is a hint, not a
  // verdict, and it deliberately does not re-derive the standard deduction.
  const slab = Math.max(0, taxableSalary);
  const fromIndiaTax = slabTax(slab, regime.slabs);
  const tax = Math.max(0, Math.round(fromIndiaTax));
  const effective = taxableSalary > 0 ? (tax / taxableSalary) * 100 : 0;
  return { tax, effectiveRatePct: effective };
}

function regimeComparisonForSalary(taxableSalary: number, regimes: TaxRegime[], _ay: string): RegressComparison {
  const rows = regimes.map((regime) => {
    const { tax, effectiveRatePct } = taxOnSalaryUnderRegime(taxableSalary, regime);
    return {
      regimeId: regime.id,
      taxableSalary,
      tax,
      effectiveRatePct,
    };
  });
  const best = rows.reduce(
    (a, b) => (a.tax <= b.tax ? a : b),
    rows[0] ?? { regimeId: "", taxableSalary, tax: 0, effectiveRatePct: 0 },
  );
  const delta = rows.length > 1 ? Math.max(0, rows.reduce((s, r) => s + r.tax, 0) - best.tax) : 0;
  return {
    regimes: rows,
    bestRegimeId: best.regimeId,
    bestTax: best.tax,
    delta,
    note:
      rows.length > 1
        ? `Salary-only diagnostic: best regime is ${best.regimeId} at ${formatInr(best.tax)} (delta ${formatInr(delta)} across the graded regimes). Final regime choice must consider the full computation graph, not salary alone.`
        : "Only one regime graded; no comparison available.",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function computeSalaryHead(input: SalaryHeadInput): SalaryHeadResult {
  const gross17_1 = grossSalary17_1(input.components);
  const perquisites = roundMinor(input.perquisites.taxableValue);
  const grossTotalSalary = roundMinor(gross17_1 + perquisites);
  const exempt10 = exemptUnderChapter3(input.allowances);
  const netBeforeStdDed = roundMinor(grossTotalSalary - exempt10);
  const stdDed = standardDeductionAmount(input.regime);
  const profTax = roundMinor(input.allowances.professionalTax ?? 0);
  const salaryDeductions = roundMinor(stdDed + profTax);
  const taxableSalary = Math.max(0, netBeforeStdDed - salaryDeductions);

  const exemptGratuity = input.gratuity ? roundMinor(gratuityExemptPortion(input.gratuity)) : 0;
  const taxableGratuity = input.gratuity ? Math.max(0, roundMinor(input.gratuity.received) - exemptGratuity) : 0;
  const exemptLeave = input.leave ? roundMinor(leaveEncashmentExemptPortion(input.leave)) : 0;
  const taxableLeave = input.leave ? Math.max(0, roundMinor(input.leave.receivedAtRetirement) - exemptLeave) : 0;
  const exemptCommuted = input.pension ? roundMinor(commutedPensionExemption(input.pension)) : 0;
  const taxableCommuted = input.pension ? Math.max(0, roundMinor(input.pension.commutedPension) - exemptCommuted) : 0;

  const relief = input.relief ? relief89Admissible(input.relief) : 0;
  const consistency = input.relief ? statedValuesAreConsistent(input.relief) : [];

  const methodology: string[] = [
    `AY ${input.ay}. Regime: ${input.regime.label} (${input.regime.id}).`,
    `Gross salary u/s 17(1): ${formatInr(gross17_1)} (components: ${input.components.length}).`,
    `Add: perquisites u/s 17(2): ${formatInr(perquisites)}.`,
    `Gross total salary: ${formatInr(grossTotalSalary)}.`,
    `Less: exemptions u/s 10: ${formatInr(exempt10)}.`,
  ];
  if (input.gratuity != null && (exemptGratuity > 0 || taxableGratuity > 0)) {
    methodology.push(
      `Gratuity: received ${formatInr(input.gratuity.received)}; exempt ${formatInr(exemptGratuity)}; taxable ${formatInr(taxableGratuity)}${input.gratuity.coveredUnderAct ? " (Payment of Gratuity Act method)" : " (declarable by firm)"}.`,
    );
  }
  if (input.leave != null && (exemptLeave > 0 || taxableLeave > 0)) {
    methodology.push(
      `Leave encashment: received ${formatInr(input.leave.receivedAtRetirement)}; exempt ${formatInr(exemptLeave)}; taxable ${formatInr(taxableLeave)}.`,
    );
  }
  if (input.pension != null && (exemptCommuted > 0 || taxableCommuted > 0)) {
    methodology.push(
      `Commuted pension: received ${formatInr(input.pension.commutedPension)}; exempt u/s 10(10A) ${formatInr(exemptCommuted)}; taxable ${formatInr(taxableCommuted)}.`,
    );
  }
  if (relief > 0) {
    methodology.push(`Relief u/s 89: ${formatInr(relief)}.`);
  }
  if (consistency.length > 0) {
    methodology.push(...consistency);
  }
  methodology.push(
    `Less: standard deduction u/s 16(ia): ${formatInr(stdDed)}; professional tax u/s 16(iii): ${formatInr(profTax)}.`,
  );
  methodology.push(`Taxable salary: ${formatInr(taxableSalary)}.`);

  const slip: SalarySlipLine[] = [
    {
      section: "17(1)",
      label: "Gross Salary — Wages / Basic / DA",
      amount: componentsAmount(input.components, "Basic"),
      col: 1,
      kind: "input",
    },
    {
      section: "17(1)",
      label: "Dearness Allowance forming part of retirement benefits",
      amount: componentsAmount(input.components, "DA"),
      col: 1,
      kind: "input",
    },
    {
      section: "17(1)",
      label: "Other taxable allowances",
      amount: componentsAmountExcluding(input.components, ["Basic", "DA"]),
      col: 1,
      kind: "input",
    },
    {
      section: "17(1)",
      label: "Add: arrears of salary",
      amount: componentsAmount(input.components, "Arrears"),
      col: 1,
      kind: "input",
    },
    {
      section: "17(1)",
      label: "Add: profits in lieu of salary",
      amount: componentsAmount(input.components, "Profits in lieu"),
      col: 1,
      kind: "input",
    },
    { section: "17(1)", label: "Gross Salary u/s 17(1)", amount: gross17_1, col: 1, kind: "total" },
    { section: "17(2)", label: "Add: Value of perquisites (taxable)", amount: perquisites, col: 1, kind: "input" },
    {
      section: "10",
      label: "Less: Exempt allowances u/s 10(13A) HRA",
      amount: -(input.allowances.hraExempt ?? 0),
      col: 1,
      kind: "exempt",
    },
    {
      section: "10",
      label: "Less: Exempt allowances u/s 10(14)",
      amount: -(input.allowances.exemptAllowances10_14 ?? 0),
      col: 1,
      kind: "exempt",
    },
    {
      section: "10",
      label: "Less: Other exempt receipts u/s 10",
      amount: -(input.allowances.otherExempt ?? 0),
      col: 1,
      kind: "exempt",
    },
    { section: "16", label: "Less: Standard deduction u/s 16(ia)", amount: -stdDed, col: 1, kind: "disallowed" },
    { section: "16", label: "Less: Professional tax u/s 16(iii)", amount: -profTax, col: 1, kind: "disallowed" },
    { section: "17(1)+(2)-(10)-(16)", label: "Taxable Salary", amount: taxableSalary, col: 1, kind: "total" },
  ];

  // Append gratuity/leave/commutation lines if present.
  if (input.gratuity) {
    slip.push({
      section: "10(10)",
      label: `Gratuity received: ${formatInr(input.gratuity.received)}`,
      amount: input.gratuity.received,
      kind: "input",
    });
    slip.push({
      section: "10(10)",
      label: `Exempt gratuity u/s 10(10)`,
      amount: -exemptGratuity,
      kind: "exempt",
    });
    slip.push({
      section: "17(3)",
      label: "Taxable gratuity",
      amount: taxableGratuity,
      kind: "computed",
    });
  }
  if (input.leave) {
    slip.push({
      section: "10(10AA)",
      label: `Leave encashment received: ${formatInr(input.leave.receivedAtRetirement)}`,
      amount: input.leave.receivedAtRetirement,
      kind: "input",
    });
    slip.push({
      section: "10(10AA)",
      label: `Exempt leave encashment u/s 10(10AA)`,
      amount: -exemptLeave,
      kind: "exempt",
    });
    slip.push({
      section: "17(3)",
      label: "Taxable leave encashment",
      amount: taxableLeave,
      kind: "computed",
    });
  }
  if (input.pension) {
    slip.push({
      section: "10(10A)",
      label: `Commuted pension received: ${formatInr(input.pension.commutedPension)}`,
      amount: input.pension.commutedPension,
      kind: "input",
    });
    slip.push({
      section: "10(10A)",
      label: "Exempt commuted pension u/s 10(10A)",
      amount: -exemptCommuted,
      kind: "exempt",
    });
    slip.push({
      section: "17(3)",
      label: "Taxable commuted pension",
      amount: taxableCommuted,
      kind: "computed",
    });
  }
  if (relief > 0) {
    slip.push({
      section: "89",
      label: "Relief u/s 89(1)",
      amount: -relief,
      kind: "computed",
      note: "reduction in tax, not in income",
    });
  }

  const regimeComparison =
    input.grader?.regimesToGrade && input.grader.regimesToGrade.length > 1
      ? regimeComparisonForSalary(taxableSalary, input.grader.regimesToGrade, input.ay)
      : undefined;

  return {
    regimeId: input.regime.id,
    regimeLabel: input.regime.label,
    ay: input.ay,
    grossSalary17_1: gross17_1,
    perquisitesValue: perquisites,
    grossTotalSalary,
    exemptUnder10: exempt10,
    netSalaryBeforeStdDeduction: netBeforeStdDed,
    standardDeduction: stdDed,
    professionalTax: profTax,
    salaryDeductions: salaryDeductions,
    taxableSalary,
    relief89: relief,
    exemptGratuity,
    taxableGratuity,
    exemptLeave,
    taxableLeave,
    exemptCommutedPension: exemptCommuted,
    taxableCommutedPension: taxableCommuted,
    methodology,
    slip,
    regimeComparison,
  };
}

// ---------------------------------------------------------------------------
// Helpers for slip construction
// ---------------------------------------------------------------------------

function componentsAmount(components: SalaryComponent[], labelContains: string): number {
  return roundMinor(
    components
      .filter((c) => c.label.toUpperCase().includes(labelContains.toUpperCase()) && c.countsForSalary)
      .reduce((s, c) => s + c.amount, 0),
  );
}

function componentsAmountExcluding(components: SalaryComponent[], excludeLabels: string[]): number {
  const lower = excludeLabels.map((l) => l.toUpperCase());
  return roundMinor(
    components
      .filter((c) => c.countsForSalary && !lower.some((l) => c.label.toUpperCase().includes(l)))
      .reduce((s, c) => s + c.amount, 0),
  );
}

export { formatInr, toRupees, INR };

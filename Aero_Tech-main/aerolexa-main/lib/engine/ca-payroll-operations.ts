/**
 * Payroll practice operations — the employee-master + monthly-run +
 * statutory-filing + reconciliation system a payroll practice runs, on top of
 * the compute engines (`payroll.ts` produces a payslip, `payroll-practice.ts`
 * holds the master/run shape, `professional-tax.ts` computes state PT).
 *
 * This module closes the operating gaps:
 *   1. Employee master lifecycle — joins, exits, PF/ECS mapping, UAN/ESIC/
 *      Aadhaar/PAN/bank details, leave, overtime, bonus, gratuity accrual,
 *      leave encashment, tax & investment declarations, proof collection.
 *   2. Monthly payroll run workflow — input validation, arrears, correction
 *      runs, advance recovery, disbursement file and payslip issuance.
 *   3. PF/ESI/PT compliance — ECR preparation, contribution matching, EPS/EDLI
 *      split, monthly/annual returns, inspection readiness.
 *   4. Labour-law registers and returns chosen by establishment size and state.
 *   5. Payroll-to-books and payroll-to-TDS/PF/ESI reconciliation.
 *
 * SCOPE AND HONESTY: arithmetic and workflow on caller-supplied figures. Rates,
 * ceilings and state rules are DATA the caller supplies from the current
 * notification; the module does not file returns and does not substitute for
 * the EPFO/ESIC/state portals or legal advice.
 *
 * Money is in MINOR UNITS (paise) as integers.
 */

export class PayrollOperationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollOperationsError";
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

// ===========================================================================
// 1. Employee master lifecycle
// ===========================================================================

export type EmploymentStatus = "active" | "resigned" | "terminated" | "retired" | "absconding";

export interface BankDetails {
  accountNumber: string;
  ifsc: string;
  accountHolder: string;
}

export interface EmployeeProfile {
  employeeId: string;
  name: string;
  status: EmploymentStatus;
  dateOfJoining: string;
  dateOfExit?: string | null;
  /** 12-digit Universal Account Number. */
  uan?: string | null;
  /** ESIC insurance number. */
  esicNumber?: string | null;
  aadhaarLinked: boolean;
  pan?: string | null;
  bank?: BankDetails | null;
  /** PF establishment / ECS mapping reference. */
  pfEcsMapping?: string | null;
  department: string;
  designation: string;
  state: string;
  establishmentEmployeeCount: number;
  grossMonthlyMinor: number;
  basicMonthlyMinor: number;
}

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Validate the employee master before it drives payroll or statutory filings. */
export function validateEmployeeProfile(profile: EmployeeProfile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!profile.employeeId.trim()) errors.push("Employee id is required.");
  if (!profile.name.trim()) errors.push("Employee name is required.");
  if (profile.uan && !/^[0-9]{12}$/.test(profile.uan)) errors.push(`UAN for ${profile.name} must be 12 digits.`);
  if (profile.pan && !PAN_PATTERN.test(profile.pan)) errors.push(`PAN for ${profile.name} is invalid.`);
  if (!profile.bank || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(profile.bank.ifsc)) {
    errors.push(`A valid IFSC is required to disburse salary to ${profile.name}.`);
  }
  if (profile.status !== "active" && !profile.dateOfExit) {
    errors.push(`An exit date is required for a ${profile.status} employee.`);
  }
  if (profile.dateOfExit && daysBetween(profile.dateOfJoining, profile.dateOfExit) < 0) {
    errors.push(`Exit date for ${profile.name} cannot precede the joining date.`);
  }
  if (profile.grossMonthlyMinor <= 0 || profile.basicMonthlyMinor <= 0) {
    errors.push(`Gross and basic monthly wage must be positive for ${profile.name}.`);
  }
  if (profile.basicMonthlyMinor > profile.grossMonthlyMinor) {
    errors.push(`Basic wage cannot exceed gross wage for ${profile.name}.`);
  }
  return { valid: errors.length === 0, errors };
}

/** Completed service in years (used for gratuity and bonus eligibility). */
export function completedServiceYears(profile: EmployeeProfile, asOf: string): number {
  const end = profile.dateOfExit ?? asOf;
  const days = daysBetween(profile.dateOfJoining, end);
  return Math.max(0, Math.floor(days / 365));
}

/**
 * Gratuity accrual under the Payment of Gratuity Act: 15/26 of last drawn
 * monthly wage per completed year of service. Payable only after five years
 * (four years + 240 days is treated as five for continuous service).
 */
export function gratuityAccrual(
  profile: EmployeeProfile,
  lastDrawnMonthlyMinor: number,
  asOf: string,
): { completedYears: number; accruedMinor: number; payable: boolean; note: string } {
  const days = daysBetween(profile.dateOfJoining, profile.dateOfExit ?? asOf);
  const completedYears = completedServiceYears(profile, asOf);
  const eligible = completedYears >= 5 || days >= 4 * 365 + 240;
  const accruedMinor = Math.round((lastDrawnMonthlyMinor * 15 * completedYears) / 26);
  return {
    completedYears,
    accruedMinor: eligible ? accruedMinor : 0,
    payable: eligible,
    note: eligible
      ? `Gratuity accrual: 15/26 × ${lastDrawnMonthlyMinor} × ${completedYears} completed year(s).`
      : `Not yet eligible for gratuity (${completedYears} completed year(s); five years required).`,
  };
}

/** Leave encashment on a per-day wage. */
export function leaveEncashment(leaveBalanceDays: number, dailyWageMinor: number): number {
  if (leaveBalanceDays < 0) throw new PayrollOperationsError("Leave balance cannot be negative.");
  return Math.round(leaveBalanceDays * dailyWageMinor);
}

export interface BonusEligibility {
  eligible: boolean;
  minimumBonusMinor: number;
  maximumBonusMinor: number;
  note: string;
}

/**
 * Statutory bonus eligibility (Payment of Bonus Act): employees drawing wages
 * up to the eligibility ceiling are entitled to a minimum 8.33% and a maximum
 * 20% of the eligible wage.
 */
export function bonusEligibility(input: {
  grossMonthlyMinor: number;
  eligibilityCeilingMinor: number;
  monthsWorked: number;
}): BonusEligibility {
  if (input.grossMonthlyMinor > input.eligibilityCeilingMinor) {
    return {
      eligible: false,
      minimumBonusMinor: 0,
      maximumBonusMinor: 0,
      note: "Wage exceeds the bonus eligibility ceiling.",
    };
  }
  const eligibleWage = input.grossMonthlyMinor;
  return {
    eligible: true,
    minimumBonusMinor: Math.round(eligibleWage * 0.0833 * input.monthsWorked),
    maximumBonusMinor: Math.round(eligibleWage * 0.2 * input.monthsWorked),
    note: `Bonus eligible: 8.33%–20% of ${eligibleWage} for ${input.monthsWorked} month(s) worked.`,
  };
}

export type TaxRegime = "old" | "new";

export interface InvestmentDeclaration {
  employeeId: string;
  financialYear: string;
  regime: TaxRegime;
  section80C: number;
  section80CCD1B: number;
  section80D: number;
  section80TTA: number;
  houseRentPaidAnnual: number;
  homeLoanInterestAnnual: number;
  /** Whether the employee confirmed these for the year. */
  declaredAt: string;
}

export interface ProofCollection {
  section: string;
  requiredMinor: number;
  collectedMinor: number;
  status: "pending" | "partial" | "collected";
}

/** Summarise the investment declaration and its proof-collection status. */
export function investmentProofStatus(declaration: InvestmentDeclaration): {
  totalChapterVIA: number;
  proofs: ProofCollection[];
  proofsComplete: boolean;
} {
  const items: { section: string; amount: number }[] = [
    { section: "80C", amount: declaration.section80C },
    { section: "80CCD(1B)", amount: declaration.section80CCD1B },
    { section: "80D", amount: declaration.section80D },
    { section: "80TTA", amount: declaration.section80TTA },
  ];
  const totalChapterVIA = items.reduce((s, i) => s + i.amount, 0);
  const proofs: ProofCollection[] = items.map((i) => ({
    section: i.section,
    requiredMinor: i.amount,
    collectedMinor: 0,
    status: i.amount === 0 ? "collected" : "pending",
  }));
  return { totalChapterVIA, proofs, proofsComplete: proofs.every((p) => p.status === "collected") };
}

/** Record proof received against a declaration line. */
export function recordProof(proofs: ProofCollection[], section: string, receivedMinor: number): ProofCollection[] {
  return proofs.map((p) => {
    if (p.section !== section) return p;
    const collectedMinor = Math.min(p.requiredMinor, p.collectedMinor + Math.max(0, receivedMinor));
    const status: ProofCollection["status"] =
      collectedMinor <= 0 ? "pending" : collectedMinor >= p.requiredMinor ? "collected" : "partial";
    return { ...p, collectedMinor, status };
  });
}

// ===========================================================================
// 2. Monthly payroll run workflow
// ===========================================================================

export interface MonthlyInputLine {
  employeeId: string;
  paidDays: number;
  lopDays: number;
  overtimeHours: number;
  overtimeRatePerHourMinor: number;
  bonusMinor: number;
  arrearMinor: number;
  /** Advance recovered this month. */
  advanceRecoveryMinor: number;
  /** Advance outstanding before this run. */
  advanceOutstandingMinor: number;
}

export interface RunValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a month's inputs against the employee master (SA/control checks). */
export function validateMonthlyInputs(lines: MonthlyInputLine[], employees: EmployeeProfile[]): RunValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(employees.map((e) => [e.employeeId, e]));

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.employeeId)) errors.push(`Duplicate payroll line for ${line.employeeId}.`);
    seen.add(line.employeeId);

    const employee = byId.get(line.employeeId);
    if (!employee) {
      warnings.push(`Payroll line for unknown employee ${line.employeeId}; add the master record first.`);
      continue;
    }
    if (line.paidDays < 0 || line.lopDays < 0) errors.push(`Negative days for ${line.employeeId}.`);
    if (line.paidDays + line.lopDays > 31) errors.push(`Paid + LOP days exceed 31 for ${line.employeeId}.`);
    if (line.overtimeHours < 0) errors.push(`Negative overtime for ${line.employeeId}.`);
    if (line.advanceRecoveryMinor > line.advanceOutstandingMinor) {
      errors.push(`Advance recovery exceeds the outstanding balance for ${line.employeeId}.`);
    }
  }

  for (const employee of employees) {
    if (employee.status === "active" && !seen.has(employee.employeeId)) {
      warnings.push(`Active employee ${employee.employeeId} has no payroll line this run.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface RunLineResult {
  employeeId: string;
  overtimePayMinor: number;
  grossEarningsMinor: number;
  totalRecoveryMinor: number;
  advanceOutstandingAfterMinor: number;
  netBeforeStatutoryMinor: number;
}

/**
 * Compute the run-level earnings and recovery for a line. Statutory deductions
 * are applied by `payroll.ts`/`payroll-practice.ts`; this orchestrates the
 * overtime, arrears, bonus and advance recovery the monthly run adds on top.
 */
export function computeRunLine(line: MonthlyInputLine, monthlyGrossMinor: number): RunLineResult {
  const overtimePayMinor = Math.round(line.overtimeHours * line.overtimeRatePerHourMinor);
  const grossEarningsMinor = monthlyGrossMinor + overtimePayMinor + line.bonusMinor + line.arrearMinor;
  const advanceOutstandingAfterMinor = Math.max(0, line.advanceOutstandingMinor - line.advanceRecoveryMinor);
  return {
    employeeId: line.employeeId,
    overtimePayMinor,
    grossEarningsMinor,
    totalRecoveryMinor: line.advanceRecoveryMinor,
    advanceOutstandingAfterMinor,
    netBeforeStatutoryMinor: grossEarningsMinor - line.advanceRecoveryMinor,
  };
}

export interface CorrectionRun {
  originalPeriod: string;
  correctionPeriod: string;
  corrections: { employeeId: string; differenceMinor: number; reason: string }[];
  totalDifferenceMinor: number;
}

/** Build a correction run that adjusts a prior period without re-running it. */
export function buildCorrectionRun(input: {
  originalPeriod: string;
  correctionPeriod: string;
  corrections: { employeeId: string; differenceMinor: number; reason: string }[];
}): CorrectionRun {
  const totalDifferenceMinor = input.corrections.reduce((s, c) => s + c.differenceMinor, 0);
  return { ...input, totalDifferenceMinor };
}

export interface DisbursementLine {
  employeeId: string;
  accountNumber: string;
  ifsc: string;
  accountHolder: string;
  netPayMinor: number;
}

/** Build the bank disbursement advice (bank advice file rows). */
export function buildDisbursementFile(
  netPay: { employeeId: string; netPayMinor: number }[],
  employees: EmployeeProfile[],
): { lines: DisbursementLine[]; totalMinor: number; unpayable: string[] } {
  const byId = new Map(employees.map((e) => [e.employeeId, e]));
  const lines: DisbursementLine[] = [];
  const unpayable: string[] = [];
  let totalMinor = 0;

  for (const pay of netPay) {
    const employee = byId.get(pay.employeeId);
    if (!employee || !employee.bank) {
      unpayable.push(pay.employeeId);
      continue;
    }
    lines.push({
      employeeId: pay.employeeId,
      accountNumber: employee.bank.accountNumber,
      ifsc: employee.bank.ifsc,
      accountHolder: employee.bank.accountHolder,
      netPayMinor: pay.netPayMinor,
    });
    totalMinor += pay.netPayMinor;
  }
  return { lines, totalMinor, unpayable };
}

/** Track payslip issuance for a run (issued / pending / failed). */
export function payslipIssuanceStatus(
  employees: EmployeeProfile[],
  issued: string[],
): { issued: string[]; pending: string[]; completionPct: number } {
  const issuedSet = new Set(issued);
  const active = employees.filter((e) => e.status === "active");
  const pending = active.filter((e) => !issuedSet.has(e.employeeId)).map((e) => e.employeeId);
  const done = active.filter((e) => issuedSet.has(e.employeeId)).map((e) => e.employeeId);
  const completionPct = active.length === 0 ? 100 : Math.round((done.length / active.length) * 100);
  return { issued: done, pending, completionPct };
}

// ===========================================================================
// 3. PF / ESI / PT compliance
// ===========================================================================

export interface PfConfig {
  /** Statutory wage ceiling for PF membership. */
  wageCeilingMinor: number;
  employeeRatePct: number;
  employerRatePct: number;
  /** Share of the employer contribution diverted to EPS (8.33%). */
  epsRatePct: number;
  edliRatePct: number;
  edliWageCeilingMinor: number;
}

export const PF_DEFAULTS: PfConfig = {
  wageCeilingMinor: 15_000 * 100,
  employeeRatePct: 12,
  employerRatePct: 12,
  epsRatePct: 8.33,
  edliRatePct: 0.5,
  edliWageCeilingMinor: 15_000 * 100,
};

export interface EcrLine {
  uan: string;
  name: string;
  grossWagesMinor: number;
  epfWagesMinor: number;
  epsWagesMinor: number;
  edliWagesMinor: number;
  employeeContributionMinor: number;
  employerContributionMinor: number;
  ncpDays: number;
}

export interface EcrResult {
  lines: EcrLine[];
  totals: {
    epfWagesMinor: number;
    employeeContributionMinor: number;
    employerContributionMinor: number;
    epsContributionMinor: number;
    edliContributionMinor: number;
  };
  errors: string[];
}

/**
 * Prepare ECR lines: PF wages are capped at the statutory ceiling for
 * contribution and EPS, with EDLI on the EDLI ceiling. A missing UAN or a
 * non-compliant wage gap is reported rather than silently filed.
 */
export function prepareEcr(
  employees: {
    uan: string | null;
    name: string;
    grossWagesMinor: number;
    pfWagesMinor: number;
    ncpDays: number;
  }[],
  config: PfConfig = PF_DEFAULTS,
): EcrResult {
  const lines: EcrLine[] = [];
  const errors: string[] = [];
  const totals = {
    epfWagesMinor: 0,
    employeeContributionMinor: 0,
    employerContributionMinor: 0,
    epsContributionMinor: 0,
    edliContributionMinor: 0,
  };

  for (const e of employees) {
    if (!e.uan) {
      errors.push(`${e.name} has no UAN; the ECR cannot include this member.`);
      continue;
    }
    const epfWagesMinor = Math.min(e.pfWagesMinor, config.wageCeilingMinor);
    const epsWagesMinor = Math.min(e.pfWagesMinor, config.wageCeilingMinor);
    const edliWagesMinor = Math.min(e.pfWagesMinor, config.edliWageCeilingMinor);
    const employeeContributionMinor = Math.round((epfWagesMinor * config.employeeRatePct) / 100);
    const employerContributionMinor = Math.round((epfWagesMinor * config.employerRatePct) / 100);
    const epsContributionMinor = Math.min(
      employerContributionMinor,
      Math.round((epsWagesMinor * config.epsRatePct) / 100),
    );
    const edliContributionMinor = Math.round((edliWagesMinor * config.edliRatePct) / 100);

    lines.push({
      uan: e.uan,
      name: e.name,
      grossWagesMinor: e.grossWagesMinor,
      epfWagesMinor,
      epsWagesMinor,
      edliWagesMinor,
      employeeContributionMinor,
      employerContributionMinor,
      ncpDays: e.ncpDays,
    });
    totals.epfWagesMinor += epfWagesMinor;
    totals.employeeContributionMinor += employeeContributionMinor;
    totals.employerContributionMinor += employerContributionMinor;
    totals.epsContributionMinor += epsContributionMinor;
    totals.edliContributionMinor += edliContributionMinor;
  }

  return { lines, totals, errors };
}

/** Match the PF contribution remitted against the contribution computed. */
export function matchPfContribution(input: {
  remittedEmployeeMinor: number;
  remittedEmployerMinor: number;
  computedEmployeeMinor: number;
  computedEmployerMinor: number;
}): { employeeDifferenceMinor: number; employerDifferenceMinor: number; matched: boolean; note: string } {
  const employeeDifferenceMinor = input.remittedEmployeeMinor - input.computedEmployeeMinor;
  const employerDifferenceMinor = input.remittedEmployerMinor - input.computedEmployerMinor;
  const matched = employeeDifferenceMinor === 0 && employerDifferenceMinor === 0;
  return {
    employeeDifferenceMinor,
    employerDifferenceMinor,
    matched,
    note: matched
      ? "PF remittance matches the computed contribution."
      : `PF mismatch: employee ${employeeDifferenceMinor}, employer ${employerDifferenceMinor}; investigate before the ECR is filed.`,
  };
}

export interface PtReturn {
  stateCode: string;
  lines: { employeeId: string; ptMinor: number }[];
  totalMinor: number;
  employeeCount: number;
}

/** Assemble a state professional-tax return from per-employee PT amounts. */
export function preparePtReturn(stateCode: string, lines: { employeeId: string; ptMinor: number }[]): PtReturn {
  return {
    stateCode,
    lines,
    totalMinor: lines.reduce((s, l) => s + l.ptMinor, 0),
    employeeCount: lines.length,
  };
}

export interface EsiConfig {
  /** ESI wage ceiling (monthly gross). */
  wageCeilingMinor: number;
  employeeRatePct: number;
  employerRatePct: number;
}

export const ESI_DEFAULTS: EsiConfig = {
  wageCeilingMinor: 21_000 * 100,
  employeeRatePct: 0.75,
  employerRatePct: 3.25,
};

export interface EsiLine {
  ipNumber: string | null;
  name: string;
  grossWagesMinor: number;
  esiWagesMinor: number;
  employeeContributionMinor: number;
  employerContributionMinor: number;
  applicable: boolean;
}

export interface EsiResult {
  lines: EsiLine[];
  totals: {
    esiWagesMinor: number;
    employeeContributionMinor: number;
    employerContributionMinor: number;
    insuredPersons: number;
  };
  errors: string[];
}

/**
 * Prepare the ESI monthly contribution return. ESI applies while monthly gross
 * wages are within the ceiling; contributions are rounded up to the next rupee,
 * as the ESI Regulations prescribe. A covered employee with no IP number is
 * reported rather than silently filed.
 */
export function prepareEsiReturn(
  employees: { esicNumber: string | null; name: string; grossWagesMinor: number }[],
  config: EsiConfig = ESI_DEFAULTS,
): EsiResult {
  const lines: EsiLine[] = [];
  const errors: string[] = [];
  const totals = { esiWagesMinor: 0, employeeContributionMinor: 0, employerContributionMinor: 0, insuredPersons: 0 };

  for (const e of employees) {
    const applicable = e.grossWagesMinor <= config.wageCeilingMinor;
    if (!applicable) {
      lines.push({
        ipNumber: e.esicNumber,
        name: e.name,
        grossWagesMinor: e.grossWagesMinor,
        esiWagesMinor: 0,
        employeeContributionMinor: 0,
        employerContributionMinor: 0,
        applicable: false,
      });
      continue;
    }
    if (!e.esicNumber) {
      errors.push(`${e.name} is within the ESI ceiling but has no IP number; the return cannot include them.`);
      continue;
    }
    const esiWagesMinor = e.grossWagesMinor;
    const employeeContributionMinor = Math.ceil((esiWagesMinor * config.employeeRatePct) / 100);
    const employerContributionMinor = Math.ceil((esiWagesMinor * config.employerRatePct) / 100);
    lines.push({
      ipNumber: e.esicNumber,
      name: e.name,
      grossWagesMinor: e.grossWagesMinor,
      esiWagesMinor,
      employeeContributionMinor,
      employerContributionMinor,
      applicable: true,
    });
    totals.esiWagesMinor += esiWagesMinor;
    totals.employeeContributionMinor += employeeContributionMinor;
    totals.employerContributionMinor += employerContributionMinor;
    totals.insuredPersons += 1;
  }

  return { lines, totals, errors };
}

export interface InspectionChecklistItem {
  document: string;
  available: boolean;
  mandatory: boolean;
}

export interface InspectionReadiness {
  ready: boolean;
  missingMandatory: string[];
  score: number;
}

/** Assess readiness for an EPFO/ESIC/labour inspection. */
export function inspectionReadiness(items: InspectionChecklistItem[]): InspectionReadiness {
  const mandatory = items.filter((i) => i.mandatory);
  const missingMandatory = mandatory.filter((i) => !i.available).map((i) => i.document);
  const available = items.filter((i) => i.available).length;
  return {
    ready: missingMandatory.length === 0,
    missingMandatory,
    score: items.length === 0 ? 100 : Math.round((available / items.length) * 100),
  };
}

// ===========================================================================
// 4. Labour-law registers & returns by size and state
// ===========================================================================

export interface EstablishmentProfile {
  state: string;
  employeeCount: number;
  employsContractLabour: boolean;
  employsWomen: boolean;
  hasOvertime: boolean;
  isShopsEstablishment: boolean;
}

export interface RegisterRequirement {
  register: string;
  authority: string;
  retentionYears: number;
  reason: string;
}

/** The registers an establishment must maintain, driven by size and activity. */
export function requiredRegisters(profile: EstablishmentProfile): RegisterRequirement[] {
  const registers: RegisterRequirement[] = [
    {
      register: "Wage register",
      authority: "Payment of Wages Act",
      retentionYears: 3,
      reason: "All establishments paying wages.",
    },
    {
      register: "Attendance / muster roll",
      authority: "State Shops & Establishments / Factories Act",
      retentionYears: 3,
      reason: "All establishments.",
    },
    {
      register: "Leave register",
      authority: "State Shops & Establishments Act",
      retentionYears: 3,
      reason: "All establishments.",
    },
  ];
  if (profile.hasOvertime) {
    registers.push({
      register: "Overtime register",
      authority: "Factories Act / Shops & Establishments Act",
      retentionYears: 3,
      reason: "Overtime is worked.",
    });
  }
  if (profile.employsWomen) {
    registers.push({
      register: "Maternity benefit register",
      authority: "Maternity Benefit Act",
      retentionYears: 3,
      reason: "Women employees employed.",
    });
  }
  if (profile.employsContractLabour) {
    registers.push({
      register: "Contract labour register",
      authority: "Contract Labour (R&A) Act",
      retentionYears: 3,
      reason: "Contract labour engaged.",
    });
  }
  if (profile.isShopsEstablishment) {
    registers.push({
      register: "Shops & Establishments register",
      authority: `${profile.state} Shops & Establishments Act`,
      retentionYears: 3,
      reason: "Registered as a shop/establishment.",
    });
  }
  if (profile.employeeCount >= 20) {
    registers.push({
      register: "PF & ESI registers",
      authority: "EPF & MP Act / ESI Act",
      retentionYears: 5,
      reason: "Establishment has 20 or more employees.",
    });
  }
  return registers;
}

export interface LabourReturn {
  returnName: string;
  frequency: "monthly" | "quarterly" | "annual" | "event";
  dueRule: string;
  authority: string;
}

/** The statutory returns for the establishment. */
export function requiredLabourReturns(profile: EstablishmentProfile): LabourReturn[] {
  const returns: LabourReturn[] = [
    {
      returnName: "Shops & Establishments annual return",
      frequency: "annual",
      dueRule: "As prescribed by the state (e.g. 31 January / 31 March).",
      authority: `${profile.state} Labour Department`,
    },
    {
      returnName: "Minimum wages compliance statement",
      frequency: "annual",
      dueRule: "Annually, or as required by the state.",
      authority: "State Labour Department",
    },
  ];
  if (profile.employeeCount >= 20) {
    returns.push({
      returnName: "PF ECR",
      frequency: "monthly",
      dueRule: "By the 15th of the following month.",
      authority: "EPFO",
    });
    returns.push({
      returnName: "ESI contribution return",
      frequency: "monthly",
      dueRule: "By the 15th of the following month.",
      authority: "ESIC",
    });
  }
  if (profile.employsContractLabour) {
    returns.push({
      returnName: "Contract labour (R&A) annual return",
      frequency: "annual",
      dueRule: "Within 30 days of the compliance year end.",
      authority: "Labour Commissioner",
    });
  }
  return returns;
}

export interface WageComplianceLine {
  employeeId: string;
  paidMonthlyMinor: number;
  applicableMinimumMinor: number;
  shortfallMinor: number;
  compliant: boolean;
}

/**
 * Test each employee's wage against the minimum wage that applies to their
 * category/state (the caller supplies the applicable floor, since it varies by
 * state, scheduled employment and skill). A shortfall is a compliance exposure,
 * not a rounding difference.
 */
export function minimumWageCompliance(
  lines: { employeeId: string; paidMonthlyMinor: number; applicableMinimumMinor: number }[],
): { lines: WageComplianceLine[]; compliant: boolean; shortfalls: string[]; totalShortfallMinor: number } {
  const enriched: WageComplianceLine[] = lines.map((l) => {
    const shortfallMinor = Math.max(0, l.applicableMinimumMinor - l.paidMonthlyMinor);
    return { ...l, shortfallMinor, compliant: shortfallMinor === 0 };
  });
  const shortfalls = enriched.filter((l) => !l.compliant).map((l) => l.employeeId);
  return {
    lines: enriched,
    compliant: shortfalls.length === 0,
    shortfalls,
    totalShortfallMinor: enriched.reduce((s, l) => s + l.shortfallMinor, 0),
  };
}

// ===========================================================================
// 5. Reconciliation
// ===========================================================================

export interface PayrollBooksReconciliation {
  payrollNetMinor: number;
  booksNetMinor: number;
  differenceMinor: number;
  reconciled: boolean;
  note: string;
}

/**
 * Reconcile the run's net pay to the salary control account at the totals
 * level. (The run-level, per-category reconciliation lives in
 * `payroll-practice.ts` as `reconcilePayrollToBooks`.)
 */
export function reconcilePayrollTotalsToBooks(input: {
  payrollNetMinor: number;
  booksNetMinor: number;
}): PayrollBooksReconciliation {
  const differenceMinor = input.payrollNetMinor - input.booksNetMinor;
  return {
    payrollNetMinor: input.payrollNetMinor,
    booksNetMinor: input.booksNetMinor,
    differenceMinor,
    reconciled: differenceMinor === 0,
    note:
      differenceMinor === 0
        ? "Payroll net pay agrees with the salary control account."
        : `Payroll-to-books difference of ${differenceMinor}; post the reconciling journal.`,
  };
}

export interface PayrollTdsReconciliation {
  deductedMinor: number;
  depositedMinor: number;
  differenceMinor: number;
  reconciled: boolean;
  note: string;
}

/** Reconcile salary TDS deducted in the run to the amount deposited (Form 24Q/26Q style). */
export function reconcilePayrollToTds(input: {
  deductedMinor: number;
  depositedMinor: number;
}): PayrollTdsReconciliation {
  const differenceMinor = input.deductedMinor - input.depositedMinor;
  return {
    deductedMinor: input.deductedMinor,
    depositedMinor: input.depositedMinor,
    differenceMinor,
    reconciled: differenceMinor === 0,
    note:
      differenceMinor === 0
        ? "Salary TDS deducted agrees with the amount deposited."
        : `Salary TDS difference of ${differenceMinor}; trace to the challan before filing 24Q.`,
  };
}

export interface StatutoryReconciliation {
  component: "pf" | "esi" | "pt";
  computedMinor: number;
  remittedMinor: number;
  differenceMinor: number;
  reconciled: boolean;
}

/** Reconcile each statutory component computed to what was remitted. */
export function reconcileStatutoryComponents(
  components: { component: "pf" | "esi" | "pt"; computedMinor: number; remittedMinor: number }[],
): { items: StatutoryReconciliation[]; allReconciled: boolean } {
  const items = components.map((c) => ({
    ...c,
    differenceMinor: c.computedMinor - c.remittedMinor,
    reconciled: c.computedMinor === c.remittedMinor,
  }));
  return { items, allReconciled: items.every((i) => i.reconciled) };
}

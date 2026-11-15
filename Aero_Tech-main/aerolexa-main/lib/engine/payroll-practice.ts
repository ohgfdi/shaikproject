/**
 * Advanced Payroll Practice Engine - India-specific comprehensive payroll management
 *
 * Extends the core payroll computation with practice-level features a CA firm needs:
 * - Employee master lifecycle (joins/exits, leave, overtime, bonuses, gratuity accrual)
 * - Monthly payroll run workflow with validation, corrections, arrears
 * - PF/ESI/PT compliance: ECR preparation, returns, contribution matching
 * - Labour law compliance (registers, returns by establishment size/state)
 * - Payroll-to-books and payroll-to-TDS/PF/ESI reconciliation
 */

import { INR } from "./india-tax";
import { NEW_REGIME_2025_26 } from "./india-tax";
import type { TaxRegime } from "./india-tax";
import { payrollRegister, type EmployeeWages, type PayrollRegister } from "./payroll";

export class PayrollPracticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollPracticeError";
  }
}

// Employee Master Types
export interface EmployeeMaster {
  employeeId: string;
  name: string;
  gender: "M" | "F" | "O";
  dateOfBirth: string; // YYYY-MM-DD
  dateOfJoining: string; // YYYY-MM-DD
  dateOfExit?: string; // YYYY-MM-DD
  status: "active" | "resigned" | "terminated" | "retired" | "onLeave";
  employmentType: "permanent" | "temporary" | "contract" | "probation" | "trainee";
  designation: string;
  department: string;
  location: string;
  pan: string;
  aadhaar?: string;
  uan?: string;
  pfMember: boolean;
  esiMember: boolean;
  ptApplicable: boolean;
  maritalStatus: "single" | "married" | "divorced" | "widowed";
  // Bank details
  bankName: string;
  bankAccountNumber: string;
  ifscCode: string;
  // Salary structure
  basic: number;
  dearnessAllowance: number;
  hra: number;
  conveyanceAllowance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherAllowances: number;
  // Benefits
  leaveBalance: number;
  leavesTakenThisMonth: number;
  overtimeHours: number;
  overtimeRate: number; // per hour in minor units
  // Deductions/Advances
  advanceBalance: number;
  loanBalance: number;
  // Tax declarations
  taxRegime: TaxRegime;
  investmentDeclaration?: Record<string, number>;
  proofSubmitted: boolean;
}

export interface PayrollRunEntry extends EmployeeWages {
  employeeMaster: EmployeeMaster;
  leavesTaken: number;
  overtimeHours: number;
  overtimeAmount: number;
  bonusAmount: number;
  arrearAmount: number;
  advanceRecovery: number;
  loanRecovery: number;
  otherEarnings: number;
  otherDeductions: number;
  gratuityAccrued: number;
}

export interface PayrollRun {
  runId: string;
  month: string; // YYYY-MM
  financialYear: string;
  organizationId: string;
  engagementId?: string;
  projectId?: string;
  status: "draft" | "validated" | "approved" | "disbursed" | "cancelled" | "correction";
  runType: "regular" | "correction" | "finalSettlement" | "bonusRun" | "arrearRun";
  parentRunId?: string;
  employees: PayrollRunEntry[];
  register: PayrollRegister;
  validationErrors: string[];
  validationWarnings: string[];
  approvedBy?: string;
  approvedAt?: Date;
  disbursedAt?: Date;
  disbursementRef?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PFComplianceData {
  month: string;
  establishmentCode: string;
  pfCode: string;
  totalEmployees: number;
  pfMembers: number;
  epsMembers: number;
  totalWages: number;
  pfWages: number;
  epsWages: number;
  edliWages: number;
  pfEmployeeShare: number;
  pfEmployerShare: number;
  epsShare: number;
  edliShare: number;
  pfAdminShare: number;
  totalContribution: number;
  account1: number;
  account2: number;
  account10: number;
  account21: number;
  account22: number;
}

export interface ESIComplianceData {
  month: string;
  establishmentCode: string;
  esiCode: string;
  totalEmployees: number;
  insuredPersons: number;
  totalWages: number;
  esiWages: number;
  esiEmployeeContribution: number;
  esiEmployerContribution: number;
  totalContribution: number;
}

export interface PTComplianceData {
  month: string;
  state: string;
  returnPeriod: string;
  totalEmployees: number;
  ptDeducted: number;
  ptPaid: number;
  dueDate: string;
}

export interface PayrollReconciliationItem {
  category: "pf" | "esi" | "pt" | "tds" | "netPay" | "books";
  description: string;
  computedAmount: number;
  bookedAmount?: number;
  difference: number;
  status: "matched" | "mismatched" | "unreconciled" | "overridden";
  reference?: string;
}

export interface PayrollReconciliation {
  reconciliationId: string;
  month: string;
  payrollRunId: string;
  items: PayrollReconciliationItem[];
  overallStatus: "matched" | "partiallyMatched" | "unmatched";
  totalDifference: number;
  reconciledBy?: string;
  reconciledAt?: Date;
}

export function calculateGratuityAccrual(
  basic: number,
  da: number,
  yearsOfService: number,
  lastDrawnSalary?: number,
): number {
  const lastSalary = lastDrawnSalary || basic + da;
  if (yearsOfService < 5) return 0;
  const gratuity = (lastSalary * 15 * Math.floor(yearsOfService)) / 26;
  return Math.round(gratuity / 12); // Monthly accrual
}

export function generateECRData(payrollRun: PayrollRun): PFComplianceData {
  const register = payrollRun.register;
  let pfMembers = 0;
  let epsMembers = 0;
  let totalWages = 0;
  let pfWages = 0;
  let epsWages = 0;
  let edliWages = 0;

  for (const slip of register.payslips) {
    const entry = payrollRun.employees.find((e) => e.employeeId === slip.employeeId);
    if (entry?.employeeMaster.pfMember) {
      pfMembers++;
      epsMembers++;
      totalWages += slip.gross;
      pfWages += slip.epfWages;
      epsWages += Math.min(slip.epfWages, INR(15000));
      edliWages += slip.epfWages;
    }
  }

  return {
    month: payrollRun.month,
    establishmentCode: "DEFAULT",
    pfCode: "DEFAULT",
    totalEmployees: register.payslips.length,
    pfMembers,
    epsMembers,
    totalWages,
    pfWages,
    epsWages,
    edliWages,
    pfEmployeeShare: register.totals.epfEmployee,
    pfEmployerShare: register.totals.epfEmployer,
    epsShare: register.totals.epsEmployer,
    edliShare: register.totals.edli,
    pfAdminShare: register.totals.epfAdmin,
    totalContribution:
      register.totals.epfEmployee +
      register.totals.epfEmployer +
      register.totals.epsEmployer +
      register.totals.edli +
      register.totals.epfAdmin,
    account1: register.totals.epfEmployee + register.totals.epfEmployer,
    account2: register.totals.epfAdmin,
    account10: register.totals.epsEmployer,
    account21: register.totals.edli,
    account22: 0,
  };
}

export function generateESIData(payrollRun: PayrollRun): ESIComplianceData {
  const register = payrollRun.register;
  let insuredPersons = 0;
  let esiWages = 0;

  for (const slip of register.payslips) {
    const entry = payrollRun.employees.find((e) => e.employeeId === slip.employeeId);
    if (entry?.employeeMaster.esiMember && slip.esiApplicable) {
      insuredPersons++;
      esiWages += slip.gross;
    }
  }

  return {
    month: payrollRun.month,
    establishmentCode: "DEFAULT",
    esiCode: "DEFAULT",
    totalEmployees: register.payslips.length,
    insuredPersons,
    totalWages: register.totals.gross,
    esiWages,
    esiEmployeeContribution: register.totals.esiEmployee,
    esiEmployerContribution: register.totals.esiEmployer,
    totalContribution: register.totals.esiEmployee + register.totals.esiEmployer,
  };
}

export function reconcilePayrollToBooks(
  payrollRun: PayrollRun,
  bookedAmounts?: Partial<Record<string, number>>,
): PayrollReconciliation {
  const register = payrollRun.register;
  const items: PayrollReconciliationItem[] = [];

  // PF reconciliation
  const pfComputed =
    register.totals.epfEmployee +
    register.totals.epfEmployer +
    register.totals.epsEmployer +
    register.totals.edli +
    register.totals.epfAdmin;
  const pfBooked = bookedAmounts?.pf || 0;
  items.push({
    category: "pf",
    description: "PF Contributions (Employee + Employer + Admin + EDLI + EPS)",
    computedAmount: pfComputed,
    bookedAmount: pfBooked,
    difference: pfComputed - pfBooked,
    status: Math.abs(pfComputed - pfBooked) < 1 ? "matched" : "mismatched",
  });

  // ESI reconciliation
  const esiComputed = register.totals.esiEmployee + register.totals.esiEmployer;
  const esiBooked = bookedAmounts?.esi || 0;
  items.push({
    category: "esi",
    description: "ESI Contributions",
    computedAmount: esiComputed,
    bookedAmount: esiBooked,
    difference: esiComputed - esiBooked,
    status: Math.abs(esiComputed - esiBooked) < 1 ? "matched" : "mismatched",
  });

  // PT reconciliation
  const ptComputed = register.totals.professionalTax;
  const ptBooked = bookedAmounts?.pt || 0;
  items.push({
    category: "pt",
    description: "Professional Tax",
    computedAmount: ptComputed,
    bookedAmount: ptBooked,
    difference: ptComputed - ptBooked,
    status: Math.abs(ptComputed - ptBooked) < 1 ? "matched" : "mismatched",
  });

  // TDS reconciliation
  const tdsComputed = register.totals.tds;
  const tdsBooked = bookedAmounts?.tds || 0;
  items.push({
    category: "tds",
    description: "TDS u/s 192",
    computedAmount: tdsComputed,
    bookedAmount: tdsBooked,
    difference: tdsComputed - tdsBooked,
    status: Math.abs(tdsComputed - tdsBooked) < 1 ? "matched" : "mismatched",
  });

  // Net pay
  const netPayComputed = register.totals.netPay;
  const netPayBooked = bookedAmounts?.netPay || 0;
  items.push({
    category: "netPay",
    description: "Net Pay (Salary Payable/Bank Transfer)",
    computedAmount: netPayComputed,
    bookedAmount: netPayBooked,
    difference: netPayComputed - netPayBooked,
    status: Math.abs(netPayComputed - netPayBooked) < 1 ? "matched" : "mismatched",
  });

  const totalDifference = items.reduce((sum, item) => sum + Math.abs(item.difference), 0);
  const matchedCount = items.filter((i) => i.status === "matched").length;

  return {
    reconciliationId: `recon-${payrollRun.runId}`,
    month: payrollRun.month,
    payrollRunId: payrollRun.runId,
    items,
    overallStatus: matchedCount === items.length ? "matched" : matchedCount > 0 ? "partiallyMatched" : "unmatched",
    totalDifference,
    reconciledAt: undefined,
  };
}

export function createPayrollRun(
  month: string,
  employees: EmployeeMaster[],
  runType: PayrollRun["runType"] = "regular",
  createdBy: string,
): PayrollRun {
  const parts = month.split("-");
  const year = parts[0] ?? "2025";
  const m = parts[1] ?? "01";
  const fy = parseInt(m) > 3 ? `${year}-${parseInt(year) + 1}` : `${parseInt(year) - 1}-${year}`;

  /** Completed years of service at the payroll month, from the joining date. */
  const completedYearsAt = (joining: string, payrollMonth: string): number => {
    const j = new Date(`${joining.slice(0, 10)}T00:00:00Z`);
    const p = new Date(`${payrollMonth}-01T00:00:00Z`);
    if (Number.isNaN(j.getTime()) || Number.isNaN(p.getTime()) || p <= j) return 0;
    let years = p.getUTCFullYear() - j.getUTCFullYear();
    const beforeAnniversary =
      p.getUTCMonth() < j.getUTCMonth() || (p.getUTCMonth() === j.getUTCMonth() && p.getUTCDate() < j.getUTCDate());
    if (beforeAnniversary) years -= 1;
    return Math.max(0, years);
  };

  const entries: PayrollRunEntry[] = employees
    .filter((e) => e.status === "active")
    .map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      basic: e.basic,
      dearnessAllowance: e.dearnessAllowance,
      hra: e.hra,
      otherAllowances: e.conveyanceAllowance + e.medicalAllowance + e.specialAllowance + e.otherAllowances,
      employeeMaster: e,
      leavesTaken: e.leavesTakenThisMonth,
      overtimeHours: e.overtimeHours,
      overtimeAmount: Math.round(e.overtimeHours * e.overtimeRate),
      bonusAmount: 0,
      arrearAmount: 0,
      advanceRecovery: Math.min(e.advanceBalance, e.advanceBalance > 0 ? Math.round(e.basic * 0.25) : 0),
      loanRecovery: Math.min(e.loanBalance, 0),
      otherEarnings: 0,
      otherDeductions: 0,
      // Accrual is based on the employee's actual completed service, not zero.
      gratuityAccrued: calculateGratuityAccrual(e.basic, e.dearnessAllowance, completedYearsAt(e.dateOfJoining, month)),
    }));

  const wages: EmployeeWages[] = entries.map((e) => ({
    employeeId: e.employeeId,
    name: e.name,
    basic: e.basic,
    dearnessAllowance: e.dearnessAllowance,
    hra: e.hra,
    otherAllowances: (e.otherAllowances ?? 0) + e.overtimeAmount + e.bonusAmount + e.arrearAmount + e.otherEarnings,
  }));

  const taxRegime = employees[0]?.taxRegime;
  let regime: TaxRegime = NEW_REGIME_2025_26;
  if (taxRegime && taxRegime.slabs && Array.isArray(taxRegime.slabs)) {
    regime = taxRegime;
  }
  const reg = payrollRegister({
    month,
    employees: wages,
    regime,
  });

  return {
    runId: `pr-${month.replace("-", "")}-${Date.now().toString(36)}`,
    month,
    financialYear: fy,
    organizationId: "default",
    status: "draft",
    runType,
    employees: entries,
    register: reg,
    validationErrors: [],
    validationWarnings: [],
    createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

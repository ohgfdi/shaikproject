/** Indian labour law compliance - minimum wages, EPF/ECS, bonus, gratuity, ESI, LWF */

export class LabourLawComplianceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabourLawComplianceError";
  }
}

import { formatInr } from "./india-tax";

// ---------------------------------------------------------------------------
// Minimum Wages Act, 1948
// ---------------------------------------------------------------------------

export interface MinimumWageSlab {
  stateCode: string;
  stateName: string;
  category: "unskilled" | "semi-skilled" | "skilled" | "highly-skilled";
  areaType: "urban" | "rural";
  dailyWage: number; // minor units
  hourlyWage?: number | null;
  effectiveDate: string;
  expiryDate: string;
}

export interface MinimumWageCompliance {
  stateCode: string;
  stateName: string;
  establishmentName: string;
  category: "unskilled" | "semi-skilled" | "skilled" | "highly-skilled";
  areaType: "urban" | "rural";
  employees: {
    employeeId: string;
    name: string;
    appointedWage: number;
    minimumWage: number;
    shortfall: number;
    compliant: boolean;
  }[];
  totalEmployees: number;
  compliantEmployees: number;
  nonCompliantEmployees: number;
  totalShortfall: number;
  penaltyRisk: number;
  warnings: string[];
  methodology: string[];
}

export function checkMinimumWageCompliance(
  slabs: MinimumWageSlab[],
  employees: {
    employeeId: string;
    name: string;
    appointedWage: number;
    category: "unskilled" | "semi-skilled" | "skilled" | "highly-skilled";
    areaType: "urban" | "rural";
  }[],
): MinimumWageCompliance {
  const stateSlab = slabs[0]; // Simplified - take first slab
  if (!stateSlab) throw new LabourLawComplianceError("No minimum wage slab supplied for the establishment.");
  const compliantEmployees = employees.filter((e) => e.appointedWage >= stateSlab.dailyWage);
  const nonCompliantEmployees = employees.filter((e) => e.appointedWage < stateSlab.dailyWage);

  let totalShortfall = 0;
  const employeesWithShortfall = employees.map((e) => {
    const shortfall = Math.max(0, stateSlab.dailyWage - e.appointedWage);
    totalShortfall += shortfall;
    return {
      employeeId: e.employeeId,
      name: e.name,
      appointedWage: e.appointedWage,
      minimumWage: stateSlab.dailyWage,
      shortfall,
      compliant: shortfall === 0,
    };
  });

  // Penalty: up to 500 rupees per employee per day of default
  const penaltyRisk = Math.round((nonCompliantEmployees.length * stateSlab.dailyWage * 500) / 100);

  return {
    stateCode: stateSlab.stateCode,
    stateName: stateSlab.stateName,
    establishmentName: "Example Establishment",
    category: stateSlab.category,
    areaType: stateSlab.areaType,
    employees: employeesWithShortfall,
    totalEmployees: employees.length,
    compliantEmployees: compliantEmployees.length,
    nonCompliantEmployees: nonCompliantEmployees.length,
    totalShortfall,
    penaltyRisk,
    warnings:
      nonCompliantEmployees.length > 0
        ? [`${nonCompliantEmployees.length} employee(s) below minimum wage - penalty risk ${formatInr(penaltyRisk)}.`]
        : [],
    methodology: [
      `Minimum wage compliance: ${employees.length} employee(s), ${compliantEmployees.length} compliant, ${nonCompliantEmployees.length} non-compliant.`,
      `Minimum wage: ${formatInr(stateSlab.dailyWage)} per day (${stateSlab.category}, ${stateSlab.areaType}).`,
      `Total shortfall: ${formatInr(totalShortfall)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Payment of Wages Act, 1936
// ---------------------------------------------------------------------------

export interface WagePayment {
  employeeId: string;
  name: string;
  wagePeriodStart: string;
  wagePeriodEnd: string;
  wageDueDate: string;
  wagePaidDate?: string | null;
  grossWage: number;
  deductions: {
    deductionType: "pf" | "esi" | "professional_tax" | "tax" | "other";
    amount: number;
    description?: string | null;
  }[];
  totalDeductions: number;
  netWage: number;
  paymentMode: "cash" | "cheque" | "bank_transfer" | "account_payable";
  isTimely: boolean;
  daysLate?: number | null;
}

export interface WagePaymentCompliance {
  wagePeriodStart: string;
  wagePeriodEnd: string;
  totalEmployees: number;
  timelyPayments: number;
  delayedPayments: number;
  delayedPaymentDetails: {
    employeeId: string;
    name: string;
    dueDate: string;
    paidDate?: string | null;
    delayInDays: number;
    penaltyDue: number;
  }[];
  totalPenaltyRisk: number;
  warnings: string[];
  methodology: string[];
}

export function checkWagePaymentCompliance(wages: WagePayment[]): WagePaymentCompliance {
  const delayedPayments = wages.filter((w) => !w.isTimely);
  let totalPenaltyRisk = 0;

  const delayedPaymentDetails = delayedPayments.map((w) => {
    const paidDate = new Date(w.wagePaidDate ?? "");
    const dueDate = new Date(w.wageDueDate);
    const delayInDays = Math.max(0, Math.floor((paidDate.getTime() - dueDate.getTime()) / 86400000));
    // Penalty: up to 500 rupees per employee per day of delay
    const penaltyDue = Math.round(delayInDays * 500);
    totalPenaltyRisk += penaltyDue;
    return {
      employeeId: w.employeeId,
      name: w.name,
      dueDate: w.wageDueDate,
      paidDate: w.wagePaidDate,
      delayInDays,
      penaltyDue,
    };
  });

  return {
    wagePeriodStart: wages[0]?.wagePeriodStart ?? "",
    wagePeriodEnd: wages[0]?.wagePeriodEnd ?? "",
    totalEmployees: wages.length,
    timelyPayments: wages.filter((w) => w.isTimely).length,
    delayedPayments: delayedPayments.length,
    delayedPaymentDetails,
    totalPenaltyRisk,
    warnings:
      delayedPayments.length > 0
        ? [`${delayedPayments.length} payment(s) delayed - penalty risk ${formatInr(totalPenaltyRisk)}.`]
        : [],
    methodology: [
      `Wage payment compliance: ${wages.length} employee(s), ${wages.filter((w) => w.isTimely).length} timely, ${delayedPayments.length} delayed.`,
      `Total penalty risk: ${formatInr(totalPenaltyRisk)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// EPF/ECS (Employees' Provident Fund)
// ---------------------------------------------------------------------------

export interface EPFCompliance {
  establishmentCode: string;
  establishmentName: string;
  contributionPeriod: string; // yyyy-mm
  totalEmployees: number;
  exemptedEmployees: number;
  contributingEmployees: number;
  totalWages: number;
  employeeContribution: number; // 12% of wages
  employerContribution: number; // 12% of wages (8.33% EPS + 3.67% EPF)
  epsContribution: number; // 8.33% of wages
  epfAdminCharges: number; // 0.85% of wages
  edliCharges: number; // 0.5% of wages
  totalEmployerCost: number;
  totalDeposit: number;
  depositDate?: string | null;
  depositStatus: "deposited" | "pending" | "late";
  lateDays?: number | null;
  lateFee: number;
  warnings: string[];
  methodology: string[];
}

export function checkEPFCompliance(
  employees: { employeeId: string; name: string; wages: number; isExempted: boolean }[],
  contributionPeriod: string,
  depositDate?: string | null,
): EPFCompliance {
  const contributingEmployees = employees.filter((e) => !e.isExempted);
  const totalWages = contributingEmployees.reduce((s, e) => s + e.wages, 0);
  const employeeContribution = Math.round((totalWages * 12) / 100);
  const employerContribution = Math.round((totalWages * 12) / 100);
  const epsContribution = Math.round((totalWages * 8.33) / 100);
  const epfAdminCharges = Math.round((totalWages * 0.85) / 100);
  const edliCharges = Math.round((totalWages * 0.5) / 100);
  const totalEmployerCost = employerContribution + epfAdminCharges + edliCharges;
  const totalDeposit = employeeContribution + employerContribution;

  const dueDate = new Date(`${contributionPeriod.slice(0, 4)}-${contributionPeriod.slice(5, 7)}-07`);
  if (dueDate.getMonth() === 3) dueDate.setDate(30); // March deduction due April 30

  const depositStatus = depositDate ? (new Date(depositDate) <= dueDate ? "deposited" : "late") : "pending";
  const lateDays = depositDate
    ? Math.max(0, Math.floor((new Date(depositDate).getTime() - dueDate.getTime()) / 86400000))
    : 0;
  const lateFee = Math.round(totalDeposit * 0.02 * lateDays);

  return {
    establishmentCode: "EST-001",
    establishmentName: "Example Establishment",
    contributionPeriod,
    totalEmployees: employees.length,
    exemptedEmployees: employees.filter((e) => e.isExempted).length,
    contributingEmployees: contributingEmployees.length,
    totalWages,
    employeeContribution,
    employerContribution,
    epsContribution,
    epfAdminCharges,
    edliCharges,
    totalEmployerCost,
    totalDeposit,
    depositDate,
    depositStatus,
    lateDays: depositStatus === "late" ? lateDays : null,
    lateFee: depositStatus === "late" ? lateFee : 0,
    warnings: depositStatus === "late" ? [`EPF deposit late by ${lateDays} days - penalty ${formatInr(lateFee)}.`] : [],
    methodology: [
      `EPF compliance: ${contributingEmployees.length} contributing employee(s), total wages ${formatInr(totalWages)}.`,
      `Employee contribution: ${formatInr(employeeContribution)}, employer contribution: ${formatInr(employerContribution)}.`,
      `EPS: ${formatInr(epsContribution)}, EPF admin: ${formatInr(epfAdminCharges)}, EDLI: ${formatInr(edliCharges)}.`,
      `Total deposit: ${formatInr(totalDeposit)}, status: ${depositStatus}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Payment of Bonus Act, 1965
// ---------------------------------------------------------------------------

export interface BonusCompliance {
  establishmentCode: string;
  establishmentName: string;
  financialYear: string;
  totalEmployees: number;
  eligibleEmployees: number;
  eligibleForBonus: number;
  totalSalaryPaid: number;
  allocableSurplus: number;
  minimumBonus: number; // 8.33% of salary
  maximumBonus: number; // 20% of salary
  bonusPaid: number;
  bonusRate: number;
  bonusPerEmployee: number;
  balanceDue: number;
  status: "computed" | "paid" | "pending";
  warnings: string[];
  methodology: string[];
}

export function checkBonusCompliance(
  employees: { employeeId: string; name: string; salary: number; isEligible: boolean }[],
  financialYear: string,
  bonusPaid?: number | null,
): BonusCompliance {
  const eligibleEmployees = employees.filter((e) => e.isEligible);
  const totalSalaryPaid = eligibleEmployees.reduce((s, e) => s + e.salary, 0);
  const allocableSurplus = Math.round((totalSalaryPaid * 30) / 100); // 30% of profit as allocable surplus
  const minimumBonus = Math.round((totalSalaryPaid * 8.33) / 100); // 8.33% of salary
  const maximumBonus = Math.min(200000, Math.round((totalSalaryPaid * 20) / 100)); // 20% of salary or 2 lakh
  const bonusPerEmployee = Math.round(minimumBonus / eligibleEmployees.length);

  const actualBonusPaid = bonusPaid ?? 0;
  const balanceDue = Math.max(0, minimumBonus - actualBonusPaid);

  return {
    establishmentCode: "EST-002",
    establishmentName: "Example Establishment",
    financialYear,
    totalEmployees: employees.length,
    eligibleEmployees: employees.filter((e) => e.isEligible).length,
    eligibleForBonus: eligibleEmployees.length,
    totalSalaryPaid,
    allocableSurplus,
    minimumBonus,
    maximumBonus,
    bonusPaid: actualBonusPaid,
    bonusRate: 8.33,
    bonusPerEmployee,
    balanceDue,
    status: actualBonusPaid >= minimumBonus ? "paid" : "pending",
    warnings: balanceDue > 0 ? [`Minimum bonus not fully paid - balance due ${formatInr(balanceDue)}.`] : [],
    methodology: [
      `Bonus compliance: ${eligibleEmployees.length} eligible employee(s), total salary ${formatInr(totalSalaryPaid)}.`,
      `Allocable surplus: ${formatInr(allocableSurplus)}, minimum bonus: ${formatInr(minimumBonus)}, maximum bonus: ${formatInr(maximumBonus)}.`,
      `Bonus paid: ${formatInr(actualBonusPaid)}, balance due: ${formatInr(balanceDue)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Payment of Gratuity Act, 1972
// ---------------------------------------------------------------------------

export interface GratuityCompliance {
  establishmentCode: string;
  establishmentName: string;
  financialYear: string;
  totalEmployees: number;
  eligibleEmployees: number;
  employeesRetiring: number;
  employeesResigning: number;
  employeesSuperannuating: number;
  totalGratuityPayable: number;
  maximumGratuity: number;
  minimumGratuity: number;
  estimatedLiability: number;
  alreadyProvided: number;
  balanceDue: number;
  status: "computed" | "paid" | "pending";
  warnings: string[];
  methodology: string[];
}

export function checkGratuityCompliance(
  employees: {
    employeeId: string;
    name: string;
    serviceYears: number;
    lastSalary: number;
    isEligible: boolean;
    retirementType?: "retirement" | "resignation" | "superannuation" | "death";
  }[],
  financialYear: string,
): GratuityCompliance {
  const eligibleEmployees = employees.filter((e) => e.isEligible);
  const employeesRetiring = eligibleEmployees.filter((e) => e.retirementType === "retirement").length;
  const employeesResigning = eligibleEmployees.filter((e) => e.retirementType === "resignation").length;
  const employeesSuperannuating = eligibleEmployees.filter((e) => e.retirementType === "superannuation").length;

  let totalGratuityPayable = 0;
  let maximumGratuity = 0;
  let minimumGratuity = 0;

  for (const e of eligibleEmployees) {
    const gratuity = Math.round((e.lastSalary * 15 * e.serviceYears) / 26); // 15 days salary per year of service
    const maxGratuity = 2000000; // Maximum gratuity under Payment of Gratuity Act
    const minGratuity = Math.round((e.lastSalary * 15) / 26); // Minimum 15 days per year
    totalGratuityPayable += Math.min(gratuity, maxGratuity);
    maximumGratuity += maxGratuity;
    minimumGratuity += minGratuity;
  }

  const estimatedLiability = totalGratuityPayable;
  const alreadyProvided = 0; // Would be from accounts
  const balanceDue = Math.max(0, estimatedLiability - alreadyProvided);

  return {
    establishmentCode: "EST-003",
    establishmentName: "Example Establishment",
    financialYear,
    totalEmployees: employees.length,
    eligibleEmployees: eligibleEmployees.length,
    employeesRetiring,
    employeesResigning,
    employeesSuperannuating,
    totalGratuityPayable,
    maximumGratuity,
    minimumGratuity,
    estimatedLiability,
    alreadyProvided,
    balanceDue,
    status: balanceDue === 0 ? "paid" : "pending",
    warnings: balanceDue > 0 ? [`Gratuity balance due: ${formatInr(balanceDue)}.`] : [],
    methodology: [
      `Gratuity compliance: ${eligibleEmployees.length} eligible employee(s), ${employeesRetiring} retiring, ${employeesResigning} resigning.`,
      `Total gratuity payable: ${formatInr(totalGratuityPayable)}, estimated liability: ${formatInr(estimatedLiability)}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// ESI (Employees' State Insurance)
// ---------------------------------------------------------------------------

export interface ESICompliance {
  establishmentCode: string;
  establishmentName: string;
  contributionPeriod: string; // yyyy-mm
  totalEmployees: number;
  exemptedEmployees: number;
  contributingEmployees: number;
  totalWages: number;
  employeeContribution: number; // 0.75% of wages
  employerContribution: number; // 3.25% of wages
  totalContribution: number;
  depositDate?: string | null;
  depositStatus: "deposited" | "pending" | "late";
  lateDays?: number | null;
  lateFee: number;
  warnings: string[];
  methodology: string[];
}

export function checkESICompliance(
  employees: { employeeId: string; name: string; wages: number; isExempted: boolean; grossSalary: number }[],
  contributionPeriod: string,
  depositDate?: string | null,
): ESICompliance {
  const contributingEmployees = employees.filter((e) => !e.isExempted && e.grossSalary <= 210000);
  const totalWages = contributingEmployees.reduce((s, e) => s + e.grossSalary, 0);
  const employeeContribution = Math.round((totalWages * 0.75) / 100);
  const employerContribution = Math.round((totalWages * 3.25) / 100);
  const totalContribution = employeeContribution + employerContribution;

  const dueDate = new Date(`${contributionPeriod.slice(0, 4)}-${contributionPeriod.slice(5, 7)}-07`);

  const depositStatus = depositDate ? (new Date(depositDate) <= dueDate ? "deposited" : "late") : "pending";
  const lateDays = depositDate
    ? Math.max(0, Math.floor((new Date(depositDate).getTime() - dueDate.getTime()) / 86400000))
    : 0;
  const lateFee = Math.round(totalContribution * 0.02 * lateDays);

  return {
    establishmentCode: "EST-004",
    establishmentName: "Example Establishment",
    contributionPeriod,
    totalEmployees: employees.length,
    exemptedEmployees: employees.filter((e) => e.isExempted || e.grossSalary > 210000).length,
    contributingEmployees: contributingEmployees.length,
    totalWages,
    employeeContribution,
    employerContribution,
    totalContribution,
    depositDate,
    depositStatus,
    lateDays: depositStatus === "late" ? lateDays : null,
    lateFee: depositStatus === "late" ? lateFee : 0,
    warnings: depositStatus === "late" ? [`ESI deposit late by ${lateDays} days - penalty ${formatInr(lateFee)}.`] : [],
    methodology: [
      `ESI compliance: ${contributingEmployees.length} contributing employee(s), total wages ${formatInr(totalWages)}.`,
      `Employee contribution: ${formatInr(employeeContribution)}, employer contribution: ${formatInr(employerContribution)}.`,
      `Total contribution: ${formatInr(totalContribution)}, status: ${depositStatus}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Labour Welfare Fund (LWF)
// ---------------------------------------------------------------------------

export interface LWFCompliance {
  stateCode: string;
  stateName: string;
  establishmentCode: string;
  establishmentName: string;
  financialYear: string;
  employeeWageCount: number;
  employeeLWF: number; // 0.2% of salary (varies by state)
  employerLWF: number; // 0.2% to 2.5% of salary (varies by state)
  totalLWF: number;
  depositDate?: string | null;
  depositStatus: "deposited" | "pending" | "late";
  lateDays?: number | null;
  lateFee: number;
  warnings: string[];
  methodology: string[];
}

export function checkLWFCompliance(
  employees: { employeeId: string; name: string; salary: number }[],
  stateCode: string,
  financialYear: string,
  depositDate?: string | null,
): LWFCompliance {
  const stateNames: Record<string, string> = {
    "14": "Maharashtra",
    "27": "Karnataka",
    "23": "Tamil Nadu",
    "07": "Gujarat",
  };
  const stateName = stateNames[stateCode] ?? "Unknown";

  // LWF rates vary by state - simplified
  const employeeLWF = Math.round((employees.reduce((s, e) => s + e.salary, 0) * 0.2) / 100);
  const employerLWF = Math.round((employees.reduce((s, e) => s + e.salary, 0) * 0.2) / 100);

  const totalLWF = employeeLWF + employerLWF;

  const dueDate = new Date(`${Number(financialYear.slice(0, 4)) + 1}-03-31`);

  const depositStatus = depositDate ? (new Date(depositDate) <= dueDate ? "deposited" : "late") : "pending";
  const lateDays = depositDate
    ? Math.max(0, Math.floor((new Date(depositDate).getTime() - dueDate.getTime()) / 86400000))
    : 0;
  const lateFee = Math.round(totalLWF * 0.02 * lateDays);

  return {
    stateCode,
    stateName,
    establishmentCode: "EST-005",
    establishmentName: "Example Establishment",
    financialYear,
    employeeWageCount: employees.length,
    employeeLWF,
    employerLWF,
    totalLWF,
    depositDate,
    depositStatus,
    lateDays: depositStatus === "late" ? lateDays : null,
    lateFee: depositStatus === "late" ? lateFee : 0,
    warnings: depositStatus === "late" ? [`LWF deposit late by ${lateDays} days - penalty ${formatInr(lateFee)}.`] : [],
    methodology: [
      `LWF compliance (${stateName}): ${employees.length} employee(s), total salaries ${formatInr(employees.reduce((s, e) => s + e.salary, 0))}.`,
      `Employee LWF: ${formatInr(employeeLWF)}, employer LWF: ${formatInr(employerLWF)}, total: ${formatInr(totalLWF)}.`,
      `Status: ${depositStatus}.`,
    ],
  };
}

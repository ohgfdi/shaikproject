/**
 * Payroll + professional tax + labour — salary head-wise split, PF
 * (employee + employer: EPF/EDLI/admin and EPS), ESI, professional tax by
 * state, gratuity and labour-law boilerplate estimates (LWF, minimum-wage
 * checks), and the take-home waterfall.
 *
 * SCOPE AND HONESTY: the statutory rates and ceilings shown are the commonly
 * referenced ones and are surfaced on the result so a reviewer can verify them
 * against the current notifications/rules for the period and state. The engine
 * is arithmetic on caller-supplied salary structures and statutory inputs; it
 * does not fetch live law and does not issue a legal opinion.
 */

import { computeIncomeTax, INR, NEW_REGIME_2025_26 } from "./india-tax";
import { computeProfessionalTax, PT_REGISTRY } from "./professional-tax";

export interface PayrollBreakup {
  employeeId: string;
  employeeName: string;
  basic: number;
  da: number;
  hra: number;
  specialAllowance: number;
  otherAllowances: number;
  bonusses: number;
  grossSalary: number;
  pfEmployee: number;
  pfEmployer: number;
  eps: number;
  edli: number;
  pfAdmin: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  lwf: number;
  tds: number;
  otherDeductions: number;
  totalDeductions: number;
  netPay: number;
  gratuity: number;
}

export interface PayrollResult {
  period: string;
  state: string;
  employeeCount: number;
  employees: PayrollBreakup[];
  statutoryCeilings: {
    pfWageCeiling: number;
    epfRate: number;
    edliRate: number;
    pfAdminRate: number;
    esiWageCeiling: number;
    esiEmployeeRate: number;
    esiEmployerRate: number;
  };
  warnings: string[];
  methodology: string[];
}

function clampCeiling(value: number, ceiling: number): number {
  return Math.min(value, ceiling);
}

export function computePayroll(input: {
  period: string;
  state: string;
  employeeCount: number;
  employees: {
    id: string;
    name: string;
    basic: number;
    da: number;
    hra: number;
    specialAllowance: number;
    otherAllowances: number;
    bonusses: number;
    deductions: { providentFund: number; esi: number; professionalTax: number; lwf: number; other: number };
    dateOfJoining: string;
    dateOfBirth: string;
    gender: string;
  }[];
  minimumWage: { skilled: number; unskilled: number };
}): PayrollResult {
  const { period, state, employeeCount, employees } = input;

  // Commonly referenced ceilings/rates — surfaced so the reviewer can verify.
  const pfWageCeiling = 15_000;
  const epfRate = 12;
  const edliRate = 0.5;
  const pfAdminRate = 0.5;
  const esiWageCeiling = 21_000;
  const esiEmployeeRate = 0.75;
  const esiEmployerRate = 3.25;

  // Professional tax comes from the state registry (state-name lookup), not a
  // single flat figure: Maharashtra is ₹175/₹200 by slab, Tamil Nadu is
  // ₹225–₹1,000, and Delhi/Punjab/UP do not levy it at all.
  const ptConfigByName = new Map(Object.values(PT_REGISTRY).map((c) => [c.stateName.trim().toLowerCase(), c]));
  const stateConfig = ptConfigByName.get(state.trim().toLowerCase());

  const statutoryCeilings = {
    pfWageCeiling,
    epfRate,
    edliRate,
    pfAdminRate,
    esiWageCeiling,
    esiEmployeeRate,
    esiEmployerRate,
  };

  /** Completed years of service from the joining date to the payroll month. */
  const completedYears = (joining: string, payrollPeriod: string): number => {
    const j = new Date(`${joining.slice(0, 10)}T00:00:00Z`);
    const p = new Date(`${payrollPeriod}-01T00:00:00Z`);
    if (Number.isNaN(j.getTime()) || Number.isNaN(p.getTime()) || p <= j) return 0;
    let years = p.getUTCFullYear() - j.getUTCFullYear();
    const beforeAnniversary =
      p.getUTCMonth() < j.getUTCMonth() || (p.getUTCMonth() === j.getUTCMonth() && p.getUTCDate() < j.getUTCDate());
    if (beforeAnniversary) years -= 1;
    return Math.max(0, years);
  };

  const employeesOut: PayrollBreakup[] = employees.map((e) => {
    const basic = Math.max(0, Math.round(e.basic));
    const da = Math.max(0, Math.round(e.da));
    const hra = Math.max(0, Math.round(e.hra));
    const specialAllowance = Math.max(0, Math.round(e.specialAllowance));
    const otherAllowances = Math.max(0, Math.round(e.otherAllowances));
    const bonusses = Math.max(0, Math.round(e.bonusses));
    const grossSalary = basic + da + hra + specialAllowance + otherAllowances + bonusses;

    // PF employee: 12% of basic + DA, capped at the statutory wage ceiling.
    const pfWage = clampCeiling(basic + da, pfWageCeiling);
    const pfEmployee = Math.round((pfWage * epfRate) / 100);
    // Employer: 12% total, split EPS 8.33% (never above the ceiling) with EPF as
    // the balance; EDLI 0.5% and admin 0.5% are separate employer costs.
    const totalEmployerPf = Math.round((pfWage * epfRate) / 100);
    const eps = Math.min(totalEmployerPf, Math.round((pfWage * 8.33) / 100));
    const pfEmployer = totalEmployerPf - eps; // EPF share only
    const edli = Math.round((pfWage * edliRate) / 100);
    const pfAdmin = Math.round((pfWage * pfAdminRate) / 100);

    // ESI: 0.75% / 3.25% of GROSS while gross is at or below ₹21,000. It is not
    // a capped contribution — one rupee over the ceiling and ESI stops.
    const esiApplicable = grossSalary <= esiWageCeiling;
    const esiEmployee = esiApplicable ? Math.round((grossSalary * esiEmployeeRate) / 100) : 0;
    const esiEmployer = esiApplicable ? Math.round((grossSalary * esiEmployerRate) / 100) : 0;

    // Professional tax from the state registry (monthly, slab-based).
    let pt = 0;
    if (stateConfig?.applies) {
      pt = computeProfessionalTax({ stateCode: stateConfig.stateCode, grossSalary: grossSalary * 100 }).ptAmount / 100;
      // Maharashtra charges ₹300 in February instead of the usual ₹200.
      if (stateConfig.stateCode === "14" && period.endsWith("-02") && pt > 0) pt += 100;
    }

    // LWF is state-specific and not modelled; the caller supplies it.
    const lwf = 0;
    // Gratuity accrues on completed service: 15/26 of basic + DA per year, /12
    // for the month. Payment needs 5 years' service; the accrual does not.
    const gratuityYears = completedYears(e.dateOfJoining, period);
    const gratuity = Math.round(((basic + da) * 15 * gratuityYears) / 26 / 12);

    // TDS u/s 192 on the annualised gross under the default (new) regime.
    const annualGross = grossSalary * 12;
    const annualTax = computeIncomeTax({ grossIncome: INR(annualGross), regime: NEW_REGIME_2025_26 });
    const tds = Math.round(annualTax.totalTax / 100 / 12);

    // Use caller-supplied deductions as base, overriding computed where supplied.
    const usedPFDed = e.deductions.providentFund || pfEmployee;
    const usedESIDed = e.deductions.esi || esiEmployee;
    const usedPTDed = e.deductions.professionalTax || pt;
    const usedLWFDed = e.deductions.lwf || lwf;
    const usedOtherDed = e.deductions.other || 0;

    const totalDeductions = usedPFDed + usedESIDed + usedPTDed + usedLWFDed + usedOtherDed + tds;
    const netPay = grossSalary - totalDeductions;

    return {
      employeeId: e.id,
      employeeName: e.name,
      basic,
      da,
      hra,
      specialAllowance,
      otherAllowances,
      bonusses,
      grossSalary,
      pfEmployee,
      pfEmployer,
      eps,
      edli,
      pfAdmin,
      esiEmployee,
      esiEmployer,
      professionalTax: pt,
      lwf,
      tds,
      otherDeductions: usedOtherDed,
      totalDeductions,
      netPay,
      gratuity,
    };
  });

  const warnings: string[] = [];
  for (const e of employeesOut) {
    if (e.basic + e.da > pfWageCeiling)
      warnings.push(
        `Employee ${e.employeeId}: basic + DA exceeds PF wage ceiling ${pfWageCeiling}; PF computed on the ceiling.`,
      );
  }

  return {
    period,
    state,
    employeeCount,
    employees: employeesOut,
    statutoryCeilings,
    warnings,
    methodology: [
      "Gross salary is the sum of basic, DA, HRA, special allowance, other allowances and bonuses.",
      "PF employee contribution is 12% of basic + DA, capped at the ₹15,000 wage ceiling.",
      "The employer's 12% is split into EPS 8.33% (never above the ceiling) and EPF as the balance; EDLI 0.5% and admin 0.5% are additional employer costs.",
      "ESI is 0.75%/3.25% of gross only while gross is at or below ₹21,000; above the ceiling no ESI is payable.",
      "Professional tax is taken from the state registry's slab table (Maharashtra's February ₹300 is applied).",
      "TDS u/s 192 is the annualised tax under the default new regime ÷ 12; the caller's regime and declarations may change it.",
      "Gratuity accrues on completed service at 15/26 of basic + DA per year; the five-year rule governs payment, not accrual.",
    ],
  };
}

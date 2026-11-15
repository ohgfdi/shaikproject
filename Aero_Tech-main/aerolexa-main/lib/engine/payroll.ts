/**
 * India payroll engine — EPF, ESI, professional tax and salary TDS u/s 192.
 *
 * The monthly payroll a CA firm runs for clients, computed the way the
 * statutes require:
 *
 *   EPF  — 12% employee on EPF wages (basic + DA) CAPPED at the statutory
 *          wage ceiling unless the caller opts out; employer matches 12%, of
 *          which 8.33% (capped to the ceiling) diverts to EPS and the rest
 *          stays in EPF; EDLI 0.5% and EPF admin 0.5% are employer costs.
 *   ESI  — 0.75% employee + 3.25% employer on gross wages when gross is at or
 *          below the wage ceiling (one rupee over and ESI does not apply).
 *   PT   — state slab tables are DATA the caller supplies (states differ and
 *          states change; a hardcoded table is how payroll goes silently
 *          wrong in April).
 *   TDS  — s192: annual tax on taxable salary (via `computeIncomeTax` with a
 *          caller-chosen regime), spread over the pay months.
 *
 * All money in MINOR UNITS (paise), integer, like every other CA engine.
 * Statutory ceilings and rates below are LABELLED DEFAULTS (FY 2025-26);
 * every one of them is a parameter the caller can override.
 */

import { computeIncomeTax, formatInr, INR, type TaxRegime } from "./india-tax";

export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

// ---------------------------------------------------------------------------
// Statutory configuration (labelled defaults — the caller overrides)
// ---------------------------------------------------------------------------

export interface PayrollConfig {
  /** EPF wage ceiling, minor units. Default ₹15,000 (s2(14) / para 2(f)). */
  epfWageCeiling: number;
  /** Employee + employer PF rate % on EPF wages. Default 12. */
  epfRatePct: number;
  /** EPS share of the employer contribution, %. Default 8.33. */
  epsRatePct: number;
  /** EDLI charge %, employer cost. Default 0.5. */
  edliRatePct: number;
  /** EPF admin charge %, employer cost. Default 0.5. */
  epfAdminRatePct: number;
  /** true: compute PF on actual wages even when above the ceiling. Default false. */
  epfOnActualWages: boolean;
  /** ESI wage ceiling, minor units. Default ₹21,000. */
  esiWageCeiling: number;
  /** ESI employee rate %. Default 0.75. */
  esiEmployeeRatePct: number;
  /** ESI employer rate %. Default 3.25. */
  esiEmployerRatePct: number;
  /** State PT slabs (monthly gross up to → amount, minor units). Caller data. */
  professionalTaxSlabs: { upTo: number | null; amount: number }[];
}

/** FY 2025-26 defaults: central EPF/ESI rules + a labelled Maharashtra PT table. */
export const PAYROLL_DEFAULTS_2025_26: PayrollConfig = {
  epfWageCeiling: INR(15000),
  epfRatePct: 12,
  epsRatePct: 8.33,
  edliRatePct: 0.5,
  epfAdminRatePct: 0.5,
  epfOnActualWages: false,
  esiWageCeiling: INR(21000),
  esiEmployeeRatePct: 0.75,
  esiEmployerRatePct: 3.25,
  professionalTaxSlabs: [
    { upTo: INR(7500), amount: 0 }, // Maharashtra monthly slabs (state data)
    { upTo: INR(10000), amount: INR(175) },
    { upTo: null, amount: INR(200) }, // ₹300 in the last month of the FY — caller handles
  ],
};

// ---------------------------------------------------------------------------
// Payslip
// ---------------------------------------------------------------------------

export interface EmployeeWages {
  employeeId: string;
  name: string;
  basic: number;
  /** Dearness allowance — counts as EPF wages. */
  dearnessAllowance?: number;
  hra?: number;
  /** Other taxable allowances (conveyance, special allowance…). */
  otherAllowances?: number;
  /** ESI counts GROSS; PF counts basic + DA only. */
}

export interface Payslip {
  employeeId: string;
  name: string;
  month: string;
  gross: number;
  epfWages: number;
  esiApplicable: boolean;
  deductions: {
    epfEmployee: number;
    esiEmployee: number;
    professionalTax: number;
    tds: number;
    total: number;
  };
  employerCosts: {
    epfEmployer: number;
    epsEmployer: number;
    edli: number;
    epfAdmin: number;
    esiEmployer: number;
    total: number;
  };
  netPay: number;
  /** Annual TDS basis and the per-month figure actually deducted. */
  tdsAnnualTax: number;
  methodology: string[];
}

/** Monthly professional tax from caller-supplied slabs. */
export function professionalTax(gross: number, slabs: PayrollConfig["professionalTaxSlabs"]): number {
  const sorted = [...slabs].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  for (const slab of sorted) {
    if (slab.upTo === null || gross <= slab.upTo) return Math.round(slab.amount);
  }
  // An open top slab is required; a closed table that misses the gross is a
  // configuration error, not a zero.
  throw new PayrollError("Professional-tax slabs do not cover this gross wage — supply an open top slab (upTo: null).");
}

/**
 * Compute one monthly payslip.
 *
 * EPF wages = basic + DA, capped at the ceiling unless `epfOnActualWages`.
 * EPS is 8.33% of EPF wages but never above the ceiling even when PF runs on
 * actual wages — that is the statutory split, not an approximation.
 */
export function computePayslip(input: {
  employee: EmployeeWages;
  month: string;
  /** Annual taxable salary for the TDS projection (defaults to gross × 12 + caller adjustments). */
  annualTaxableSalary?: number;
  regime: TaxRegime;
  /** Months remaining in the FY to spread the annual tax over. Default 12. */
  monthsRemaining?: number;
  config?: Partial<PayrollConfig>;
}): Payslip {
  const cfg: PayrollConfig = { ...PAYROLL_DEFAULTS_2025_26, ...input.config };
  const e = input.employee;
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new PayrollError("month must look like 2025-04.");
  if (!Number.isFinite(e.basic) || e.basic < 0) throw new PayrollError(`Basic wage cannot be negative for ${e.name}.`);

  const basic = Math.round(e.basic);
  const da = Math.max(0, Math.round(e.dearnessAllowance ?? 0));
  const hra = Math.max(0, Math.round(e.hra ?? 0));
  const other = Math.max(0, Math.round(e.otherAllowances ?? 0));
  const gross = basic + da + hra + other;

  // EPF wages = basic + DA, capped at the statutory ceiling unless the employer
  // has opted for actual wages under paragraph 26(6).
  const pfBase = basic + da;
  const epfWages = cfg.epfOnActualWages ? pfBase : Math.min(pfBase, cfg.epfWageCeiling);
  // EPS/EDLI/admin never exceed the ceiling, even when PF runs on actual wages.
  const cappedPfWages = Math.min(pfBase, cfg.epfWageCeiling);
  // ESI applies while gross is AT OR BELOW the ceiling; one rupee over ends it.
  const esiApplicable = gross <= cfg.esiWageCeiling;

  // ---- EPF ---------------------------------------------------------------
  const epfEmployee = Math.round((epfWages * cfg.epfRatePct) / 100);
  const totalEmployerPf = Math.round((epfWages * cfg.epfRatePct) / 100);
  const epsWages = cappedPfWages;
  // EPS is deposited in WHOLE RUPEES (EPFO practice) — round the paise away
  // here so the EPF/EPS split reconciles to the challan, not to 50 paise.
  const epsEmployer = Math.min(totalEmployerPf, Math.round((epsWages * cfg.epsRatePct) / 100 / 100) * 100);
  const epfEmployer = totalEmployerPf - epsEmployer;
  const edli = Math.round((epsWages * cfg.edliRatePct) / 100);
  const epfAdmin = Math.round((epsWages * cfg.epfAdminRatePct) / 100);

  // ---- ESI ---------------------------------------------------------------
  const esiEmployee = esiApplicable ? Math.round((gross * cfg.esiEmployeeRatePct) / 100) : 0;
  const esiEmployer = esiApplicable ? Math.round((gross * cfg.esiEmployerRatePct) / 100) : 0;

  // ---- PT ----------------------------------------------------------------
  const pt = professionalTax(gross, cfg.professionalTaxSlabs);

  // ---- TDS u/s 192 -------------------------------------------------------
  // The annual tax is projected on the annual taxable salary (all allowances
  // included) and spread over the pay months still left in the year. TDS is
  // deposited in whole rupees.
  const months = input.monthsRemaining ?? 12;
  if (!Number.isFinite(months) || months <= 0) throw new PayrollError("monthsRemaining must be positive.");
  const annualSalary = Math.max(0, Math.round(input.annualTaxableSalary ?? gross * 12));
  const tax = computeIncomeTax({ grossIncome: annualSalary, regime: input.regime, applyStandardDeduction: true });
  const tds = Math.round(tax.totalTax / months / 100) * 100;

  const totalDeductions = epfEmployee + esiEmployee + pt + tds;
  const employerTotal = epfEmployer + epsEmployer + edli + epfAdmin + esiEmployer;

  const methodology: string[] = [
    `Gross wages ${formatInr(gross)} = basic ${formatInr(e.basic)} + DA ${formatInr(e.dearnessAllowance ?? 0)} + HRA ${formatInr(e.hra ?? 0)} + other ${formatInr(e.otherAllowances ?? 0)}.`,
    `EPF wages ${formatInr(epfWages)}${cfg.epfOnActualWages ? " (actual wages, ceiling opted out)" : ` (capped at ceiling ${formatInr(cfg.epfWageCeiling)})`}: employee ${cfg.epfRatePct}% = ${formatInr(epfEmployee)}; employer ${cfg.epfRatePct}% split EPS ${cfg.epsRatePct}% of ${formatInr(epsWages)} = ${formatInr(epsEmployer)} + EPF ${formatInr(epfEmployer)}; EDLI ${formatInr(edli)}; admin ${formatInr(epfAdmin)}.`,
    esiApplicable
      ? `ESI applies (gross ${formatInr(gross)} ≤ ceiling ${formatInr(cfg.esiWageCeiling)}): employee ${cfg.esiEmployeeRatePct}% = ${formatInr(esiEmployee)}, employer ${cfg.esiEmployerRatePct}% = ${formatInr(esiEmployer)}.`
      : `ESI does not apply: gross ${formatInr(gross)} exceeds the ceiling ${formatInr(cfg.esiWageCeiling)}.`,
    `Professional tax ${formatInr(pt)} from the caller-supplied state table.`,
    `TDS u/s 192: annual taxable salary ${formatInr(annualSalary)} under "${input.regime.label}" (${input.regime.ay}) → tax ${formatInr(tax.totalTax)} ÷ ${months} month(s) = ${formatInr(tds)}.`,
    `Net pay ${formatInr(gross - totalDeductions)} after total deductions ${formatInr(totalDeductions)}.`,
  ];

  return {
    employeeId: e.employeeId,
    name: e.name,
    month: input.month,
    gross,
    epfWages,
    esiApplicable,
    deductions: {
      epfEmployee,
      esiEmployee,
      professionalTax: pt,
      tds,
      total: totalDeductions,
    },
    employerCosts: {
      epfEmployer,
      epsEmployer,
      edli,
      epfAdmin,
      esiEmployer,
      total: employerTotal,
    },
    netPay: gross - totalDeductions,
    tdsAnnualTax: tax.totalTax,
    methodology,
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface PayrollRegister {
  month: string;
  payslips: Payslip[];
  totals: {
    gross: number;
    netPay: number;
    epfEmployee: number;
    epfEmployer: number;
    epsEmployer: number;
    edli: number;
    epfAdmin: number;
    esiEmployee: number;
    esiEmployer: number;
    professionalTax: number;
    tds: number;
    /** Gross + employer costs — the true P&L charge. */
    totalCost: number;
  };
  methodology: string[];
}

/** Compute a whole payroll register for the month. */
export function payrollRegister(input: {
  month: string;
  employees: EmployeeWages[];
  regime: TaxRegime;
  /** Annual taxable salary overrides keyed by employeeId. */
  annualSalaries?: Record<string, number>;
  /** Months remaining in the FY for the TDS spread. Default 12. */
  monthsRemaining?: number;
  config?: Partial<PayrollConfig>;
}): PayrollRegister {
  const payslips = input.employees.map((employee) =>
    computePayslip({
      employee,
      month: input.month,
      regime: input.regime,
      annualTaxableSalary: input.annualSalaries?.[employee.employeeId],
      monthsRemaining: input.monthsRemaining,
      config: input.config,
    }),
  );

  const sum = (f: (p: Payslip) => number) => payslips.reduce((s, p) => s + f(p), 0);
  const gross = sum((p) => p.gross);
  const totalCost = gross + sum((p) => p.employerCosts.total);

  return {
    month: input.month,
    payslips,
    totals: {
      gross,
      netPay: sum((p) => p.netPay),
      epfEmployee: sum((p) => p.deductions.epfEmployee),
      epfEmployer: sum((p) => p.employerCosts.epfEmployer),
      epsEmployer: sum((p) => p.employerCosts.epsEmployer),
      edli: sum((p) => p.employerCosts.edli),
      epfAdmin: sum((p) => p.employerCosts.epfAdmin),
      esiEmployee: sum((p) => p.deductions.esiEmployee),
      esiEmployer: sum((p) => p.employerCosts.esiEmployer),
      professionalTax: sum((p) => p.deductions.professionalTax),
      tds: sum((p) => p.deductions.tds),
      totalCost,
    },
    methodology: [
      `${payslips.length} payslip(s) for ${input.month}; statutory ceilings/rates are the caller's config (defaults labelled FY 2025-26).`,
      `Total employer cost ${formatInr(totalCost)} = gross ${formatInr(gross)} + employer contributions and charges.`,
    ],
  };
}

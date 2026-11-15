/** Advance tax computation engine - instalment schedule, interest u/s 234B/234C/234A */

export class AdvanceTaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvanceTaxError";
  }
}

import { formatInr, type TaxRegime } from "./india-tax";

export interface AdvanceInstallment {
  label: string;
  dueDate: string;
  cumulativePct: number;
  interestMonths: number;
}

export const INDIVIDUAL_INSTALLMENTS: AdvanceInstallment[] = [
  { label: "1st instalment (by 15 June)", dueDate: "06-15", cumulativePct: 15, interestMonths: 3 },
  { label: "2nd instalment (by 15 September)", dueDate: "09-15", cumulativePct: 45, interestMonths: 3 },
  { label: "3rd instalment (by 15 December)", dueDate: "12-15", cumulativePct: 75, interestMonths: 3 },
  { label: "4th instalment (by 15 March)", dueDate: "03-15", cumulativePct: 100, interestMonths: 0 },
];

export const COMPANY_INSTALLMENTS: AdvanceInstallment[] = [
  { label: "1st instalment (by 15 June)", dueDate: "06-15", cumulativePct: 15, interestMonths: 3 },
  { label: "2nd instalment (by 15 September)", dueDate: "09-15", cumulativePct: 45, interestMonths: 3 },
  { label: "3rd instalment (by 15 December)", dueDate: "12-15", cumulativePct: 75, interestMonths: 3 },
  { label: "4th instalment (by 15 March)", dueDate: "03-15", cumulativePct: 100, interestMonths: 0 },
];

export interface AdvanceTaxComputation {
  clientName: string;
  fy: string;
  regime: TaxRegime;
  totalTax: number;
  advanceTaxPaid: number;
  installments: Array<{
    label: string;
    dueDate: string;
    targetAmount: number;
    shortfall: number;
    interest234C: number;
  }>;
  interest234C: number;
  interest234B: number;
  interest234A: number;
  totalInterestExposure: number;
  payNow: number;
  warnings: string[];
  methodology: string[];
}

export function advanceTaxAdvice(opts: {
  clientName: string;
  fy: string;
  regime: TaxRegime;
  totalTax: number;
  advanceTaxPaid: number;
  referenceDate: string;
  filingDueDate?: string;
  selfAssessmentTax?: number;
}): AdvanceTaxComputation {
  const startYear = Number(opts.fy.slice(0, 4));
  if (!Number.isFinite(startYear) || !/^\d{4}-\d{2}$/.test(opts.fy)) {
    throw new AdvanceTaxError(`fy must look like "2025-26"; got "${opts.fy}".`);
  }
  const totalTax = Math.max(0, Math.round(opts.totalTax));
  const paid = Math.max(0, Math.round(opts.advanceTaxPaid));
  const installments = INDIVIDUAL_INSTALLMENTS;

  const targetAmounts: number[] = installments.map((inst) => {
    const t = Math.round((totalTax * inst.cumulativePct) / 100);
    return t;
  });

  const refMs = new Date(`${opts.referenceDate}T00:00:00Z`).getTime();
  const calcInstallments: Array<{
    label: string;
    dueDate: string;
    targetAmount: number;
    shortfall: number;
    interest234C: number;
  }> = installments.map((inst, i) => {
    const dueDate = `${startYear}-${inst.dueDate}`;
    const dueMs = new Date(`${dueDate}T00:00:00Z`).getTime();
    const target = targetAmounts[i] ?? 0;
    const pastDue = dueMs < refMs;
    const paidByDueDate = pastDue ? paid : Math.min(paid, target);
    const shortfall = Math.max(0, target - paidByDueDate);
    return {
      label: inst.label,
      dueDate,
      targetAmount: target,
      shortfall,
      interest234C: pastDue ? Math.round((shortfall * 1 * inst.interestMonths) / 100) : 0,
    };
  });

  const interest234C = calcInstallments.reduce((s, i) => s + i.interest234C, 0);

  const fyStartMs = new Date(`${startYear}-04-01T00:00:00Z`).getTime();
  const fyEndMs = new Date(`${startYear + 1}-03-31T00:00:00Z`).getTime();
  const endMs = Math.min(refMs, fyEndMs);
  const ninetyPct = Math.round(totalTax * 0.9);
  const shortfall234B = Math.max(0, ninetyPct - paid);
  const interestMonths234B = Math.max(0, Math.round((endMs - fyStartMs) / 86_400_000 / 30));
  const interest234B = Math.round((shortfall234B * 1 * interestMonths234B) / 100);

  let interest234A = 0;
  if (opts.filingDueDate && opts.selfAssessmentTax !== undefined) {
    const dueMs = new Date(`${opts.filingDueDate}T00:00:00Z`).getTime();
    if (dueMs < refMs) {
      const delayMonths = Math.max(0, Math.round((refMs - dueMs) / 86_400_000 / 30));
      interest234A = Math.round((opts.selfAssessmentTax * 1 * delayMonths) / 100);
    }
  }

  const totalInterestExposure = interest234C + interest234B + interest234A;
  const payNow = Math.max(0, ninetyPct - paid);

  const warnings: string[] = [];
  if (interest234C > 0) {
    warnings.push(`234C deferment interest ${formatInr(interest234C)} has accrued on missed instalment targets.`);
  }
  if (interest234B > 0) {
    warnings.push(
      `234B shortfall interest ${formatInr(interest234B)} is accruing - pay ${formatInr(payNow)} before 31 March to stop it.`,
    );
  }
  if (interest234A > 0) {
    warnings.push(
      `234A filing-delay interest ${formatInr(interest234A)} is accruing - file and pay the self-assessment tax.`,
    );
  }
  if (paid < totalTax && endMs >= fyEndMs) {
    warnings.push(
      `FY ended and advance tax paid ${formatInr(paid)} < total tax ${formatInr(totalTax)} - self-assessment tax must be paid with the return.`,
    );
  }

  return {
    clientName: opts.clientName,
    fy: opts.fy,
    regime: opts.regime,
    totalTax,
    advanceTaxPaid: paid,
    installments: calcInstallments,
    interest234C,
    interest234B,
    interest234A,
    totalInterestExposure,
    payNow,
    warnings,
    methodology: [
      `Advancetax computation for ${opts.clientName}, FY ${opts.fy}, under "${opts.regime.label}" (${opts.regime.ay}).`,
      `Total tax ${formatInr(totalTax)}; advance tax paid ${formatInr(paid)}.`,
      `234C: ${formatInr(interest234C)}; 234B: ${formatInr(interest234B)}; 234A: ${formatInr(interest234A)}; total exposure ${formatInr(totalInterestExposure)}.`,
      `Additional advance tax to pay now (to stop 234B): ${formatInr(payNow)}.`,
    ],
  };
}

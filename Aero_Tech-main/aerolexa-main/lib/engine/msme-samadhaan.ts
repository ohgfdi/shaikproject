/** MSME Samadhaan delayed payment tracking for Indian MSMEs */

import { formatInr } from "./india-tax";

export class MsmeSamadhaanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsmeSamadhaanError";
  }
}

export type MsmeCategory = "micro" | "small" | "medium" | "not-msme";

export interface MsmeThresholds {
  micro: { investmentUpTo: number; turnoverUpTo: number };
  small: { investmentUpTo: number; turnoverUpTo: number };
  medium: { investmentUpTo: number; turnoverUpTo: number };
}

export const UDYAM_THRESHOLDS: MsmeThresholds = {
  micro: { investmentUpTo: 10_00_000, turnoverUpTo: 50_00_000 },
  small: { investmentUpTo: 1_00_00_000, turnoverUpTo: 5_00_00_000 },
  medium: { investmentUpTo: 5_00_00_000, turnoverUpTo: 25_00_00_000 },
};

export function classifyMsme(investment: number, turnover: number): MsmeCategory {
  const inv = Math.max(0, investment);
  const turn = Math.max(0, turnover);

  if (inv <= UDYAM_THRESHOLDS.micro.investmentUpTo && turn <= UDYAM_THRESHOLDS.micro.turnoverUpTo) return "micro";
  if (inv <= UDYAM_THRESHOLDS.small.investmentUpTo && turn <= UDYAM_THRESHOLDS.small.turnoverUpTo) return "small";
  if (inv <= UDYAM_THRESHOLDS.medium.investmentUpTo && turn <= UDYAM_THRESHOLDS.medium.turnoverUpTo) return "medium";
  return "not-msme";
}

export function isMsmeForDelayedPayment(micro: boolean, small: boolean): boolean {
  return micro || small;
}

export interface MsmeSupplier {
  udyamNumber?: string | null;
  name: string;
  micro: boolean;
  small: boolean;
  medium: boolean;
  category: MsmeCategory;
  pan?: string | null;
  gstin?: string | null;
  interestRatePct: number;
  registrationDate?: string | null;
}

export interface MsmeInvoice {
  number: string;
  invoiceDate: string;
  dueDate: string;
  paymentDate?: string | null;
  amount: number;
  status: "unpaid" | "paid-on-time" | "paid-late";
  udyamNumber?: string | null;
  pan?: string | null;
}

export interface MsmeSupplierExposure {
  supplier: MsmeSupplier;
  invoices: MsmeInvoice[];
  totalOutstanding: number;
  totalDisallowed43bh: number;
  totalInterestLiability: number;
  invoicesDelayed: number;
  oldestInvoiceDate: string | null;
}

export interface MsmeSamadhaanReport {
  reportDate: string;
  supplierExposures: MsmeSupplierExposure[];
  totals: {
    totalOutstanding: number;
    totalDisallowed43bh: number;
    totalInterestLiability: number;
    totalSuppliers: number;
    totalInvoices: number;
    invoicesDelayed: number;
    invoicesPaidOnTime: number;
    invoicesPaidLate: number;
    invoicesUnpaid: number;
  };
  urgentCases: { supplierName: string; amount: number; daysDelayed: number; invoiceNumber: string; dueDate: string }[];
  warnings: string[];
  methodology: string[];
}

export function computeMsmeSamadhaanReport(opts: {
  suppliers: MsmeSupplier[];
  invoices: MsmeInvoice[];
  referenceDate: string;
}): MsmeSamadhaanReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.referenceDate)) {
    throw new MsmeSamadhaanError(`referenceDate must be yyyy-mm-dd.`);
  }

  const refMs = new Date(`${opts.referenceDate}T00:00:00Z`).getTime();

  let totalOutstanding = 0;
  let totalDisallowed = 0;
  let totalInterest = 0;
  let totalSuppliers = 0;
  let totalInvoices = 0;
  let invoicesDelayed = 0;
  let invoicesOnTime = 0;
  let invoicesPaidLate = 0;
  let invoicesUnpaid = 0;
  const urgentCases: MsmeSamadhaanReport["urgentCases"] = [];
  const supplierExposures: MsmeSamadhaanReport["supplierExposures"] = [];

  for (const supplier of opts.suppliers) {
    const supplierInvoices = opts.invoices.filter(
      (inv) =>
        inv.udyamNumber === supplier.udyamNumber || inv.number.toLowerCase().includes(supplier.name.toLowerCase()),
    );
    if (supplierInvoices.length === 0) continue;

    totalSuppliers++;
    let supplierOutstanding = 0;
    let supplierDisallowed = 0;
    let supplierInterest = 0;
    const supplierDelayed = 0;
    const oldestDate: string | null = null;

    for (const inv of supplierInvoices) {
      totalInvoices++;
      const dueMs = new Date(`${inv.dueDate}T00:00:00Z`).getTime();

      let daysDelayed = 0;
      if (inv.paymentDate) {
        const paidMs = new Date(`${inv.paymentDate}T00:00:00Z`).getTime();
        if (paidMs <= dueMs) invoicesOnTime++;
        else invoicesPaidLate++;
        daysDelayed = Math.max(0, Math.round((paidMs - dueMs) / 86_400_000));
      } else {
        daysDelayed = Math.max(0, Math.round((refMs - dueMs) / 86_400_000));
        invoicesUnpaid++;
        supplierOutstanding += inv.amount;
      }

      if (daysDelayed > 45) invoicesDelayed++;
      if (daysDelayed > 60) {
        urgentCases.push({
          supplierName: supplier.name,
          amount: inv.amount,
          daysDelayed,
          invoiceNumber: inv.number,
          dueDate: inv.dueDate,
        });
      }

      if (daysDelayed > 45 && inv.status === "unpaid") supplierDisallowed += inv.amount;

      const interestDays = Math.max(0, daysDelayed - 45);
      if (interestDays > 0) {
        supplierInterest += Math.round((inv.amount * supplier.interestRatePct * interestDays) / (100 * 365));
      }
    }

    totalOutstanding += supplierOutstanding;
    totalDisallowed += supplierDisallowed;
    totalInterest += supplierInterest;

    supplierExposures.push({
      supplier,
      invoices: supplierInvoices,
      totalOutstanding: supplierOutstanding,
      totalDisallowed43bh: supplierDisallowed,
      totalInterestLiability: supplierInterest,
      invoicesDelayed: supplierDelayed,
      oldestInvoiceDate: oldestDate,
    });
  }

  supplierExposures.sort((a, b) => (b.totalOutstanding || 0) - (a.totalOutstanding || 0));
  urgentCases.sort((a, b) => b.daysDelayed - a.daysDelayed);

  const warnings: string[] = [];
  if (urgentCases.length > 0) {
    warnings.push(`${urgentCases.length} invoice(s) over 60 days delayed - escalate urgently.`);
  }
  if (totalDisallowed > 0) {
    warnings.push(`Total 43B(h) disallowance: ${formatInr(totalDisallowed)} - add back to taxable income.`);
  }
  if (totalInterest > 0) {
    warnings.push(`Total interest u/s 16: ${formatInr(totalInterest)} - pay to avoid further accrual.`);
  }

  return {
    reportDate: opts.referenceDate,
    supplierExposures,
    totals: {
      totalOutstanding,
      totalDisallowed43bh: totalDisallowed,
      totalInterestLiability: totalInterest,
      totalSuppliers,
      totalInvoices,
      invoicesDelayed,
      invoicesPaidOnTime: invoicesOnTime,
      invoicesPaidLate: invoicesPaidLate,
      invoicesUnpaid: invoicesUnpaid,
    },
    urgentCases,
    warnings,
    methodology: [
      `MSME Samadhaan report as at ${opts.referenceDate}: ${totalSuppliers} supplier(s), ${totalInvoices} invoice(s).`,
      `Outstanding payments: ${formatInr(totalOutstanding)}.`,
      `Delayed beyond 45 days: ${invoicesDelayed} invoice(s), disallowed under 43B(h): ${formatInr(totalDisallowed)}.`,
      `Interest liability u/s 16: ${formatInr(totalInterest)}.`,
      `${urgentCases.length} urgent case(s) over 60 days.`,
    ],
  };
}

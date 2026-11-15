/**
 * Payroll practice operations — API adapter.
 *
 * `ca-payroll-operations.ts` is the employee-master + monthly-run + statutory +
 * reconciliation engine; it speaks in MINOR UNITS (paise). This module makes it
 * reachable from `POST /api/ca/compute` under `kind: "payroll-operations"`: it
 * validates an op-shaped payload with Zod and converts the API's RUPEES-as-
 * decimals into integer PAISE, matching every other CA engine.
 *
 * Kept as a pure, exported dispatcher (rather than inline in the route) so the
 * rupee→paise conversion on the nested employee master and run lines is
 * unit-testable without a server or a database.
 */

import { z } from "zod";

import {
  bonusEligibility,
  buildCorrectionRun,
  buildDisbursementFile,
  completedServiceYears,
  computeRunLine,
  gratuityAccrual,
  inspectionReadiness,
  investmentProofStatus,
  leaveEncashment,
  matchPfContribution,
  minimumWageCompliance,
  payslipIssuanceStatus,
  prepareEcr,
  prepareEsiReturn,
  preparePtReturn,
  reconcilePayrollToTds,
  reconcilePayrollTotalsToBooks,
  reconcileStatutoryComponents,
  recordProof,
  requiredLabourReturns,
  requiredRegisters,
  validateEmployeeProfile,
  validateMonthlyInputs,
  type EmployeeProfile,
  type EsiConfig,
  type MonthlyInputLine,
  type PfConfig,
  type ProofCollection,
} from "./ca-payroll-operations";

/** Rupee amount (major units) as it arrives over the API. */
const rupees = z.number().finite().safe();
const positiveRupees = rupees.positive();
/** Convert rupees (major) to paise (minor), the engine's unit. */
const paise = (n: number) => Math.round(n * 100);

const employmentStatus = z.enum(["active", "resigned", "terminated", "retired", "absconding"]);

const bankDetails = z.object({
  accountNumber: z.string().min(1),
  ifsc: z.string().min(1),
  accountHolder: z.string().min(1),
});

/** Employee master in RUPEES (gross/basic monthly); the dispatcher stores paise. */
const employeeProfile = z.object({
  employeeId: z.string().min(1),
  name: z.string().min(1),
  status: employmentStatus,
  dateOfJoining: z.string().min(1),
  dateOfExit: z.string().nullish(),
  uan: z.string().nullish(),
  esicNumber: z.string().nullish(),
  aadhaarLinked: z.boolean(),
  pan: z.string().nullish(),
  bank: bankDetails.nullish(),
  pfEcsMapping: z.string().nullish(),
  department: z.string(),
  designation: z.string(),
  state: z.string(),
  establishmentEmployeeCount: z.number().int().nonnegative(),
  grossMonthly: positiveRupees,
  basicMonthly: positiveRupees,
});

/** A month's input line in RUPEES. */
const monthlyLine = z.object({
  employeeId: z.string().min(1),
  paidDays: z.number().finite(),
  lopDays: z.number().finite(),
  overtimeHours: z.number().finite(),
  overtimeRatePerHour: rupees,
  bonus: rupees,
  arrear: rupees,
  advanceRecovery: rupees,
  advanceOutstanding: rupees,
});

const establishmentProfile = z.object({
  state: z.string(),
  employeeCount: z.number().int().nonnegative(),
  employsContractLabour: z.boolean(),
  employsWomen: z.boolean(),
  hasOvertime: z.boolean(),
  isShopsEstablishment: z.boolean(),
});

const proofLine = z.object({
  section: z.string().min(1),
  required: rupees,
  collected: rupees,
  status: z.enum(["pending", "partial", "collected"]),
});

/** PF configuration in RUPEES ceilings. */
const pfConfig = z.object({
  wageCeiling: positiveRupees,
  employeeRatePct: z.number().finite(),
  employerRatePct: z.number().finite(),
  epsRatePct: z.number().finite(),
  edliRatePct: z.number().finite(),
  edliWageCeiling: positiveRupees,
});

/** ESI configuration in RUPEES ceiling. */
const esiConfig = z.object({
  wageCeiling: positiveRupees,
  employeeRatePct: z.number().finite(),
  employerRatePct: z.number().finite(),
});

// ---------------------------------------------------------------------------
// rupee → paise conversion
// ---------------------------------------------------------------------------

function toEmployeeProfile(input: z.infer<typeof employeeProfile>): EmployeeProfile {
  return {
    employeeId: input.employeeId,
    name: input.name,
    status: input.status,
    dateOfJoining: input.dateOfJoining,
    dateOfExit: input.dateOfExit ?? null,
    uan: input.uan ?? null,
    esicNumber: input.esicNumber ?? null,
    aadhaarLinked: input.aadhaarLinked,
    pan: input.pan ?? null,
    bank: input.bank ?? null,
    pfEcsMapping: input.pfEcsMapping ?? null,
    department: input.department,
    designation: input.designation,
    state: input.state,
    establishmentEmployeeCount: input.establishmentEmployeeCount,
    grossMonthlyMinor: paise(input.grossMonthly),
    basicMonthlyMinor: paise(input.basicMonthly),
  };
}

function toMonthlyLine(input: z.infer<typeof monthlyLine>): MonthlyInputLine {
  return {
    employeeId: input.employeeId,
    paidDays: input.paidDays,
    lopDays: input.lopDays,
    overtimeHours: input.overtimeHours,
    overtimeRatePerHourMinor: paise(input.overtimeRatePerHour),
    bonusMinor: paise(input.bonus),
    arrearMinor: paise(input.arrear),
    advanceRecoveryMinor: paise(input.advanceRecovery),
    advanceOutstandingMinor: paise(input.advanceOutstanding),
  };
}

function toProof(input: z.infer<typeof proofLine>): ProofCollection {
  return {
    section: input.section,
    requiredMinor: paise(input.required),
    collectedMinor: paise(input.collected),
    status: input.status,
  };
}

function toPfConfig(input: z.infer<typeof pfConfig>): PfConfig {
  return {
    wageCeilingMinor: paise(input.wageCeiling),
    employeeRatePct: input.employeeRatePct,
    employerRatePct: input.employerRatePct,
    epsRatePct: input.epsRatePct,
    edliRatePct: input.edliRatePct,
    edliWageCeilingMinor: paise(input.edliWageCeiling),
  };
}

function toEsiConfig(input: z.infer<typeof esiConfig>): EsiConfig {
  return {
    wageCeilingMinor: paise(input.wageCeiling),
    employeeRatePct: input.employeeRatePct,
    employerRatePct: input.employerRatePct,
  };
}

/** The discriminated union the route parses. Money fields are RUPEES. */
export const payrollOperationsInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("validate-employee"), profile: employeeProfile }),
  z.object({ op: z.literal("service-years"), profile: employeeProfile, asOf: z.string() }),
  z.object({ op: z.literal("gratuity"), profile: employeeProfile, lastDrawnMonthly: rupees, asOf: z.string() }),
  z.object({ op: z.literal("leave-encashment"), leaveBalanceDays: z.number().finite(), dailyWage: rupees }),
  z.object({
    op: z.literal("bonus"),
    grossMonthly: rupees,
    eligibilityCeiling: rupees,
    monthsWorked: z.number().finite(),
  }),
  z.object({
    op: z.literal("proof-status"),
    declaration: z.object({
      employeeId: z.string().min(1),
      financialYear: z.string(),
      regime: z.enum(["old", "new"]),
      section80C: rupees,
      section80CCD1B: rupees,
      section80D: rupees,
      section80TTA: rupees,
      houseRentPaidAnnual: rupees,
      homeLoanInterestAnnual: rupees,
      declaredAt: z.string(),
    }),
  }),
  z.object({ op: z.literal("record-proof"), proofs: z.array(proofLine), section: z.string().min(1), received: rupees }),

  z.object({ op: z.literal("validate-run"), lines: z.array(monthlyLine), employees: z.array(employeeProfile) }),
  z.object({ op: z.literal("run-line"), line: monthlyLine, monthlyGross: rupees }),
  z.object({
    op: z.literal("correction-run"),
    originalPeriod: z.string(),
    correctionPeriod: z.string(),
    corrections: z.array(z.object({ employeeId: z.string().min(1), difference: rupees, reason: z.string() })),
  }),
  z.object({
    op: z.literal("disbursement-file"),
    netPay: z.array(z.object({ employeeId: z.string().min(1), netPay: rupees })),
    employees: z.array(employeeProfile),
  }),
  z.object({ op: z.literal("payslip-status"), employees: z.array(employeeProfile), issued: z.array(z.string()) }),

  z.object({
    op: z.literal("prepare-ecr"),
    employees: z.array(
      z.object({
        uan: z.string().nullish(),
        name: z.string(),
        grossWages: rupees,
        pfWages: rupees,
        ncpDays: z.number().finite(),
      }),
    ),
    config: pfConfig.optional(),
  }),
  z.object({
    op: z.literal("prepare-esi"),
    employees: z.array(z.object({ esicNumber: z.string().nullish(), name: z.string(), grossWages: rupees })),
    config: esiConfig.optional(),
  }),
  z.object({
    op: z.literal("match-pf"),
    remittedEmployee: rupees,
    remittedEmployer: rupees,
    computedEmployee: rupees,
    computedEmployer: rupees,
  }),
  z.object({
    op: z.literal("pt-return"),
    stateCode: z.string().min(1),
    lines: z.array(z.object({ employeeId: z.string().min(1), pt: rupees })),
  }),
  z.object({
    op: z.literal("inspection-readiness"),
    items: z.array(z.object({ document: z.string(), available: z.boolean(), mandatory: z.boolean() })),
  }),

  z.object({ op: z.literal("registers"), profile: establishmentProfile }),
  z.object({ op: z.literal("labour-returns"), profile: establishmentProfile }),
  z.object({
    op: z.literal("minimum-wage"),
    lines: z.array(z.object({ employeeId: z.string().min(1), paidMonthly: rupees, applicableMinimum: rupees })),
  }),

  z.object({ op: z.literal("reconcile-books"), payrollNet: rupees, booksNet: rupees }),
  z.object({ op: z.literal("reconcile-tds"), deducted: rupees, deposited: rupees }),
  z.object({
    op: z.literal("reconcile-statutory"),
    components: z.array(z.object({ component: z.enum(["pf", "esi", "pt"]), computed: rupees, remitted: rupees })),
  }),
]);

export type PayrollOperationsRequest = z.infer<typeof payrollOperationsInput>;

/** Dispatch a validated op to the engine, converting rupee money fields to paise. */
export function computePayrollOperations(input: PayrollOperationsRequest): unknown {
  switch (input.op) {
    case "validate-employee":
      return validateEmployeeProfile(toEmployeeProfile(input.profile));

    case "service-years":
      return { years: completedServiceYears(toEmployeeProfile(input.profile), input.asOf) };

    case "gratuity":
      return gratuityAccrual(toEmployeeProfile(input.profile), paise(input.lastDrawnMonthly), input.asOf);

    case "leave-encashment":
      return { amountMinor: leaveEncashment(input.leaveBalanceDays, paise(input.dailyWage)) };

    case "bonus":
      return bonusEligibility({
        grossMonthlyMinor: paise(input.grossMonthly),
        eligibilityCeilingMinor: paise(input.eligibilityCeiling),
        monthsWorked: input.monthsWorked,
      });

    case "proof-status": {
      const d = input.declaration;
      return investmentProofStatus({
        employeeId: d.employeeId,
        financialYear: d.financialYear,
        regime: d.regime,
        section80C: paise(d.section80C),
        section80CCD1B: paise(d.section80CCD1B),
        section80D: paise(d.section80D),
        section80TTA: paise(d.section80TTA),
        houseRentPaidAnnual: paise(d.houseRentPaidAnnual),
        homeLoanInterestAnnual: paise(d.homeLoanInterestAnnual),
        declaredAt: d.declaredAt,
      });
    }

    case "record-proof":
      return recordProof(input.proofs.map(toProof), input.section, paise(input.received));

    case "validate-run":
      return validateMonthlyInputs(input.lines.map(toMonthlyLine), input.employees.map(toEmployeeProfile));

    case "run-line":
      return computeRunLine(toMonthlyLine(input.line), paise(input.monthlyGross));

    case "correction-run":
      return buildCorrectionRun({
        originalPeriod: input.originalPeriod,
        correctionPeriod: input.correctionPeriod,
        corrections: input.corrections.map((c) => ({
          employeeId: c.employeeId,
          differenceMinor: paise(c.difference),
          reason: c.reason,
        })),
      });

    case "disbursement-file":
      return buildDisbursementFile(
        input.netPay.map((p) => ({ employeeId: p.employeeId, netPayMinor: paise(p.netPay) })),
        input.employees.map(toEmployeeProfile),
      );

    case "payslip-status":
      return payslipIssuanceStatus(input.employees.map(toEmployeeProfile), input.issued);

    case "prepare-ecr":
      return prepareEcr(
        input.employees.map((e) => ({
          uan: e.uan ?? null,
          name: e.name,
          grossWagesMinor: paise(e.grossWages),
          pfWagesMinor: paise(e.pfWages),
          ncpDays: e.ncpDays,
        })),
        input.config ? toPfConfig(input.config) : undefined,
      );

    case "prepare-esi":
      return prepareEsiReturn(
        input.employees.map((e) => ({
          esicNumber: e.esicNumber ?? null,
          name: e.name,
          grossWagesMinor: paise(e.grossWages),
        })),
        input.config ? toEsiConfig(input.config) : undefined,
      );

    case "match-pf":
      return matchPfContribution({
        remittedEmployeeMinor: paise(input.remittedEmployee),
        remittedEmployerMinor: paise(input.remittedEmployer),
        computedEmployeeMinor: paise(input.computedEmployee),
        computedEmployerMinor: paise(input.computedEmployer),
      });

    case "pt-return":
      return preparePtReturn(
        input.stateCode,
        input.lines.map((l) => ({ employeeId: l.employeeId, ptMinor: paise(l.pt) })),
      );

    case "inspection-readiness":
      return inspectionReadiness(input.items);

    case "registers":
      return requiredRegisters(input.profile);

    case "labour-returns":
      return requiredLabourReturns(input.profile);

    case "minimum-wage":
      return minimumWageCompliance(
        input.lines.map((l) => ({
          employeeId: l.employeeId,
          paidMonthlyMinor: paise(l.paidMonthly),
          applicableMinimumMinor: paise(l.applicableMinimum),
        })),
      );

    case "reconcile-books":
      return reconcilePayrollTotalsToBooks({
        payrollNetMinor: paise(input.payrollNet),
        booksNetMinor: paise(input.booksNet),
      });

    case "reconcile-tds":
      return reconcilePayrollToTds({ deductedMinor: paise(input.deducted), depositedMinor: paise(input.deposited) });

    case "reconcile-statutory":
      return reconcileStatutoryComponents(
        input.components.map((c) => ({
          component: c.component,
          computedMinor: paise(c.computed),
          remittedMinor: paise(c.remitted),
        })),
      );
  }
}

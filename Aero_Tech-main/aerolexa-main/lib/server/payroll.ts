/**
 * Payroll — Employee masters, salary structures, monthly runs.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { computePayroll, type PayrollBreakup } from "@/lib/engine/ca-payroll";
import { stringifyJson } from "@/lib/json";
import { assertPeriodOpen } from "@/lib/server/period-locks";
import { voucherTotals } from "@/lib/server/voucher-fields";

export class PayrollStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "PayrollStoreError";
  }
}

export interface PayrollEmployeeInput {
  employeeCode: string;
  name: string;
  pan?: string | null;
  uan?: string | null;
  esiNumber?: string | null;
  aadhaar?: string | null;
  dateOfBirth?: string | null;
  dateOfJoining: string;
  dateOfLeaving?: string | null;
  gender?: string | null;
  category?: string | null;
  basic: number;
  da: number;
  hra: number;
  specialAllowance: number;
  otherAllowances: number;
  conveyance: number;
  medical: number;
  pfApplicable?: boolean;
  esiApplicable?: boolean;
  ptApplicable?: boolean;
  lwfApplicable?: boolean;
  voluntaryPf?: number;
  npsContribution?: number;
  bankAccount?: string | null;
  ifsc?: string | null;
  department?: string | null;
  designation?: string | null;
  status?: string;
}

export interface PayrollSalaryStructureInput {
  employeeId: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  basic: number;
  da: number;
  hra: number;
  specialAllowance: number;
  otherAllowances: number;
  conveyance: number;
  medical: number;
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
}

export interface PayrollRunInput {
  period: string; // yyyy-mm
  runDate: string;
  state?: string; // e.g. Maharashtra, Karnataka, Delhi, Tamil Nadu
  minimumWage?: { skilled: number; unskilled: number };
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new PayrollStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

// ---------------------------------------------------------------------------
// Employee Master
// ---------------------------------------------------------------------------

export async function createPayrollEmployee(
  workspaceId: string,
  bookId: string,
  input: PayrollEmployeeInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  const existing = await prisma.payrollEmployee.findUnique({
    where: { bookId_employeeCode: { bookId, employeeCode: input.employeeCode } },
  });
  if (existing) throw new PayrollStoreError(409, "DUPLICATE", `Employee code ${input.employeeCode} already exists.`);

  if (input.pan) {
    const existingPan = await prisma.payrollEmployee.findUnique({
      where: { bookId_pan: { bookId, pan: input.pan } },
    });
    if (existingPan) throw new PayrollStoreError(409, "DUPLICATE", `PAN ${input.pan} already registered.`);
  }

  const employee = await prisma.payrollEmployee.create({
    data: {
      bookId,
      employeeCode: input.employeeCode,
      name: input.name,
      pan: input.pan ?? null,
      uan: input.uan ?? null,
      esiNumber: input.esiNumber ?? null,
      aadhaar: input.aadhaar ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      dateOfJoining: input.dateOfJoining,
      dateOfLeaving: input.dateOfLeaving ?? null,
      gender: input.gender ?? null,
      category: input.category ?? null,
      basic: Math.round(input.basic),
      da: Math.round(input.da),
      hra: Math.round(input.hra),
      specialAllowance: Math.round(input.specialAllowance),
      otherAllowances: Math.round(input.otherAllowances),
      conveyance: Math.round(input.conveyance),
      medical: Math.round(input.medical),
      pfApplicable: input.pfApplicable ?? true,
      esiApplicable: input.esiApplicable ?? true,
      ptApplicable: input.ptApplicable ?? true,
      lwfApplicable: input.lwfApplicable ?? false,
      voluntaryPf: Math.round(input.voluntaryPf ?? 0),
      npsContribution: Math.round(input.npsContribution ?? 0),
      bankAccount: input.bankAccount ?? null,
      ifsc: input.ifsc ?? null,
      department: input.department ?? null,
      designation: input.designation ?? null,
      status: "active",
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollEmployee",
      entityId: employee.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return employee;
}

export async function listPayrollEmployees(workspaceId: string, bookId: string, opts: { status?: string } = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.payrollEmployee.findMany({
    where: { bookId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { employeeCode: "asc" },
  });
}

export async function getPayrollEmployee(workspaceId: string, bookId: string, employeeId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const employee = await prisma.payrollEmployee.findFirst({ where: { id: employeeId, bookId } });
  if (!employee) throw new PayrollStoreError(404, "NOT_FOUND", "Employee not found.");
  return employee;
}

export async function updatePayrollEmployee(
  workspaceId: string,
  bookId: string,
  employeeId: string,
  input: Partial<PayrollEmployeeInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.payrollEmployee.findFirst({ where: { id: employeeId, bookId } });
  if (!existing) throw new PayrollStoreError(404, "NOT_FOUND", "Employee not found.");

  const updated = await prisma.payrollEmployee.update({
    where: { id: employeeId },
    data: {
      employeeCode: input.employeeCode ?? undefined,
      name: input.name ?? undefined,
      pan: input.pan ?? undefined,
      uan: input.uan ?? undefined,
      esiNumber: input.esiNumber ?? undefined,
      aadhaar: input.aadhaar ?? undefined,
      dateOfBirth: input.dateOfBirth ?? undefined,
      dateOfJoining: input.dateOfJoining ?? undefined,
      dateOfLeaving: input.dateOfLeaving ?? undefined,
      gender: input.gender ?? undefined,
      category: input.category ?? undefined,
      basic: input.basic !== undefined ? Math.round(input.basic) : undefined,
      da: input.da !== undefined ? Math.round(input.da) : undefined,
      hra: input.hra !== undefined ? Math.round(input.hra) : undefined,
      specialAllowance: input.specialAllowance !== undefined ? Math.round(input.specialAllowance) : undefined,
      otherAllowances: input.otherAllowances !== undefined ? Math.round(input.otherAllowances) : undefined,
      conveyance: input.conveyance !== undefined ? Math.round(input.conveyance) : undefined,
      medical: input.medical !== undefined ? Math.round(input.medical) : undefined,
      pfApplicable: input.pfApplicable ?? undefined,
      esiApplicable: input.esiApplicable ?? undefined,
      ptApplicable: input.ptApplicable ?? undefined,
      lwfApplicable: input.lwfApplicable ?? undefined,
      voluntaryPf: input.voluntaryPf !== undefined ? Math.round(input.voluntaryPf) : undefined,
      npsContribution: input.npsContribution !== undefined ? Math.round(input.npsContribution) : undefined,
      bankAccount: input.bankAccount ?? undefined,
      ifsc: input.ifsc ?? undefined,
      department: input.department ?? undefined,
      designation: input.designation ?? undefined,
      status: input.status ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollEmployee",
      entityId: employeeId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deletePayrollEmployee(workspaceId: string, bookId: string, employeeId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.payrollEmployee.delete({ where: { id: employeeId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollEmployee",
      entityId: employeeId,
      action: "delete",
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Salary Structures
// ---------------------------------------------------------------------------

export async function createSalaryStructure(
  workspaceId: string,
  bookId: string,
  input: PayrollSalaryStructureInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  // Check employee exists
  await prisma.payrollEmployee.findFirstOrThrow({ where: { id: input.employeeId, bookId } });

  const existing = await prisma.payrollSalaryStructure.findUnique({
    where: { employeeId_effectiveFrom: { employeeId: input.employeeId, effectiveFrom: input.effectiveFrom } },
  });
  if (existing)
    throw new PayrollStoreError(409, "DUPLICATE", `Salary structure for ${input.effectiveFrom} already exists.`);

  const structure = await prisma.payrollSalaryStructure.create({
    data: {
      bookId,
      employeeId: input.employeeId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      basic: Math.round(input.basic),
      da: Math.round(input.da),
      hra: Math.round(input.hra),
      specialAllowance: Math.round(input.specialAllowance),
      otherAllowances: Math.round(input.otherAllowances),
      conveyance: Math.round(input.conveyance),
      medical: Math.round(input.medical),
      pfEmployee: Math.round(input.pfEmployee),
      pfEmployer: Math.round(input.pfEmployer),
      eps: Math.round(input.eps),
      edli: Math.round(input.edli),
      pfAdmin: Math.round(input.pfAdmin),
      esiEmployee: Math.round(input.esiEmployee),
      esiEmployer: Math.round(input.esiEmployer),
      professionalTax: Math.round(input.professionalTax),
      lwf: Math.round(input.lwf),
      tds: Math.round(input.tds),
      otherDeductions: Math.round(input.otherDeductions),
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollSalaryStructure",
      entityId: structure.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return structure;
}

export async function listSalaryStructures(workspaceId: string, bookId: string, employeeId?: string) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.payrollSalaryStructure.findMany({
    where: { bookId, ...(employeeId ? { employeeId } : {}) },
    orderBy: { effectiveFrom: "desc" },
    include: { employee: true },
  });
}

// ---------------------------------------------------------------------------
// Payroll Runs
// ---------------------------------------------------------------------------

const DEFAULT_PT_MONTHLY_BY_STATE = {
  Maharashtra: 200,
  Karnataka: 200,
  Delhi: 0,
  TamilNadu: 200,
  Gujarat: 150,
  WestBengal: 180,
  UP: 150,
  MadhyaPradesh: 150,
  Kerala: 200,
  Rajasthan: 180,
  Goa: 100,
  default: 0,
};

export function getPtMonthlyByState(state: keyof typeof DEFAULT_PT_MONTHLY_BY_STATE): number {
  return DEFAULT_PT_MONTHLY_BY_STATE[state] ?? DEFAULT_PT_MONTHLY_BY_STATE.default;
}

export async function createPayrollRun(workspaceId: string, bookId: string, input: PayrollRunInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const existing = await prisma.payrollRun.findUnique({
    where: { bookId_period: { bookId, period: input.period } },
  });
  if (existing) throw new PayrollStoreError(409, "DUPLICATE", `Payroll run for ${input.period} already exists.`);

  const run = await prisma.payrollRun.create({
    data: {
      bookId,
      period: input.period,
      runDate: input.runDate,
      status: "draft",
      pfWageCeiling: 15_000,
      esiWageCeiling: 21_000,
      state: input.state ?? "Maharashtra",
      // Professional tax monthly by Indian state (configurable via DEFAULT_PT_MONTHLY_BY_STATE).
      // Override with LEDGERLY_PT_MONTHLY_BY_STATE env var if set (JSON map of state→amount in rupees).
      // @ts-expect-error: Env var may not be set
      ptMonthlyByState: {
        Maharashtra: 200,
        Karnataka: 200,
        Delhi: 0,
        TamilNadu: 200,
        Gujarat: 150,
        WestBengal: 180,
        UP: 150,
        MadhyaPradesh: 150,
        Kerala: 200,
        Rajasthan: 180,
        Goa: 100,
        ...(async () => {
          const envJson = process.env.LEDGERLY_PT_MONTHLY_BY_STATE;
          if (!envJson) return {};
          try {
            return JSON.parse(envJson);
          } catch {
            return {};
          }
        })(),
      },
      ptMonthly: getPtMonthlyByState((input.state ?? "Maharashtra") as keyof typeof DEFAULT_PT_MONTHLY_BY_STATE),
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollRun",
      entityId: run.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return run;
}

export async function listPayrollRuns(workspaceId: string, bookId: string, opts: { status?: string } = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.payrollRun.findMany({
    where: { bookId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { period: "desc" },
    include: { _count: { select: { employees: true } } },
  });
}

export async function getPayrollRun(workspaceId: string, bookId: string, runId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, bookId },
    include: {
      employees: { include: { employee: true } },
    },
  });
  if (!run) throw new PayrollStoreError(404, "NOT_FOUND", "Payroll run not found.");
  return run;
}

export async function computePayrollRun(workspaceId: string, bookId: string, runId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, bookId },
    include: { employees: { include: { employee: true } } },
  });
  if (!run) throw new PayrollStoreError(404, "NOT_FOUND", "Payroll run not found.");
  if (run.status !== "draft") throw new PayrollStoreError(400, "INVALID_STATE", "Only draft runs can be computed.");

  // Get active employees
  const employees = await prisma.payrollEmployee.findMany({
    where: { bookId, status: "active" },
    include: { salaryStructures: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
  });

  if (employees.length === 0) throw new PayrollStoreError(400, "NO_EMPLOYEES", "No active employees found.");

  // Build payroll engine input
  const payrollInput = {
    period: run.period,
    state: run.state ?? "Maharashtra",
    employeeCount: employees.length,
    employees: employees.map((e) => {
      const struct = e.salaryStructures[0];
      return {
        id: e.id,
        name: e.name,
        basic: struct?.basic ?? e.basic,
        da: struct?.da ?? e.da,
        hra: struct?.hra ?? e.hra,
        specialAllowance: struct?.specialAllowance ?? e.specialAllowance,
        otherAllowances: struct?.otherAllowances ?? e.otherAllowances,
        bonusses: 0,
        deductions: {
          providentFund: struct?.pfEmployee ?? 0,
          esi: struct?.esiEmployee ?? 0,
          professionalTax: struct?.professionalTax ?? 0,
          lwf: struct?.lwf ?? 0,
          other: struct?.otherDeductions ?? 0,
        },
        dateOfJoining: e.dateOfJoining,
        dateOfBirth: e.dateOfBirth ?? "1990-01-01",
        gender: e.gender ?? "M",
      };
    }),
    minimumWage: { skilled: 15_000, unskilled: 12_000 },
  };

  const result = computePayroll(payrollInput);

  // Store computed results
  await prisma.$transaction(async (tx) => {
    const created: typeof result.employees = [];
    for (const emp of result.employees) {
      // Find the employee to get name
      const employee = await tx.payrollEmployee.findUnique({ where: { id: emp.employeeId } });
      await tx.payrollRunEmployee.create({
        data: {
          runId: run.id,
          employeeId: emp.employeeId,
          basic: emp.basic,
          da: emp.da,
          hra: emp.hra,
          specialAllowance: emp.specialAllowance,
          otherAllowances: emp.otherAllowances,
          conveyance: 0,
          medical: 0,
          bonus: 0,
          grossSalary: emp.grossSalary,
          pfEmployee: emp.pfEmployee,
          pfEmployer: emp.pfEmployer,
          eps: emp.eps,
          edli: emp.edli,
          pfAdmin: emp.pfAdmin,
          esiEmployee: emp.esiEmployee,
          esiEmployer: emp.esiEmployer,
          professionalTax: emp.professionalTax,
          lwf: emp.lwf,
          tds: emp.tds,
          voluntaryPf: 0,
          nps: 0,
          otherDeductions: emp.otherDeductions,
          totalDeductions: emp.totalDeductions,
          netPay: emp.netPay,
          employerCost: emp.grossSalary + emp.pfEmployer + emp.esiEmployer,
          pfWages: emp.basic + emp.da,
          esiWages: emp.grossSalary,
          daysWorked: 26,
          lopDays: 0,
        },
      });
      // Create a proper PayrollBreakup object with all required fields
      created.push({
        ...emp,
        employeeName: employee?.name ?? "",
        bonusses: 0,
        gratuity: 0,
      } as PayrollBreakup);
    }
    return created;
  });

  // Update run totals
  await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      totalGross: result.employees.reduce((s, e) => s + e.grossSalary, 0),
      totalDeductions: result.employees.reduce((s, e) => s + e.totalDeductions, 0),
      totalNet: result.employees.reduce((s, e) => s + e.netPay, 0),
      totalEmployerCost: result.employees.reduce((s, e) => s + e.grossSalary + e.pfEmployer + e.esiEmployer, 0),
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollRun",
      entityId: run.id,
      action: "compute",
      fieldChanges: stringifyJson({ employeeCount: result.employeeCount }),
      actorId,
    },
  });

  return result;
}

export async function approvePayrollRun(workspaceId: string, bookId: string, runId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, bookId } });
  if (!run) throw new PayrollStoreError(404, "NOT_FOUND", "Payroll run not found.");
  if (run.status !== "draft") throw new PayrollStoreError(400, "INVALID_STATE", "Only draft runs can be approved.");

  await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "approved", approvedById: actorId, approvedAt: new Date() },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "PayrollRun",
      entityId: runId,
      action: "approve",
      fieldChanges: stringifyJson({ status: { old: "draft", new: "approved" } }),
      actorId,
    },
  });
}

export async function postPayrollRunToJournal(
  workspaceId: string,
  bookId: string,
  runId: string,
  voucherNumber: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, bookId } });
    if (!run) throw new PayrollStoreError(404, "NOT_FOUND", "Payroll run not found.");
    if (run.status !== "approved")
      throw new PayrollStoreError(400, "INVALID_STATE", "Only approved runs can be posted.");
    await assertPeriodOpen(bookId, run.runDate, tx);

    // Claim the run: two concurrent posts cannot both create a voucher.
    const claimed = await tx.payrollRun.updateMany({
      where: { id: runId, bookId, status: "approved" },
      data: { status: "posting" },
    });
    if (claimed.count !== 1) throw new PayrollStoreError(409, "ALREADY_POSTED", "This payroll run was already posted.");

    const accounts = await tx.bookAccount.findMany({ where: { bookId }, select: { id: true, code: true } });
    const byCode = new Map(accounts.map((a) => [a.code, a.id] as const));
    const expenseId = byCode.get("5100") ?? byCode.get("5000");
    const payableId = byCode.get("2300");
    const statutoryId = byCode.get("2250") ?? byCode.get("2200") ?? payableId;
    if (!expenseId || !payableId || !statutoryId) {
      throw new PayrollStoreError(
        400,
        "NO_ACCOUNTS",
        "Payroll posting needs Employee Costs (5100), Salaries Payable (2300) and a statutory dues account (2250/2200).",
      );
    }

    const employerContributions = run.totalEmployerCost - run.totalGross;
    const statutoryTotal = run.totalDeductions + employerContributions;
    const lines = [
      { accountId: expenseId, amount: run.totalEmployerCost, narration: `Payroll expense ${run.period}` },
      { accountId: payableId, amount: -run.totalNet, narration: `Net salary payable ${run.period}` },
      { accountId: statutoryId, amount: -statutoryTotal, narration: `Statutory dues ${run.period}` },
    ];
    const totals = voucherTotals(lines);
    if (totals.totalDebit !== totals.totalCredit) {
      throw new PayrollStoreError(
        400,
        "UNBALANCED_ENTRY",
        "Payroll totals do not balance — recompute the run before posting.",
      );
    }

    const duplicate = await tx.bookVoucher.findUnique({ where: { bookId_number: { bookId, number: voucherNumber } } });
    if (duplicate) throw new PayrollStoreError(409, "DUPLICATE", `Voucher ${voucherNumber} already exists.`);

    const voucher = await tx.bookVoucher.create({
      data: {
        bookId,
        number: voucherNumber,
        date: run.runDate,
        narration: `Payroll for ${run.period}`,
        reference: `PAYROLL:${run.period}`,
        voucherType: "journal",
        status: "posted",
        postedAt: new Date(),
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: { create: lines },
      },
    });

    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "paid", paidById: actorId, paidAt: new Date(), voucherId: voucher.id },
    });

    await tx.subledgerPosting.create({
      data: { bookId, sourceType: "payroll-run", sourceId: run.id, voucherId: voucher.id, postedById: actorId },
    });

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "PayrollRun",
        entityId: run.id,
        action: "post",
        fieldChanges: stringifyJson({ voucherId: voucher.id, voucherNumber }),
        actorId,
      },
    });

    return { run: updated, voucher };
  });
}

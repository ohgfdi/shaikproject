import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { PayrollEmployeeInput, PayrollRunInput, PayrollSalaryStructureInput } from "@/lib/server/payroll";
import {
  createPayrollEmployee,
  listPayrollEmployees,
  getPayrollEmployee,
  updatePayrollEmployee,
  deletePayrollEmployee,
  createSalaryStructure,
  listSalaryStructures,
  createPayrollRun,
  listPayrollRuns,
  getPayrollRun,
  computePayrollRun,
  approvePayrollRun,
  postPayrollRunToJournal,
} from "@/lib/server/payroll";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const employeeId = url.searchParams.get("employeeId");
    const runId = url.searchParams.get("runId");

    if (action === "salary-structures") {
      const employeeId = url.searchParams.get("employeeId");
      const structures = await listSalaryStructures(ctx.workspace.id, params.id, employeeId ?? undefined);
      return ok({ structures });
    }

    if (runId) {
      const run = await getPayrollRun(ctx.workspace.id, params.id, runId);
      return ok({ run });
    }

    if (employeeId) {
      const employee = await getPayrollEmployee(ctx.workspace.id, params.id, employeeId);
      return ok({ employee });
    }

    const status = url.searchParams.get("status") ?? undefined;
    const employees = await listPayrollEmployees(ctx.workspace.id, params.id, { status });
    return ok({ employees });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const action = body.action;

    if (action === "salary-structure") {
      const { action: _, ...input } = body;
      const structure = await createSalaryStructure(
        ctx.workspace.id,
        params.id,
        input as unknown as PayrollSalaryStructureInput,
        ctx.user.id,
      );
      return ok({ structure }, { status: 201 });
    }

    if (action === "create-run") {
      const { action: _, ...input } = body;
      const run = await createPayrollRun(ctx.workspace.id, params.id, input as unknown as PayrollRunInput, ctx.user.id);
      return ok({ run }, { status: 201 });
    }

    if (action === "compute") {
      const runId = body.runId as string;
      if (!runId) return toErrorResponse(new Error("runId required"));
      const result = await computePayrollRun(ctx.workspace.id, params.id, runId, ctx.user.id);
      return ok({ result });
    }

    if (action === "approve") {
      const runId = body.runId as string;
      if (!runId) return toErrorResponse(new Error("runId required"));
      await approvePayrollRun(ctx.workspace.id, params.id, runId, ctx.user.id);
      return ok({ approved: true });
    }

    if (action === "post") {
      const runId = body.runId as string;
      const voucherNumber = body.voucherNumber as string;
      if (!runId || !voucherNumber) return toErrorResponse(new Error("runId and voucherNumber required"));
      const result = await postPayrollRunToJournal(ctx.workspace.id, params.id, runId, voucherNumber, ctx.user.id);
      return ok({ result });
    }

    if (action === "list-runs") {
      const status = body.status as string | undefined;
      const runs = await listPayrollRuns(ctx.workspace.id, params.id, { status });
      return ok({ runs });
    }

    const { action: _, ...input } = body;
    const employee = await createPayrollEmployee(
      ctx.workspace.id,
      params.id,
      input as unknown as PayrollEmployeeInput,
      ctx.user.id,
    );
    return ok({ employee }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const employeeId = url.searchParams.get("employeeId");
    const runId = url.searchParams.get("runId");

    const body = await readJsonBody<Record<string, unknown>>(request);

    if (employeeId) {
      const employee = await updatePayrollEmployee(
        ctx.workspace.id,
        params.id,
        employeeId,
        body as Partial<PayrollEmployeeInput>,
        ctx.user.id,
      );
      return ok({ employee });
    }

    if (runId) {
      // Not implemented for run update
      return toErrorResponse(new Error("Run update not implemented"));
    }

    return toErrorResponse(new Error("employeeId or runId required"));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const employeeId = url.searchParams.get("employeeId");
    if (!employeeId) return toErrorResponse(new Error("employeeId required"));

    await deletePayrollEmployee(ctx.workspace.id, params.id, employeeId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { ExpenseRuleInput } from "@/lib/server/expense-rules";
import {
  createExpenseRule,
  listExpenseRules,
  getExpenseRule,
  updateExpenseRule,
  deleteExpenseRule,
  classifyVoucher,
} from "@/lib/server/expense-rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const ruleId = url.searchParams.get("ruleId");

    if (action === "classify") {
      // Not implemented for GET; use POST for classification
      return toErrorResponse(new Error("Use POST for classification"));
    }

    if (ruleId) {
      const rule = await getExpenseRule(ctx.workspace.id, params.id, ruleId);
      return ok({ rule });
    }

    const activeOnly = url.searchParams.get("activeOnly") !== "false";
    const rules = await listExpenseRules(ctx.workspace.id, params.id, activeOnly);
    return ok({ rules });
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

    if (action === "classify") {
      const lines = body.lines as Array<{
        accountCode: string;
        narration?: string | null;
        amount: number;
        partyGstin?: string | null;
        voucherType?: string | null;
        lineId: string;
      }>;
      if (!lines) return toErrorResponse(new Error("lines array required"));
      const results = await classifyVoucher(ctx.workspace.id, params.id, lines);
      // Convert Map to object
      const obj: Record<string, unknown> = {};
      for (const [k, v] of results) obj[k] = v;
      return ok({ results: obj });
    }

    const { action: _, ...input } = body;
    const rule = await createExpenseRule(
      ctx.workspace.id,
      params.id,
      input as unknown as ExpenseRuleInput,
      ctx.user.id,
    );
    return ok({ rule }, { status: 201 });
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
    const ruleId = url.searchParams.get("ruleId");
    if (!ruleId) return toErrorResponse(new Error("ruleId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const rule = await updateExpenseRule(
      ctx.workspace.id,
      params.id,
      ruleId,
      body as Partial<ExpenseRuleInput>,
      ctx.user.id,
    );
    return ok({ rule });
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
    const ruleId = url.searchParams.get("ruleId");
    if (!ruleId) return toErrorResponse(new Error("ruleId required"));

    await deleteExpenseRule(ctx.workspace.id, params.id, ruleId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

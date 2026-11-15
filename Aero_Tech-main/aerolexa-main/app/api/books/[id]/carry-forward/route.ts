import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { CarryForwardInput } from "@/lib/server/carry-forward";
import {
  createCarryForward,
  listCarryForwards,
  getCarryForward,
  computeCarryForwardBalances,
  validateCarryForward,
  postCarryForward,
  deleteCarryForward,
} from "@/lib/server/carry-forward";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const carryId = url.searchParams.get("carryId");

    if (action === "compute") {
      const fromFy = url.searchParams.get("fromFy");
      const toFy = url.searchParams.get("toFy");
      if (!fromFy || !toFy) return toErrorResponse(new Error("fromFy and toFy required"));
      const result = await computeCarryForwardBalances(ctx.workspace.id, params.id, fromFy, toFy);
      return ok({ result });
    }

    if (carryId) {
      const carry = await getCarryForward(ctx.workspace.id, params.id, carryId);
      return ok({ carry });
    }

    const carries = await listCarryForwards(ctx.workspace.id, params.id);
    return ok({ carries });
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

    if (action === "validate") {
      const carryId = body.carryId as string;
      if (!carryId) return toErrorResponse(new Error("carryId required"));
      const result = await validateCarryForward(ctx.workspace.id, params.id, carryId, ctx.user.id);
      return ok({ result });
    }

    if (action === "post") {
      const carryId = body.carryId as string;
      if (!carryId) return toErrorResponse(new Error("carryId required"));
      const result = await postCarryForward(ctx.workspace.id, params.id, carryId, ctx.user.id);
      return ok({ result });
    }

    const { action: _, ...input } = body;
    const carry = await createCarryForward(
      ctx.workspace.id,
      params.id,
      input as unknown as CarryForwardInput,
      ctx.user.id,
    );
    return ok({ carry }, { status: 201 });
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
    const carryId = url.searchParams.get("carryId");
    if (!carryId) return toErrorResponse(new Error("carryId required"));

    await deleteCarryForward(ctx.workspace.id, params.id, carryId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

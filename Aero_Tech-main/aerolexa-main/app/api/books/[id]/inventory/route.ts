import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { InventoryItemInput, InventoryMovementInput } from "@/lib/server/inventory";
import {
  createInventoryItem,
  listInventoryItems,
  getInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  createInventoryMovement,
  getStockSummary,
} from "@/lib/server/inventory";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const itemId = url.searchParams.get("itemId");

    if (action === "stock-summary") {
      const asOfDate = url.searchParams.get("asOfDate") ?? undefined;
      const summary = await getStockSummary(ctx.workspace.id, params.id, asOfDate);
      return ok({ summary });
    }

    if (itemId) {
      const item = await getInventoryItem(ctx.workspace.id, params.id, itemId);
      return ok({ item });
    }

    const activeOnly = url.searchParams.get("active") !== "false";
    const items = await listInventoryItems(ctx.workspace.id, params.id, { active: activeOnly });
    return ok({ items });
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

    if (action === "movement") {
      const { action: _, ...input } = body;
      const movement = await createInventoryMovement(
        ctx.workspace.id,
        params.id,
        input as unknown as InventoryMovementInput,
        ctx.user.id,
      );
      return ok({ movement }, { status: 201 });
    }

    const { action: _, ...input } = body;
    const item = await createInventoryItem(
      ctx.workspace.id,
      params.id,
      input as unknown as InventoryItemInput,
      ctx.user.id,
    );
    return ok({ item }, { status: 201 });
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
    const itemId = url.searchParams.get("itemId");
    if (!itemId) return toErrorResponse(new Error("itemId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const item = await updateInventoryItem(ctx.workspace.id, params.id, itemId, body, ctx.user.id);
    return ok({ item });
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
    const itemId = url.searchParams.get("itemId");
    if (!itemId) return toErrorResponse(new Error("itemId required"));

    await deleteInventoryItem(ctx.workspace.id, params.id, itemId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

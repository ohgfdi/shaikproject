import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import {
  createClosingEntry,
  listClosingEntries,
  getClosingEntry,
  updateClosingEntry,
  approveClosingEntry,
  postClosingEntry,
  deleteClosingEntry,
  type ClosingEntryInput,
} from "@/lib/server/closing-entries";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const entryId = url.searchParams.get("entryId");

    if (entryId) {
      const entry = await getClosingEntry(ctx.workspace.id, params.id, entryId);
      return ok({ entry });
    }

    const period = url.searchParams.get("period") ?? undefined;
    const closingType = url.searchParams.get("closingType") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { entries, total } = await listClosingEntries(ctx.workspace.id, params.id, {
      period,
      closingType,
      status,
      limit,
      offset,
    });

    return ok({ entries, total, limit, offset });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const body = await readJsonBody<ClosingEntryInput & { action?: string; entryId?: string }>(request);
    const action = body.action;

    if (action === "approve") {
      const entryId = body.entryId;
      if (!entryId) return toErrorResponse(new Error("entryId required"));
      const result = await approveClosingEntry(ctx.workspace.id, params.id, entryId!, ctx.user.id);
      return ok({ entry: result });
    }

    if (action === "post") {
      const entryId = body.entryId;
      if (!entryId) return toErrorResponse(new Error("entryId required"));
      const result = await postClosingEntry(ctx.workspace.id, params.id, entryId!, ctx.user.id);
      return ok({ result });
    }

    const { action: _action, entryId: _entryId, ...input } = body;
    const entry = await createClosingEntry(ctx.workspace.id, params.id, input, ctx.user.id);
    return ok({ entry }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const url = new URL(request.url);
    const entryId = url.searchParams.get("entryId");
    if (!entryId) return toErrorResponse(new Error("entryId required"));

    const body = await readJsonBody<Partial<import("@/lib/server/closing-entries").ClosingEntryInput>>(request);
    const entry = await updateClosingEntry(ctx.workspace.id, params.id, entryId, body, ctx.user.id);
    return ok({ entry });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const url = new URL(request.url);
    const entryId = url.searchParams.get("entryId");
    if (!entryId) return toErrorResponse(new Error("entryId required"));

    await deleteClosingEntry(ctx.workspace.id, params.id, entryId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

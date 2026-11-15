import { requireAuth } from "@/lib/auth/guard";
import {
  createAdjustmentJournal,
  listAdjustmentJournals,
  getAdjustmentJournal,
  updateAdjustmentJournal,
  approveAdjustmentJournal,
  postAdjustmentJournal,
  reverseAdjustmentJournal,
  deleteAdjustmentJournal,
  type AdjustmentJournalInput,
} from "@/lib/server/adjustment-journals";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const journalId = url.searchParams.get("journalId");

    if (journalId) {
      const journal = await getAdjustmentJournal(ctx.workspace.id, params.id, journalId);
      return ok({ journal });
    }

    const status = url.searchParams.get("status") ?? undefined;
    const adjustmentType = url.searchParams.get("adjustmentType") ?? undefined;
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { journals, total } = await listAdjustmentJournals(ctx.workspace.id, params.id, {
      status,
      adjustmentType,
      from,
      to,
      limit,
      offset,
    });

    return ok({ journals, total, limit, offset });
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
    const body = await readJsonBody<AdjustmentJournalInput & { action?: string; journalId?: string }>(request);
    const action = body.action;

    if (action === "approve") {
      const journalId = body.journalId;
      if (!journalId) return toErrorResponse(new Error("journalId required"));
      const result = await approveAdjustmentJournal(ctx.workspace.id, params.id, journalId!, ctx.user.id);
      return ok({ journal: result });
    }

    if (action === "post") {
      const journalId = body.journalId;
      if (!journalId) return toErrorResponse(new Error("journalId required"));
      const result = await postAdjustmentJournal(ctx.workspace.id, params.id, journalId!, ctx.user.id);
      return ok({ result });
    }

    if (action === "reverse") {
      const journalId = body.journalId;
      if (!journalId) return toErrorResponse(new Error("journalId required"));
      const result = await reverseAdjustmentJournal(ctx.workspace.id, params.id, journalId!, ctx.user.id);
      return ok({ journal: result });
    }

    const { action: _action, journalId: _journalId, ...input } = body;
    const journal = await createAdjustmentJournal(ctx.workspace.id, params.id, input, ctx.user.id);
    return ok({ journal }, { status: 201 });
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
    const journalId = url.searchParams.get("journalId");
    if (!journalId) return toErrorResponse(new Error("journalId required"));

    const body =
      await readJsonBody<Partial<import("@/lib/server/adjustment-journals").AdjustmentJournalInput>>(request);
    const journal = await updateAdjustmentJournal(ctx.workspace.id, params.id, journalId, body, ctx.user.id);
    return ok({ journal });
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
    const journalId = url.searchParams.get("journalId");
    if (!journalId) return toErrorResponse(new Error("journalId required"));

    await deleteAdjustmentJournal(ctx.workspace.id, params.id, journalId, ctx.user.id);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

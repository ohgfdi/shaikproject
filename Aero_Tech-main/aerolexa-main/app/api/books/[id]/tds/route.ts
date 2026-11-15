import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import type { TdsEntryInput } from "@/lib/server/tds";
import {
  createTdsEntry,
  listTdsEntries,
  getTdsEntry,
  updateTdsEntry,
  markTdsDeposited,
  markTdsFiled,
  createTdsCorrection,
  getTdsQuarterlySummary,
} from "@/lib/server/tds";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const entryId = url.searchParams.get("entryId");

    if (action === "quarterly-summary") {
      const fy = url.searchParams.get("fy");
      const quarter = url.searchParams.get("quarter");
      if (!fy || !quarter) return toErrorResponse(new Error("fy and quarter required"));
      const summary = await getTdsQuarterlySummary(ctx.workspace.id, params.id, fy, quarter);
      return ok({ summary });
    }

    if (entryId) {
      const entry = await getTdsEntry(ctx.workspace.id, params.id, entryId);
      return ok({ entry });
    }

    const fy = url.searchParams.get("fy") ?? undefined;
    const quarter = url.searchParams.get("quarter") ?? undefined;
    const section = url.searchParams.get("section") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const deducteePan = url.searchParams.get("deducteePan") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { entries, total } = await listTdsEntries(ctx.workspace.id, params.id, {
      fy,
      quarter,
      section,
      status,
      deducteePan,
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
    const body = await readJsonBody<Record<string, unknown>>(request);
    const action = body.action;

    if (action === "mark-deposited") {
      const entryId = body.entryId as string;
      const depositedAt = body.depositedAt as string;
      if (!entryId || !depositedAt) return toErrorResponse(new Error("entryId and depositedAt required"));
      const entry = await markTdsDeposited(ctx.workspace.id, params.id, entryId, depositedAt, ctx.user.id);
      return ok({ entry });
    }

    if (action === "mark-filed") {
      const entryId = body.entryId as string;
      const form26Q_27Q = body.form26Q_27Q as string;
      const filedAt = body.filedAt as string;
      if (!entryId || !form26Q_27Q || !filedAt)
        return toErrorResponse(new Error("entryId, form26Q_27Q, filedAt required"));
      const entry = await markTdsFiled(ctx.workspace.id, params.id, entryId, form26Q_27Q, filedAt, ctx.user.id);
      return ok({ entry });
    }

    if (action === "correction") {
      const originalEntryId = body.originalEntryId as string;
      const correctionReason = body.correctionReason as string;
      const { action: _a, originalEntryId: _b, correctionReason: _c, ...input } = body;
      if (!originalEntryId || !correctionReason)
        return toErrorResponse(new Error("originalEntryId and correctionReason required"));
      const entry = await createTdsCorrection(
        ctx.workspace.id,
        params.id,
        originalEntryId,
        input as Partial<TdsEntryInput>,
        correctionReason,
        ctx.user.id,
      );
      return ok({ entry }, { status: 201 });
    }

    const { action: _, ...input } = body;
    const entry = await createTdsEntry(ctx.workspace.id, params.id, input as unknown as TdsEntryInput, ctx.user.id);
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
    const url = new URL(request.url);
    const entryId = url.searchParams.get("entryId");
    if (!entryId) return toErrorResponse(new Error("entryId required"));

    const body = await readJsonBody<Record<string, unknown>>(request);
    const entry = await updateTdsEntry(
      ctx.workspace.id,
      params.id,
      entryId,
      body as Partial<TdsEntryInput>,
      ctx.user.id,
    );
    return ok({ entry });
  } catch (err) {
    return toErrorResponse(err);
  }
}

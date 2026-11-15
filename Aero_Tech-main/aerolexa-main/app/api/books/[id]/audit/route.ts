import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { listAuditEntries, getAuditEntry, getEntityAuditHistory, generateAuditReport } from "@/lib/server/book-audit";
import { assertBookTenant } from "@/lib/server/book-tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const entryId = url.searchParams.get("entryId");

    if (action === "report") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!from || !to) return toErrorResponse(new Error("from and to dates required"));
      const report = await generateAuditReport(ctx.workspace.id, params.id, from, to);
      return ok({ report });
    }

    if (action === "entity-history") {
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");
      if (!entityType || !entityId) return toErrorResponse(new Error("entityType and entityId required"));
      const history = await getEntityAuditHistory(ctx.workspace.id, params.id, entityType, entityId);
      return ok({ history });
    }

    if (entryId) {
      const entry = await getAuditEntry(ctx.workspace.id, params.id, entryId);
      return ok({ entry });
    }

    const actionParam = url.searchParams.get("action") || undefined;
    const entityType = url.searchParams.get("entityType") ?? undefined;
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const actorId = url.searchParams.get("actorId") ?? undefined;
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { entries, total } = await listAuditEntries(ctx.workspace.id, params.id, {
      entityType,
      entityId,
      action: actionParam,
      actorId,
      from,
      to,
      limit,
      offset,
    });

    return ok({ entries, total, limit, offset });
  } catch (err) {
    return toErrorResponse(err);
  }
}

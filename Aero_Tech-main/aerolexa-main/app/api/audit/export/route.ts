import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { auditEntriesToCsv } from "@/lib/engine/audit-csv";
import { toErrorResponse } from "@/lib/server/api";
import { requirePlanFeature } from "@/lib/server/billing-features";

export const dynamic = "force-dynamic";

const SECURITY_TYPES = new Set([
  "SECURITY_SIGN_IN",
  "SECURITY_SIGN_OUT",
  "SECURITY_VERIFY",
  "SECURITY_SSO",
  "MEMBER_ADDED",
  "MEMBER_UPDATED",
  "MEMBER_REMOVED",
  "SCHEDULE_RUN",
]);

/** GET /api/audit/export — the audit trail as a filterable CSV download. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    // The on-screen audit trail stays readable on every plan (it is the
    // workspace's own history); handing a filterable CSV to an external
    // auditor is the Firm-tier governance export.
    await requirePlanFeature(ctx.workspace.id, "auditExport", "Audit-trail CSV export");
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "security" ? "security" : "activity";
    const actorId = url.searchParams.get("actorId") ?? null;
    const type = url.searchParams.get("type") ?? null;

    const rows = await prisma.activity.findMany({
      where: {
        workspaceId: ctx.workspace.id,
        ...(scope === "security" ? { type: { in: [...SECURITY_TYPES] } } : {}),
        ...(actorId ? { actorId } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 5000,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
      },
    });

    const csv = auditEntriesToCsv(
      rows.map((a) => ({
        createdAt: a.createdAt.toISOString(),
        type: a.type,
        message: a.message,
        actorName: a.actor?.name ?? null,
        actorEmail: a.actor?.email ?? null,
        projectName: a.project?.name ?? null,
        security: SECURITY_TYPES.has(a.type),
      })),
    );

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="Ledgerly-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

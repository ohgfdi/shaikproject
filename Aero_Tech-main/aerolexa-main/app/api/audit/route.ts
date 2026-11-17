import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";

/**
 * tenancy-audit: global-operator — audit API lists workspace-wide activity
 * for the firm. This is a deployment-wide aggregate rather than a per-tenant
 * query.
 */

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

export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
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
      take: 250,
      include: {
        actor: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
      },
    });
    return ok({
      entries: rows.map((a) => ({
        id: a.id,
        type: a.type,
        message: a.message,
        createdAt: a.createdAt.toISOString(),
        actorName: a.actor?.name ?? null,
        actorEmail: a.actor?.email ?? null,
        actorId: a.actorId,
        projectName: a.project?.name ?? null,
        projectId: a.projectId,
        security: SECURITY_TYPES.has(a.type),
      })),
      scopes: { activity: !scope || scope === "activity", security: scope === "security" },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - active organization switch is a deployment-wide aggregate operation
import { z } from "zod";

import { readActiveOrganizationId, setActiveOrganizationId } from "@/lib/auth/active-org";
import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

const switchSchema = z.object({
  organizationId: z.string().min(1, "organizationId is required."),
});

/** GET /api/me/active-organization — memberships + the currently active one. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: ctx.user.id },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const selected = await readActiveOrganizationId();
    const active =
      memberships.find((m) => m.organizationId === selected)?.organizationId ?? memberships[0]?.organizationId ?? null;
    return ok({
      activeOrganizationId: active,
      organizations: memberships.map((m) => ({
        id: m.organizationId,
        name: m.organization.name,
        role: m.role,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/me/active-organization — switch the tenant for subsequent requests. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const { organizationId } = switchSchema.parse(await readJsonBody<unknown>(request));

    // Only a membership grants access; an arbitrary id must never become the
    // active tenant.
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: ctx.user.id } },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!membership) {
      return Response.json(
        { ok: false, error: { code: "FORBIDDEN", message: "You are not a member of that organization." } },
        { status: 403 },
      );
    }

    await setActiveOrganizationId(organizationId);
    return ok({
      activeOrganizationId: membership.organizationId,
      organization: { id: membership.organization.id, name: membership.organization.name },
      role: membership.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

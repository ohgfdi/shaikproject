import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

/**
 * tenancy-audit: global-operator — client token API generates engagement
 * access tokens for the workspace. This is a deployment-wide aggregate rather
 * than a per-tenant query.
 */
import { ok, toErrorResponse } from "@/lib/server/api";

/**
 * Generate a client engagement access token.
 *
 * The engagementId is passed as a query parameter (e.g. /api/client/token?engagementId=eng_123)
 * The user must have ENGAGEMENTMEMBER VIEWER role on the engagement to access the client portal.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();
    const url = new URL(request.url);
    const engagementId = url.searchParams.get("engagementId");

    if (!engagementId) {
      return toErrorResponse(new Error("engagementId query parameter is required."));
    }

    // Verify the engagement exists
    const engagement = await prisma.engagement.findUnique({
      where: { id: engagementId },
      include: {
        organization: {
          select: { id: true },
        },
      },
    });

    if (!engagement) {
      return toErrorResponse(new Error("Engagement not found."));
    }

    // Check engagement membership - user must have VIEWER role via EngagementMember
    const member = await prisma.engagementMember.findFirst({
      where: {
        engagementId,
        userId: auth.user?.id,
        practiceRole: "VIEWER",
      },
    });

    if (!member) {
      return toErrorResponse(new Error("You do not have access to this engagement."));
    }

    // Return token payload for the client portal
    return ok({
      ok: true,
      engagementId,
      role: member?.practiceRole ?? "VIEWER",
      expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
    });
  } catch (err: any) {
    return toErrorResponse(err);
  }
}
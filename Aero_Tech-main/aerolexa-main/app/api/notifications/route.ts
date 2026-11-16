// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - notification sending is a deployment-wide aggregate operation
import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { notifyComplianceDeadline, notifyDeliverableReady, notifyEngagementAccess, notifyPaperReviewAssignment } from "@/lib/notifications/sms";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("compliance-deadline"),
    engagementId: z.string().min(1),
    phone: z.string().min(6),
    taskTitle: z.string().trim().min(1).max(200),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    daysLeft: z.number().int(),
  }),
  z.object({
    type: z.literal("engagement-access"),
    engagementId: z.string().min(1),
    phone: z.string().min(6),
    role: z.string().trim().max(60).optional(),
  }),
  z.object({
    type: z.literal("paper-review"),
    engagementId: z.string().min(1),
    phone: z.string().min(6),
    paperTitle: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("deliverable-ready"),
    engagementId: z.string().min(1),
    phone: z.string().min(6),
    deliverableName: z.string().trim().min(1).max(200),
  }),
]);

/**
 * Send one engagement notification over SMS.
 *
 * The previous implementation fetched a *relative* URL server-side (which
 * always throws), interpolated the literal text `new Date().toISOString()` into
 * the message, and hard-coded task and deliverable names. Every field is now
 * supplied by the caller and the engagement is resolved from the database,
 * scoped to the caller's organization.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) {
      throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
    }
    const body = schema.parse(await readJsonBody<unknown>(request));

    const engagement = await prisma.engagement.findFirst({
      where: { id: body.engagementId, organizationId: ctx.organization.id },
      select: { id: true, name: true },
    });
    if (!engagement) {
      throw new ApiError(404, "NOT_FOUND", "Engagement not found in this organization.");
    }

    const result =
      body.type === "compliance-deadline"
        ? await notifyComplianceDeadline(
            body.phone,
            engagement.name,
            body.taskTitle,
            body.dueDate,
            body.daysLeft,
            `${engagement.id}:${body.taskTitle}`,
          )
        : body.type === "engagement-access"
          ? await notifyEngagementAccess(body.phone, engagement.name, body.role ?? "Member", engagement.id)
          : body.type === "paper-review"
            ? await notifyPaperReviewAssignment(body.phone, body.paperTitle, engagement.name, engagement.id)
            : await notifyDeliverableReady(body.phone, body.deliverableName, engagement.name, engagement.id);

    if (!result.success) {
      throw new ApiError(502, "DELIVERY_FAILED", result.error ?? "The SMS transport rejected the message.");
    }

    return ok({
      accepted: true,
      delivered: result.delivered,
      transport: result.transport,
      sid: result.sid ?? null,
      referenceId: result.referenceId ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  buildClientComplianceCalendar,
  ENTITY_KINDS,
  financialYearFor,
  type ClientComplianceProfileInput,
  type EntityKind,
  type GstFrequency,
} from "@/lib/engine/compliance-calendar";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { queueComplianceNudge } from "@/lib/server/compliance-nudges";
import { requireEngagementRole } from "@/lib/server/engagement";

export const dynamic = "force-dynamic";

const schema = z.object({
  engagementId: z.string().min(1),
  to: z.string().trim().email(),
  horizonDays: z.number().int().min(0).max(90).optional(),
});

type ProfileSeed = Omit<ClientComplianceProfileInput, "clientId" | "clientName">;

function readSeed(raw: string | undefined): ProfileSeed | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.financialYear !== "string") return null;
    if (!ENTITY_KINDS.includes(parsed.entityKind as EntityKind)) return null;
    const frequency: GstFrequency = parsed.gstFrequency === "quarterly" ? "quarterly" : "monthly";
    return {
      entityKind: parsed.entityKind as EntityKind,
      financialYear: parsed.financialYear,
      gstRegistered: Boolean(parsed.gstRegistered),
      gstFrequency: frequency,
      tdsDeductor: Boolean(parsed.tdsDeductor),
      taxAuditApplicable: Boolean(parsed.taxAuditApplicable),
      transferPricingApplicable: Boolean(parsed.transferPricingApplicable),
      listedCompany: Boolean(parsed.listedCompany),
      state: typeof parsed.state === "string" ? parsed.state : null,
      employsStaff: Boolean(parsed.employsStaff),
    };
  } catch {
    return null;
  }
}

/**
 * POST — queue one compliance nudge for a client.
 *
 * The digest lists only obligations the firm has not already recorded as filed
 * or waived. It goes through the durable outbox, so a failed send is retried by
 * the worker rather than silently dropped.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    const { engagement } = await requireEngagementRole(ctx, body.engagementId, "ASSISTANT");
    const detail = await prisma.engagement.findUnique({
      where: { id: engagement.id },
      select: { name: true, gstin: true, organizationId: true },
    });
    if (!detail) throw new Error("Engagement disappeared while preparing the reminder.");

    const today = new Date().toISOString().slice(0, 10);
    const stored = await prisma.clientComplianceProfile.findUnique({
      where: { engagementId: engagement.id },
      select: { profile: true },
    });
    const seed: ProfileSeed = readSeed(stored?.profile) ?? {
      entityKind: "company",
      financialYear: financialYearFor(today),
      gstRegistered: Boolean(detail.gstin),
      gstFrequency: "monthly",
      tdsDeductor: true,
      taxAuditApplicable: false,
      transferPricingApplicable: false,
      listedCompany: false,
      state: null,
      employsStaff: false,
    };

    const tasks = buildClientComplianceCalendar({
      ...seed,
      clientId: engagement.id,
      clientName: detail.name,
    });
    const statuses = await prisma.clientComplianceStatus.findMany({
      where: { engagementId: engagement.id },
      select: { taskId: true, status: true },
    });
    const closed = new Set(
      statuses.filter((row) => row.status === "filed" || row.status === "waived").map((row) => row.taskId),
    );

    const result = await queueComplianceNudge({
      organizationId: detail.organizationId,
      to: body.to,
      firmName: ctx.organization?.name ?? "Your CA firm",
      clientName: detail.name,
      tasks: tasks.filter((task) => !closed.has(task.id)),
      today,
      horizonDays: body.horizonDays,
    });

    return ok({
      ...result,
      summary: result.queued
        ? `Queued a ${result.taskCount}-date reminder for ${detail.name}. The outbox worker delivers and retries it.`
        : "Nothing is overdue or due within the horizon, so no reminder was queued.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { recordReminder } from "@/lib/server/document-requests";
import { requireOrgRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

const schema = z.object({
  /** Remind requests due within this many days (0 = overdue only). */
  dueWithinDays: z.number().int().min(0).max(90).default(0),
});

/**
 * POST /api/organization/document-requests/remind — chase every open request
 * that is at or past its deadline. Each reminder is recorded even when the
 * client has no email on file; delivery failures are returned, not swallowed.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) {
      return ok({ attempted: 0, delivered: 0, failed: 0, results: [] });
    }
    await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
    const body = schema.parse(await readJsonBody<unknown>(request));

    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) + body.dueWithinDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const open = await prisma.clientDocumentRequest.findMany({
      where: {
        status: "requested",
        dueDate: { lte: cutoff },
        OR: [{ workspaceId: ctx.workspace.id }, { engagement: { organizationId: ctx.organization.id } }],
      },
      select: { id: true, title: true, clientName: true },
      orderBy: { dueDate: "asc" },
      take: 200,
    });

    const results = [];
    for (const item of open) {
      try {
        const reminder = await recordReminder(ctx.workspace.id, item.id);
        results.push({
          requestId: item.id,
          title: item.title,
          clientName: item.clientName,
          recorded: true,
          emailDelivered: reminder.emailDelivered,
          emailError: reminder.emailError,
        });
      } catch (err) {
        results.push({
          requestId: item.id,
          title: item.title,
          clientName: item.clientName,
          recorded: false,
          emailDelivered: false,
          emailError: err instanceof Error ? err.message : "Reminder could not be recorded.",
        });
      }
    }

    const delivered = results.filter((r) => r.emailDelivered).length;
    const failed = results.filter((r) => !r.emailDelivered).length;

    if (results.length > 0) {
      await logActivity(
        ctx,
        "DOCUMENT_REQUEST_REMINDED",
        `Chased ${results.length} overdue document request(s) — ${delivered} emailed.`,
        null,
        { attempted: results.length, delivered, failed },
      );
    }

    return ok({ attempted: results.length, delivered, failed, results });
  } catch (err) {
    return toErrorResponse(err);
  }
}

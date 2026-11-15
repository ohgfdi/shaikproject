import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { deadlineStatus } from "@/lib/engine/deadlines";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  NOTICE_PRIORITIES,
  NOTICE_STATUSES,
  getNotice,
  toEngineNotice,
  updateNotice,
} from "@/lib/server/gst-notices";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(NOTICE_STATUSES as unknown as [string, ...string[]]).optional(),
  priority: z.enum(NOTICE_PRIORITIES).optional(),
  assignedTo: z.string().trim().max(200).nullable().optional(),
});

/** GET /api/gst/notices/[id] — the notice, its engine view and saved replies. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const notice = await getNotice(ctx.workspace.id, id);
    const today = new Date().toISOString().slice(0, 10);
    return ok({
      notice,
      engineNotice: toEngineNotice(notice),
      deadline: deadlineStatus(notice.responseDueDate, today),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PATCH /api/gst/notices/[id] — working state (status, priority, assignee). */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = patchSchema.parse(await readJsonBody<unknown>(request));
    const notice = await updateNotice(ctx.workspace.id, id, {
      status: body.status as (typeof NOTICE_STATUSES)[number] | undefined,
      priority: body.priority,
      assignedTo: body.assignedTo,
    });
    return ok({ notice });
  } catch (err) {
    return toErrorResponse(err);
  }
}

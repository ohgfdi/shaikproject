import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  advanceFilingRun,
  assignFilingRun,
  moveFilingRunDueDate,
  submitFilingRun,
  FILING_STAGES,
} from "@/lib/server/filing-runs";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), assigneeId: z.string().min(1) }),
  z.object({
    action: z.literal("advance"),
    stage: z.enum(FILING_STAGES),
    note: z.string().trim().max(2000).nullish(),
    acknowledgementReference: z.string().trim().max(120).nullish(),
  }),
  z.object({ action: z.literal("submit"), note: z.string().trim().max(2000).nullish() }),
  z.object({
    action: z.literal("move-due-date"),
    dueDate: z.string().trim().min(10).max(10),
    note: z.string().trim().max(2000).nullish(),
  }),
]);

/** PATCH — assign the preparer, or move the run one stage forward. */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    if (body.action === "assign") {
      return ok({ run: await assignFilingRun(ctx, id, body.assigneeId) });
    }
    if (body.action === "submit") {
      return ok({ run: await submitFilingRun(ctx, id, { note: body.note ?? null }) });
    }
    if (body.action === "move-due-date") {
      return ok({ run: await moveFilingRunDueDate(ctx, id, body.dueDate, body.note ?? null) });
    }
    return ok({
      run: await advanceFilingRun(ctx, id, {
        stage: body.stage,
        note: body.note ?? null,
        acknowledgementReference: body.acknowledgementReference ?? null,
      }),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { logTimeEntry } from "@/lib/server/practice-economics";

export const dynamic = "force-dynamic";

const schema = z.object({
  engagementId: z.string().min(1),
  taskId: z.string().trim().max(80).nullish(),
  workDate: z.string().trim(),
  minutes: z.number().int(),
  ratePerHourMinor: z.number().int(),
  billable: z.boolean().optional(),
  narrative: z.string().trim().max(1000).nullish(),
});

/** POST — log one time entry against a client engagement. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    return ok({ entry: await logTimeEntry(ctx, body) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

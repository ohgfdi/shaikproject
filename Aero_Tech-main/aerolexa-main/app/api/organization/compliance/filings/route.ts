import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { ensureFilingRun, getFilingBoard, openDueSoonFilingRuns } from "@/lib/server/filing-runs";

export const dynamic = "force-dynamic";

/** GET — in-flight filing runs plus obligations that have no run yet. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    return ok(
      await getFilingBoard(ctx, {
        stage: url.searchParams.get("stage") ?? undefined,
        engagementId: url.searchParams.get("engagementId") ?? undefined,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

const createSchema = z.union([
  z.object({
    action: z.literal("open-due-soon"),
    withinDays: z.number().int().min(1).max(60).optional(),
    cap: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    engagementId: z.string().min(1),
    taskId: z.string().min(1),
  }),
]);

/**
 * POST — put one generated obligation on the board, or sweep every uncovered
 * obligation due in the next two weeks (`action: "open-due-soon"`).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = createSchema.parse(await readJsonBody<unknown>(request));
    if ("action" in body) {
      return ok(await openDueSoonFilingRuns(ctx, { withinDays: body.withinDays, cap: body.cap }));
    }
    return ok({ run: await ensureFilingRun(ctx, body) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  bulkAdvanceFilingRuns,
  bulkAssignFilingRuns,
  openDueSoonFilingRuns,
  FILING_STAGES,
} from "@/lib/server/filing-runs";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open-due"),
    withinDays: z.number().int().min(1).max(60).optional(),
    cap: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    action: z.literal("assign"),
    runIds: z.array(z.string().min(1)).min(1).max(200),
    assigneeId: z.string().min(1),
  }),
  z.object({
    action: z.literal("advance"),
    runIds: z.array(z.string().min(1)).min(1).max(200),
    stage: z.enum(FILING_STAGES),
    note: z.string().trim().max(2000).nullish(),
  }),
]);

/**
 * POST — batch operations for a firm running many clients.
 *
 * Each run keeps its own role gate and transition rules; the response reports
 * what was applied and what was refused, so a batch is never silently partial.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    if (body.action === "open-due") {
      return ok(await openDueSoonFilingRuns(ctx, { withinDays: body.withinDays, cap: body.cap }));
    }
    if (body.action === "assign") {
      return ok(await bulkAssignFilingRuns(ctx, { runIds: body.runIds, assigneeId: body.assigneeId }));
    }
    return ok(
      await bulkAdvanceFilingRuns(ctx, {
        runIds: body.runIds,
        stage: body.stage,
        note: body.note ?? null,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

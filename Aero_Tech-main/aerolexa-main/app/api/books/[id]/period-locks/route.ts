import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { listPeriodLocks, lockPeriod, unlockPeriod } from "@/lib/server/period-locks";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must be yyyy-mm");
const bodySchema = z.object({
  action: z.enum(["lock", "unlock"]),
  period: periodSchema,
  reason: z.string().max(500).nullable().optional(),
});

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    return ok({ locks: await listPeriodLocks(params.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/books/:id/period-locks — lock or unlock a fiscal period. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const body = bodySchema.parse(await readJsonBody<unknown>(request));
    if (body.action === "lock") {
      const lock = await lockPeriod({
        bookId: params.id,
        period: body.period,
        actorId: ctx.user.id,
        reason: body.reason,
      });
      return ok({ lock }, { status: 201 });
    }
    const removed = await unlockPeriod({ bookId: params.id, period: body.period, actorId: ctx.user.id });
    return ok({ unlocked: removed.period });
  } catch (err) {
    return toErrorResponse(err);
  }
}

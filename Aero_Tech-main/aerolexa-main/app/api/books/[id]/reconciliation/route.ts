import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { reconcileSubledgers } from "@/lib/server/subledger";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must be yyyy-mm"),
});

/** GET /api/books/:id/reconciliation?period=yyyy-mm — register ↔ ledger gap. */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const { period } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return ok({ reconciliation: await reconcileSubledgers(ctx.workspace.id, params.id, period) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

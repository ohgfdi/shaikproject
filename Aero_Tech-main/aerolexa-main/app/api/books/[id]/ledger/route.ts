import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { getAccountLedger } from "@/lib/server/books";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  accountCode: z.string().trim().min(1, "accountCode is required."),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * GET /api/books/[id]/ledger?accountCode&from&to — one account's ledger with a
 * running natural-side balance. This is the screen a junior uses to match a
 * ledger line to a voucher during vouching; the arithmetic is `accountLedger()`
 * so the statement and the day book can never disagree.
 */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const rows = await getAccountLedger(ctx.workspace.id, params.id, query.accountCode, {
      from: query.from,
      to: query.to,
    });
    return ok({ accountCode: query.accountCode, rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { getDayBook, postVoucher, type VoucherInput } from "@/lib/server/books";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const postVoucherSchema = z.object({
  number: z.string().trim().min(1, "Voucher number is required."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in yyyy-mm-dd form."),
  narration: z.string().trim().min(1, "Narration is required."),
  reference: z.string().nullable().optional(),
  voucherType: z.string().optional(),
  lines: z
    .array(
      z.object({
        accountCode: z.string().trim().min(1, "accountCode is required."),
        amount: z.number().int("amount must be a whole number of paise."),
        narration: z.string().nullable().optional(),
      }),
    )
    .min(2, "A voucher needs at least two lines."),
});

/** GET /api/books/[id]/vouchers?from&to — the day book. */
export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const range = {
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    };
    return ok({ dayBook: await getDayBook(ctx.workspace.id, params.id, range) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/books/[id]/vouchers — post a journal voucher.
 * The entry must balance to the paise; an unbalanced voucher is rejected.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const body = postVoucherSchema.parse(await readJsonBody<unknown>(request)) satisfies VoucherInput;
    const voucher = await postVoucher(ctx.workspace.id, params.id, body);
    return ok({ voucher }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

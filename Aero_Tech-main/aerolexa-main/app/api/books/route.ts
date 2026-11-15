import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createBook, listBooks, type BookInput } from "@/lib/server/books";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const createBookSchema = z.object({
  name: z.string().trim().min(1, "Book name is required."),
  legalName: z.string().nullable().optional(),
  gstin: z.string().nullable().optional(),
  pan: z.string().nullable().optional(),
  entityType: z.string().optional(),
  booksFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "booksFrom must be a yyyy-mm-dd date.")
    .nullable()
    .optional(),
  fiscalYearEnd: z.string().optional(),
});

export async function GET(_req: Request) {
  try {
    const ctx = await requireAuth();
    const result = await listBooks(ctx.workspace.id, ctx.organization?.id ?? null);
    return ok({ books: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/books — create a set of books. */
/* The default Schedule III chart of accounts is seeded automatically. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "books_write", RATE_LIMITS.books_write);
    const body = createBookSchema.parse(await readJsonBody<unknown>(request)) satisfies BookInput;
    const book = await createBook(ctx.workspace.id, {
      ...body,
      organizationId: ctx.organization?.id ?? null,
    });
    return ok({ book }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { DOCUMENT_CATEGORIES } from "@/lib/engine/ca-documents";
import { deadlineStatus } from "@/lib/engine/deadlines";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createDocumentRequest, listDocumentRequests } from "@/lib/server/document-requests";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  clientName: z.string().trim().min(1).max(160),
  clientEmail: z.string().trim().email().max(200).nullable().optional(),
  title: z.string().trim().min(2).max(200),
  category: z.enum(DOCUMENT_CATEGORIES as unknown as [string, ...string[]]),
  period: z.string().trim().max(40).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(2000).nullable().optional(),
  bookId: z.string().trim().min(1).nullable().optional(),
});

/**
 * GET /api/document-requests — open (and closed) requests with a live deadline.
 * The register is what stops "we asked the client three weeks ago" from being a
 * memory.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const rows = await listDocumentRequests(ctx.workspace.id, {
      status: url.searchParams.get("status") ?? undefined,
      bookId: url.searchParams.get("bookId") ?? undefined,
    });
    const today = new Date().toISOString().slice(0, 10);
    return ok({
      requests: rows.map((row) => ({
        ...row,
        deadline: deadlineStatus(row.dueDate, today),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/document-requests — ask a client for a document, with a deadline. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = createSchema.parse(await readJsonBody<unknown>(request));
    const created = await createDocumentRequest(
      ctx.workspace.id,
      {
        ...body,
        category: body.category as (typeof DOCUMENT_CATEGORIES)[number],
      },
      ctx.user.id,
    );
    return ok({ request: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

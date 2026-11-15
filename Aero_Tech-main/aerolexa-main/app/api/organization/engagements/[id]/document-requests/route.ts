import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "@/lib/engine/ca-documents";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  createEngagementDocumentRequest,
  listEngagementDocumentRequests,
} from "@/lib/server/document-requests";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().min(2).max(200),
  category: z.enum(DOCUMENT_CATEGORIES as unknown as [string, ...string[]]),
  period: z.string().trim().max(40).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** GET — document requests for one engagement (the portal shows the open ones). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok({ requests: await listEngagementDocumentRequests(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST — ask the client for a document; the request appears in their portal. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = createSchema.parse(await readJsonBody<unknown>(request));
    const created = await createEngagementDocumentRequest(ctx, id, {
      ...body,
      category: body.category as DocumentCategory,
    });
    return ok({ request: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

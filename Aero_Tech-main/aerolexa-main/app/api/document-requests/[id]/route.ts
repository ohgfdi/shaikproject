import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  DOCUMENT_REQUEST_STATUSES,
  recordReminder,
  setDocumentRequestStatus,
} from "@/lib/server/document-requests";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    status: z.enum(DOCUMENT_REQUEST_STATUSES as unknown as [string, ...string[]]),
  }),
  z.object({ action: z.literal("remind") }),
]);

/**
 * PATCH /api/document-requests/[id]
 *  - `{ action: "status", status }` — received / waived / reopened.
 *  - `{ action: "remind" }` — record a chase; emails the client when an address
 *    is on file. A mail failure is returned, never swallowed.
 */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    if (body.action === "remind") {
      const reminder = await recordReminder(ctx.workspace.id, id);
      return ok({ reminder });
    }
    const updated = await setDocumentRequestStatus(
      ctx.workspace.id,
      id,
      body.status as (typeof DOCUMENT_REQUEST_STATUSES)[number],
    );
    return ok({ request: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

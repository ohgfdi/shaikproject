import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { getNotice, saveResponse } from "@/lib/server/gst-notices";

export const dynamic = "force-dynamic";

const computationSchema = z.object({
  head: z.string().trim().min(1),
  demanded: z.number().finite(),
  admitted: z.number().finite(),
  disputed: z.number().finite(),
  basis: z.string(),
});

const schema = z.object({
  responseNumber: z.string().trim().min(1),
  responseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  responseType: z.enum(["reply", "clarification", "payment", "appeal", "rectification", "hearing-request"]),
  status: z.enum(["draft", "reviewed", "approved", "filed", "withdrawn"]).optional(),
  content: z.object({
    facts: z.string(),
    legalArguments: z.array(z.string()),
    evidenceReferences: z.array(z.string()),
    computations: z.array(computationSchema),
    prayers: z.array(z.string()),
  }),
  attachments: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        type: z.enum(["reconciliation", "invoice", "ledger", "bank", "contract", "correspondence", "other"]),
        ref: z.string(),
      }),
    )
    .max(50)
    .optional(),
  filingMode: z.enum(["portal", "physical", "email"]).optional(),
  filedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  acknowledgmentRef: z.string().trim().max(120).nullable().optional(),
});

/** GET /api/gst/notices/[id]/responses — replies already recorded. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const notice = await getNotice(ctx.workspace.id, id);
    return ok({ responses: notice.responses });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/gst/notices/[id]/responses — save a generated draft.
 * The draft is produced by the engine (`generateResponseDraft`) and reviewed by
 * a human; this route only persists it, and a saved draft never marks a notice
 * filed.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    const response = await saveResponse(ctx.workspace.id, id, body, ctx.user.id);
    return ok({ response }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

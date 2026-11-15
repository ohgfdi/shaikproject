import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { markPracticeInvoicePaid, voidPracticeInvoice } from "@/lib/server/practice-economics";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("paid"),
    paidOn: z.string().trim().optional(),
    reference: z.string().trim().min(3).max(120),
    method: z.string().trim().max(40).optional(),
  }),
  z.object({ action: z.literal("void"), reason: z.string().trim().min(3).max(500) }),
]);

/** PATCH — settle or withdraw one client invoice. */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody<unknown>(request));
    const invoice =
      body.action === "paid"
        ? await markPracticeInvoicePaid(ctx, id, {
            paidOn: body.paidOn,
            reference: body.reference,
            method: body.method,
          })
        : await voidPracticeInvoice(ctx, id, body.reason);
    return ok({ invoice });
  } catch (err) {
    return toErrorResponse(err);
  }
}

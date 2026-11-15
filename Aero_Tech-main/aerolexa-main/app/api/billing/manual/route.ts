import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, ok, toErrorResponse } from "@/lib/server/api";
import { BillingError, requestManualUpgrade } from "@/lib/server/billing";

const schema = z.object({
  planId: z.enum(["pro", "firm"]),
  interval: z.enum(["month", "year"]).default("month"),
  note: z.string().max(300).optional(),
});

/**
 * POST /api/billing/manual — stage a `due` invoice for offline payment
 * (NEFT/UPI). The plan is NOT activated here; an operator records the payment
 * reference first. The response includes the invoice number + amount so the
 * buyer knows exactly what to transfer.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const invoice = await requestManualUpgrade({ workspaceId: ctx.workspace.id, ...body });
    await logActivity(ctx, "BILLING_MANUAL_REQUESTED", `Manual upgrade requested for ${body.planId}`, null, {
      kind: "BILLING",
      invoiceNumber: invoice.number,
    });
    return ok(invoice);
  } catch (err) {
    if (err instanceof BillingError) {
      return toErrorResponse(Object.assign(new Error(err.message), { status: err.status, code: err.code }));
    }
    return toErrorResponse(err);
  }
}

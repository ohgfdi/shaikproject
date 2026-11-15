import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, ok, toErrorResponse } from "@/lib/server/api";
import { BillingError, createRazorpayCheckout } from "@/lib/server/billing";

const schema = z.object({
  planId: z.enum(["pro", "firm"]),
  interval: z.enum(["month", "year"]).default("month"),
});

/**
 * POST /api/billing/checkout — create a Razorpay order for a paid plan.
 * Returns the order fields the Razorpay Checkout.js client needs (order id,
 * amount, currency, public key id). The invoice is staged as `due` and only
 * flips to `paid` after signature-verified confirmation (callback or webhook).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const order = await createRazorpayCheckout({ workspaceId: ctx.workspace.id, ...body });
    await logActivity(ctx, "BILLING_CHECKOUT", `Checkout started for plan ${body.planId}`, null, {
      kind: "BILLING",
      orderId: order.id,
    });
    return ok(order);
  } catch (err) {
    if (err instanceof BillingError) {
      return toErrorResponse(Object.assign(new Error(err.message), { status: err.status, code: err.code }));
    }
    return toErrorResponse(err);
  }
}

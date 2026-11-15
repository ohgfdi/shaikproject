import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, ok, toErrorResponse } from "@/lib/server/api";
import { BillingError, verifyRazorpayPayment } from "@/lib/server/billing";

const schema = z.object({
  razorpayOrderId: z.string().min(4),
  razorpayPaymentId: z.string().min(4),
  razorpaySignature: z.string().min(8),
});

/**
 * POST /api/billing/verify — client-side checkout callback. Verifies the
 * HMAC-SHA256 signature before anything is applied; a bad signature leaves the
 * invoice `due` and the plan unchanged.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    await verifyRazorpayPayment({ workspaceId: ctx.workspace.id, ...body });
    await logActivity(ctx, "BILLING_PAID", `Payment verified (order ${body.razorpayOrderId})`, null, {
      kind: "BILLING",
    });
    return ok({ verified: true });
  } catch (err) {
    if (err instanceof BillingError) {
      return toErrorResponse(Object.assign(new Error(err.message), { status: err.status, code: err.code }));
    }
    return toErrorResponse(err);
  }
}

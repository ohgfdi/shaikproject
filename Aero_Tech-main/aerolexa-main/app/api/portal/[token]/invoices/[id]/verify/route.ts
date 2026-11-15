import { z } from "zod";

import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { verifyPortalInvoicePayment } from "@/lib/server/client-portal";

export const dynamic = "force-dynamic";

const schema = z.object({
  razorpayOrderId: z.string().trim().min(4).max(120),
  razorpayPaymentId: z.string().trim().min(4).max(120),
  razorpaySignature: z.string().trim().min(8).max(200),
});

/** POST — verify the checkout signature and record the payment once. */
export async function POST(request: Request, props: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await props.params;
  try {
    const body = schema.parse(await readJsonBody<unknown>(request));
    return ok({ invoice: await verifyPortalInvoicePayment(token, id, body) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

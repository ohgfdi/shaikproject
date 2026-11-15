import { createHash } from "node:crypto";

import { toErrorResponse } from "@/lib/server/api";
import { BillingError, handleRazorpayWebhookEvent, verifyWebhookSignature } from "@/lib/server/billing";

/**
 * POST /api/billing/webhook — Razorpay server-to-server events.
 *
 * The HMAC is computed over the RAW body (parsing first would break the
 * signature), so this route reads text before JSON. Events are applied at
 * most once via the WebhookEvent ledger — Razorpay retries deliveries and a
 * replay must never double-apply a payment.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const signature = request.headers.get("x-razorpay-signature");
    if (!verifyWebhookSignature(raw, signature)) {
      throw new BillingError(400, "SIGNATURE_INVALID", "Webhook signature verification failed.");
    }

    const event = JSON.parse(raw) as {
      event?: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
    };
    const paymentId = event.payload?.payment?.entity?.id;
    const orderId = event.payload?.payment?.entity?.order_id;
    // The dedupe key must be stable across provider retries. Falling back to a
    // random UUID (the previous behaviour) made every retry look like a new
    // event, defeating the WebhookEvent ledger. When the provider omits ids,
    // hash the raw body — retries are byte-identical.
    const eventKey = paymentId ?? orderId ?? `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const result = await handleRazorpayWebhookEvent(
      `${event.event ?? "unknown"}:${eventKey}`,
      event.event ?? "unknown",
      {
        order: { id: orderId },
        payment: { id: paymentId },
      },
    );
    // Always 200 for verified events (even deduped replays) so the provider
    // stops retrying; unapplied replays are acknowledged, not re-processed.
    return Response.json({ ok: true, data: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Client-invoice payments — the firm's client paying the firm.
 *
 * Deliberately separate from `lib/server/billing.ts`, which sells Ledgerly's own
 * subscription. A client invoice and a SaaS receipt must never share a rail or
 * a ledger row.
 *
 * The contract is small and testable:
 *  - An order is created server-side for the invoice's exact stored total (the
 *    client can never propose an amount).
 *  - A payment is accepted only when Razorpay's HMAC over
 *    `<orderId>|<paymentId>` matches the checkout signature.
 *  - An already-paid invoice is idempotent for the same payment id; any other
 *    second payment is refused rather than recorded as a new one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { ApiError } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";

export interface InvoicePaymentOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
}

export interface RazorpayOrderInput {
  invoiceId: string;
  invoiceNumber: string;
  totalMinor: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Paise → the integer Razorpay expects, refusing a non-representable amount. */
export function razorpayAmountMinor(totalMinor: number): number {
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
    throw new ApiError(400, "INVALID_AMOUNT", "The invoice total must be a positive whole number of paise.");
  }
  return totalMinor;
}

/** The exact string Razorpay signs: `<order_id>|<payment_id>`. */
export function checkoutSignaturePayload(orderId: string, paymentId: string): string {
  return `${orderId}|${paymentId}`;
}

/** Hex HMAC-SHA256 of the checkout payload — exported for the oracle test. */
export function checkoutSignature(orderId: string, paymentId: string, secret: string): string {
  return createHmac("sha256", secret).update(checkoutSignaturePayload(orderId, paymentId)).digest("hex");
}

/** Constant-time signature check. An empty/absent secret can never verify. */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = checkoutSignature(orderId, paymentId, secret);
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function razorpayConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** The publishable key the portal needs to open Checkout.js (never the secret). */
export function razorpayPublicKey(): string | null {
  return razorpayConfigured() ? serverEnv().RAZORPAY_KEY_ID : null;
}

/**
 * Create a Razorpay order for one invoice. The amount comes from the stored
 * invoice, never from the request. A missing key is a readable 503, not a
 * silent fallback to an unverified "paid" state.
 */
export async function createInvoiceOrder(
  input: RazorpayOrderInput,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<InvoicePaymentOrder> {
  const env = serverEnv();
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError(
      503,
      "PAYMENTS_NOT_CONFIGURED",
      "Online payment is not configured on this deployment. Pay by bank transfer and ask your CA firm to record it.",
    );
  }
  const amount = razorpayAmountMinor(input.totalMinor);
  const receipt = `pi_${input.invoiceId}`.slice(0, 40);

  let res: Response;
  try {
    res = await fetchImpl("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      },
      body: JSON.stringify({ amount, currency: "INR", receipt, notes: { invoiceNumber: input.invoiceNumber } }),
    });
  } catch (err) {
    throw new ApiError(
      502,
      "PAYMENT_ORDER_FAILED",
      `Razorpay could not be reached (${err instanceof Error ? err.message : "network fault"}). Try again or pay by bank transfer.`,
    );
  }

  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body.id !== "string") {
    const reason =
      body && typeof body.error === "object" && body.error !== null
        ? String((body.error as Record<string, unknown>).description ?? (body.error as Record<string, unknown>).reason ?? "")
        : "";
    throw new ApiError(
      502,
      "PAYMENT_ORDER_FAILED",
      `Razorpay refused the payment order${reason ? `: ${reason}` : ` (HTTP ${res.status})`}.`,
    );
  }

  return {
    id: body.id,
    amount: typeof body.amount === "number" ? body.amount : amount,
    currency: typeof body.currency === "string" ? body.currency : "INR",
    receipt: typeof body.receipt === "string" ? body.receipt : receipt,
  };
}

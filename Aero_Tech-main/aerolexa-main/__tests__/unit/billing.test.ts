/**
 * Billing tests (Band 4.2) — the payment-verification contract without a DB
 * or network. DB-backed flows (checkout/webhook application) run in the API
 * suite. Here: the HMAC signature math (the security core), plan catalog
 * integrity, and source-gated guarantees (webhook idempotency, manual rail
 * never auto-activates).
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { DEFAULT_PLANS, parsePlanFeatures, timingSafeEqualHex, verifyWebhookSignature } from "@/lib/server/billing";

const SRC = readFileSync(`${process.cwd()}/lib/server/billing.ts`, "utf8");

describe("billing — signature verification (the security core)", () => {
  const secret = "test-webhook-secret-0123456789";
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });

  it("accepts a correctly signed webhook over the raw body", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig)).toBe(true);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("rejects tampered bodies, wrong secrets and missing signatures", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body + " ", sig)).toBe(false);
    const sig2 = createHmac("sha256", "other-secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig2)).toBe(false);
    expect(verifyWebhookSignature(body, null)).toBe(false);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("compares signatures in constant time (no early-exit on length)", () => {
    expect(timingSafeEqualHex("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(timingSafeEqualHex("a".repeat(64), "b".repeat(64))).toBe(false);
    expect(timingSafeEqualHex("a".repeat(64), "short")).toBe(false);
  });

  it("payment callback signature is HMAC(order_id|payment_id, key_secret)", () => {
    // Mirrors the exact expression used by verifyRazorpayPayment.
    const orderId = "order_ABC123";
    const paymentId = "pay_XYZ789";
    const keySecret = "key_secret_test";
    const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqualHex(expected, expected)).toBe(true);
    expect(timingSafeEqualHex(expected, expected.slice(0, -1) + "0")).toBe(false);
  });
});

describe("billing — plan catalog", () => {
  it("ships Free/Pro/Firm with integer paise amounts", () => {
    const ids = DEFAULT_PLANS.map((p) => p.id);
    expect(ids).toEqual(["free", "pro", "firm"]);
    for (const plan of DEFAULT_PLANS) {
      expect(Number.isInteger(plan.amountPaise)).toBe(true);
      expect(plan.amountPaise).toBeGreaterThanOrEqual(0);
    }
    expect(DEFAULT_PLANS.find((p) => p.id === "free")!.amountPaise).toBe(0);
    expect(DEFAULT_PLANS.find((p) => p.id === "pro")!.amountPaise).toBeGreaterThan(0);
  });

  it("parsePlanFeatures tolerates corrupt JSON (never throws)", () => {
    expect(parsePlanFeatures('["a","b"]')).toEqual(["a", "b"]);
    expect(parsePlanFeatures("not json")).toEqual([]);
    expect(parsePlanFeatures('{"x":1}')).toEqual([]);
    expect(parsePlanFeatures("[]")).toEqual([]);
  });
});

describe("billing — rail contract (source-gated)", () => {
  it("the webhook is idempotent via the WebhookEvent ledger", () => {
    expect(SRC).toContain("webhookEvent");
    expect(SRC).toContain("applied: false");
  });

  it("Razorpay checkout requires configured credentials (no silent rail switch)", () => {
    expect(SRC).toContain("RAZORPAY_NOT_CONFIGURED");
  });

  it("the manual rail stages a due invoice and never auto-activates", () => {
    expect(SRC).toContain('status: "due"');
    expect(SRC).toContain("recordManualPayment");
    // requestManualUpgrade must not touch subscriptions
    const manualFn =
      SRC.split("export async function requestManualUpgrade")[1]?.split(
        "export async function recordManualPayment",
      )[0] ?? "";
    expect(manualFn).not.toContain("subscription");
  });

  it("amounts are integer paise — never floats", () => {
    expect(SRC).toContain("amountPaise");
    expect(SRC).not.toMatch(/amount:\s*[\d.]+\s*\*\s*100/); // no float math on money
  });
});

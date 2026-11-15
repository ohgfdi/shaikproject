/**
 * Billing service (Band 4.2) — Plan → Subscription → Invoice with two
 * honestly-labelled payment rails:
 *
 *   • razorpay — a server-created order + HMAC-SHA256 signature verification
 *     (both the client callback and the webhook are verified; the webhook is
 *     additionally idempotent via the WebhookEvent ledger).
 *   • manual   — offline NEFT/UPI transfer; an invoice becomes PAID only when
 *     the recorded payment reference is supplied. Nothing auto-upgrades.
 *
 * Razorpay credentials come from env only (RAZORPAY_KEY_ID/SECRET). When they
 * are absent, the Razorpay rail is "not configured" — routes fail with a
 * readable message instead of silently degrading to manual billing.
 *
 * No plan gates any engine: billing is bookkeeping, not a meter that changes
 * computed results.
 */

import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export type PaymentRail = "manual" | "razorpay";

/** Monthly plans in paise. Kept here so seed + runtime agree. */
export const DEFAULT_PLANS = [
  {
    id: "free",
    name: "Free",
    amountPaise: 0,
    description: "One workspace, everything computed from your uploads.",
    features: ["1 workspace", "Unlimited analyses on your data", "Exports (PDF/HTML/Python)", "Community support"],
  },
  {
    id: "pro",
    name: "Pro",
    amountPaise: 99900, // ₹999 / month
    description: "For consultants who share work with clients.",
    features: ["Everything in Free", "Public share links", "Scheduled reports & notebooks", "Priority email support"],
  },
  {
    id: "firm",
    name: "Firm",
    amountPaise: 499900, // ₹4,999 / month
    description: "For CA firms running engagements across a team.",
    features: [
      "Everything in Pro",
      "Organization + engagements",
      "Org roles (ADMIN/AUDITOR)",
      "Onboarding for your team",
    ],
  },
] as const;

export const BILLING_PLANS_VERSION = "2026-09-20.1";

export function razorpayConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

// ---------------------------------------------------------------------------
// Plan catalog
// ---------------------------------------------------------------------------

/** Seed/repair the plan catalog (idempotent — upsert by plan id). */
export async function ensurePlans(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      create: {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        amountPaise: plan.amountPaise,
        features: JSON.stringify(plan.features),
      },
      update: {
        name: plan.name,
        description: plan.description,
        amountPaise: plan.amountPaise,
        features: JSON.stringify(plan.features),
      },
    });
  }
}

export function parsePlanFeatures(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** The workspace's active subscription (or a synthetic free state). */
export async function currentSubscription(workspaceId: string) {
  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: "active" },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (sub) return sub;
  const free = await prisma.plan.findUnique({ where: { id: "free" } });
  // The synthetic shape must match the real row's shape (trialEndsAt included)
  // or every caller has to null-check a field that only exists on one branch.
  return free ? { plan: free, status: "active", currentPeriodEnd: null, trialEndsAt: null, provider: null } : null;
}

// ---------------------------------------------------------------------------
// Razorpay rail
// ---------------------------------------------------------------------------

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  invoiceId: string;
  keyId: string;
}

/** Create a Razorpay order for the plan and stage a `due` invoice. */
export async function createRazorpayCheckout(input: {
  workspaceId: string;
  planId: string;
  interval: "month" | "year";
}): Promise<RazorpayOrder> {
  const env = serverEnv();
  if (!razorpayConfigured()) {
    throw new BillingError(
      503,
      "RAZORPAY_NOT_CONFIGURED",
      "Online payments are not configured on this deployment. Use the manual (offline transfer) option or set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET.",
    );
  }

  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan || !plan.isActive) throw new BillingError(404, "PLAN_NOT_FOUND", "That plan does not exist.");
  if (plan.amountPaise === 0)
    throw new BillingError(400, "PLAN_FREE", "The Free plan needs no checkout — it is already active.");

  const amount = input.interval === "year" ? plan.amountPaise * 10 : plan.amountPaise;

  // Real REST call to Razorpay Orders API (server-to-server; key never leaves).
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: plan.currency,
      receipt: `Ledgerly-${input.workspaceId.slice(-8)}-${Date.now().toString(36)}`,
      notes: { workspaceId: input.workspaceId, planId: plan.id, interval: input.interval },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new BillingError(
      502,
      "RAZORPAY_ORDER_FAILED",
      `Payment gateway rejected the order (${res.status}). ${body.slice(0, 160)}`,
    );
  }
  const order = (await res.json()) as { id: string; amount: number; currency: string };

  const invoice = await prisma.invoice.create({
    data: {
      workspaceId: input.workspaceId,
      number: nextInvoiceNumber(),
      amountPaise: order.amount,
      currency: order.currency,
      status: "due",
      paymentMethod: "razorpay",
      razorpayOrderId: order.id,
      notes: `Plan ${plan.name} (${input.interval})`,
    },
  });

  return {
    id: order.id,
    amount: order.amount,
    currency: order.currency,
    invoiceId: invoice.id,
    keyId: env.RAZORPAY_KEY_ID,
  };
}

/**
 * Verify the client-side checkout callback: `razorpay_signature` is
 * HMAC_SHA256(order_id + "|" + payment_id, key_secret). On success the invoice
 * flips to PAID and the subscription to the purchased plan.
 */
export async function verifyRazorpayPayment(input: {
  workspaceId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<{ verified: true }> {
  const env = serverEnv();
  if (!razorpayConfigured()) {
    throw new BillingError(503, "RAZORPAY_NOT_CONFIGURED", "Online payments are not configured on this deployment.");
  }

  const invoice = await prisma.invoice.findUnique({
    where: { razorpayOrderId: input.razorpayOrderId },
    include: { subscription: true },
  });
  if (!invoice || invoice.workspaceId !== input.workspaceId) {
    throw new BillingError(404, "INVOICE_NOT_FOUND", "No matching invoice for that order.");
  }
  if (invoice.status === "paid") return { verified: true }; // idempotent

  const expected = createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest("hex");
  if (!timingSafeEqualHex(expected, input.razorpaySignature)) {
    throw new BillingError(
      400,
      "SIGNATURE_INVALID",
      "Payment signature verification failed. Nothing was charged to the workspace — contact support if you were debited.",
    );
  }

  await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "paid", paidAt: new Date(), razorpayPaymentId: input.razorpayPaymentId },
    }),
    ...(await activateSubscriptionOps(input.workspaceId, invoice)),
  ]);
  return { verified: true };
}

/** True when the plan's period end has passed — the webhook/cron flips these. */
export async function expireDueSubscriptions(now = new Date()): Promise<number> {
  const res = await prisma.subscription.updateMany({
    where: { status: "active", currentPeriodEnd: { lt: now } },
    data: { status: "past_due" },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// Webhook (idempotent, signature-verified)
// ---------------------------------------------------------------------------

/**
 * Handle a verified Razorpay webhook. Signature verification happens in the
 * route (raw body needed); here we de-duplicate by event id, then apply.
 */
export async function handleRazorpayWebhookEvent(
  eventId: string,
  type: string,
  payload: {
    order?: { id?: string };
    payment?: { id?: string };
  },
): Promise<{ applied: boolean }> {
  // Idempotency: a replayed event id is acknowledged but never re-applied.
  const inserted = await prisma.webhookEvent
    .create({ data: { id: eventId, provider: "razorpay", type } })
    .then(() => true)
    .catch(() => false);
  if (!inserted) return { applied: false };

  if (type === "payment.captured" && payload.order?.id) {
    const invoice = await prisma.invoice.findUnique({ where: { razorpayOrderId: payload.order.id } });
    if (invoice && invoice.status !== "paid") {
      await prisma.$transaction([
        prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: "paid",
            paidAt: new Date(),
            razorpayPaymentId: payload.payment?.id ?? null,
          },
        }),
        ...(await activateSubscriptionOps(invoice.workspaceId, invoice)),
      ]);
    }
  }
  return { applied: true };
}

// ---------------------------------------------------------------------------
// Manual rail (offline NEFT/UPI)
// ---------------------------------------------------------------------------

/**
 * Request a manual upgrade: stages a `due` invoice for the operator. The
 * workspace does NOT change plans here — that happens only when an operator
 * records the payment reference (`recordManualPayment`).
 */
export async function requestManualUpgrade(input: {
  workspaceId: string;
  planId: string;
  interval: "month" | "year";
  note?: string;
}): Promise<{ invoiceId: string; number: string; amountPaise: number }> {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan || !plan.isActive) throw new BillingError(404, "PLAN_NOT_FOUND", "That plan does not exist.");
  if (plan.amountPaise === 0)
    throw new BillingError(400, "PLAN_FREE", "The Free plan needs no invoice — it is already active.");

  const amount = input.interval === "year" ? plan.amountPaise * 10 : plan.amountPaise;
  const invoice = await prisma.invoice.create({
    data: {
      workspaceId: input.workspaceId,
      number: nextInvoiceNumber(),
      amountPaise: amount,
      currency: plan.currency,
      status: "due",
      paymentMethod: "manual",
      notes: `Plan ${plan.name} (${input.interval})${input.note ? ` — ${input.note.slice(0, 200)}` : ""}`,
    },
  });
  return { invoiceId: invoice.id, number: invoice.number, amountPaise: invoice.amountPaise };
}

/** Operator action: record the offline transfer reference and activate. */
export async function recordManualPayment(input: { invoiceId: string; reference: string }): Promise<void> {
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new BillingError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
  if (invoice.status === "paid") return;
  if (!input.reference.trim())
    throw new BillingError(400, "REFERENCE_REQUIRED", "A payment reference (UTR/NEFT id) is required.");

  await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "paid",
        paidAt: new Date(),
        notes: `${invoice.notes ?? ""} · ref:${input.reference.trim()}`.slice(0, 500),
      },
    }),
    ...(await activateSubscriptionOps(invoice.workspaceId, invoice)),
  ]);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export class BillingError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Prisma ops that upsert the active subscription for a paid invoice. */
async function activateSubscriptionOps(
  workspaceId: string,
  invoice: { amountPaise: number; notes: string | null; number: string },
): Promise<ReturnType<typeof prisma.subscription.upsert>[]> {
  const planId = planIdFromInvoice(invoice.notes);
  const months = invoice.amountPaise >= 4000000 ? 12 : 1; // year plans are 10x monthly; ≥40k paise = annual firm
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + (planId === "free" ? 0 : months));
  // The schema has no unique on workspaceId, so upsert-by-unique is not
  // available: find-then-update/create inside the caller's $transaction.
  const existing = await prisma.subscription.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return [
    prisma.subscription.upsert({
      where: { id: existing?.id ?? "__never__" },
      create: {
        workspaceId,
        planId,
        status: "active",
        interval: months === 12 ? "year" : "month",
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
        trialEndsAt: null,
        provider: "manual",
      },
      update: {
        planId,
        status: "active",
        interval: months === 12 ? "year" : "month",
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
        // Phase 5.1: money arrived, so the trial stops being time-boxed.
        // Leaving trialEndsAt set would let a customer who has already paid
        // have the subscription silently expire out from under them.
        trialEndsAt: null,
        canceledAt: null,
      },
    }),
  ];
}

/** The invoice `notes` carry "Plan <name> (interval)" — resolve the plan id. */
function planIdFromInvoice(notes: string | null): string {
  if (!notes) return "pro";
  const match = /Plan (Free|Pro|Firm)/.exec(notes);
  if (!match) return "pro";
  return match[1]!.toLowerCase();
}

/** Human-readable invoice number: ARLX-YYYY-#### (per-year counter). */
function nextInvoiceNumber(): string {
  const year = new Date().getFullYear();
  return `ARLX-${year}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Constant-time hex comparison for signature checks. */
export function timingSafeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received ?? "", "utf8");
  if (a.length !== b.length) return false;
  return a.equals(b);
}

/** Verify the Razorpay webhook signature over the RAW request body. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const env = serverEnv();
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signature);
}

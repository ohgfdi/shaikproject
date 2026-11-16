/**
 * Phase 20: Stripe Payment Integration
 *
 * Stripe payment processing for subscription management.
 * Handles checkout sessions, billing portal, and webhook events.
 *
 * Usage:
 *   import { createCheckoutSession, handleWebhook } from "@/components/billing/stripe-integration";
 *
 *   // Create checkout session for Pro subscription
 *   const session = await createCheckoutSession({ tier: "pro", mode: "monthly" });
 *
 *   // Handle webhook events (in your route handler)
 *   // await handleWebhook(request);
 */
import Stripe from "stripe";
import { NextResponse } from "next/server";

// Initialize Stripe with secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-09-30",
  // @ts-ignore
  timeout: 30000,
});

// Price IDs - in production, these would be created in Stripe dashboard
// and stored in database or environment variables
const PRICE_IDS = {
  free: "price_1Free",
  proMonthly: "price_1ProMonthly",
  proAnnual: "price_1ProAnnual",
  enterprise: "price_1Enterprise",
};

/** Create a Stripe checkout session for a subscription tier. */
export async function createCheckoutSession({
  tier,
  mode = "monthly",
}: {
  tier: "pro" | "enterprise";
  mode?: "monthly" | "annual";
}) {
  let priceId: string;

  if (tier === "pro") {
    priceId = mode === "monthly"
      ? PRICE_IDS.proMonthly
      : PRICE_IDS.proAnnual;
  } else if (tier === "enterprise") {
    priceId = PRICE_IDS.enterprise;
  } else {
    throw new Error("Free tier does not have a checkout session");
  }

  const session = await stripe.checkout.sessions.create({
    mode,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/billing`,
    metadata: {
      tier,
      mode,
    },
  });

  return { sessionId: session.id, url: session.url };
}

/** Create a Stripe customer portal session. */
export async function createPortalSession({
  customerId,
  returnUrl,
}: {
  customerId: string;
  returnUrl: string;
}) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

/** Handle Stripe webhook events. */
export async function handleWebhook(
  request: Request
): Promise<NextResponse> {
  const sig = request.headers.get("stripe-signature") as string | null;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      await request.text(),
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return NextResponse.json(
      { error: `Webhook Error: ${err.message}` },
      { status: 400 }
    );
  }

  // Handle specific events
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      // TODO: Activate user subscription in database
      // await prisma.user.update({
      //   where: { stripeCustomerId: session.customer as string },
      //   data: { stripeStatus: "active", tier: session.metadata.tier },
      // });
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      // TODO: Update payment status in database
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // TODO: Notify user of payment failure
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      // TODO: Downgrade user to free tier in database
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}
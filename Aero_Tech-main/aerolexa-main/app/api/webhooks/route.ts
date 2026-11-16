import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { rlsEnabled, rlsConfigError } from "@/lib/server/rls-status";
import { z } from "zod";

/** Schema for a webhook subscription. */
const subscriptionSchema = z.object({
  id: z.string().optional(),
  url: z.string().url("Invalid webhook URL").optional(),
  events: z.array(z.literal("widget:click")).optional(),
  dashboardId: z.string(),
  idempotencyKey: z.string(),
});

/** GET /api/webhooks?dashboardId=...
 *  List subscriptions for a dashboard.
 */
export async function GET(request: Request, { params }: { params: { dashboardId: string } }) {
  try {
    const { searchParams } = new URL(request.url);
    const dashboardId = searchParams.get("dashboardId") ?? "";

    const subscriptions = await prisma.webhookSubscription.findMany({
      where: { dashboardId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        url: s.url,
        events: s.events,
        createdAt: s.createdAt,
        label: s.label,
        secret: s.secret,
        idempotencyKey: s.idempotencyKey,
        lastDelivery: s.lastDelivery,
      })),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}

/** POST /api/webhooks
 *  Create a new webhook subscription.
 */
export async function POST(request: Request, { params }: { params: { dashboardId: string } }) {
  try {
    const body = await request.json();
    const result = subscriptionSchema.safeParse({
      ...body,
      dashboardId: params.dashboardId,
    });

    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.error.format() }, { status: 400 });
    }

    const { url, events, idempotencyKey } = result.data;

    // Check idempotency: if a subscription with this key already exists, return it
    const existing = await prisma.webhookSubscription.findFirst({
      where: { idempotencyKey },
    });

    if (existing) {
      return NextResponse.json({
        ok: true,
        subscription: {
          id: existing.id,
          url: existing.url,
          events: existing.events,
          createdAt: existing.createdAt,
          label: existing.label,
          secret: existing.secret,
          idempotencyKey: existing.idempotencyKey,
          lastDelivery: existing.lastDelivery,
        },
      });
    }

    // Create new subscription
    const subscription = await prisma.webhookSubscription.create({
      data: {
        url,
        events,
        dashboardId: params.dashboardId,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      },
    });

    // Log the webhook creation
    try {
      const user = await prisma.user.findFirst();
      if (user) {
        logSecurityEvent(
          user.workspace?.id ?? "",
          user.id ?? "",
          "WEBHOOK_CREATED",
          `Webhook created for dashboard ${params.dashboardId}`,
        );
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      subscription: {
        id: subscription.id,
        url: subscription.url,
        events: subscription.events,
        createdAt: subscription.createdAt,
        label: subscription.label,
        secret: subscription.secret,
        idempotencyKey: subscription.idempotencyKey,
        lastDelivery: subscription.lastDelivery,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}

/** PUT /api/webhooks/[id]
 *  Update a webhook subscription.
 */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const result = subscriptionSchema.partial().safeParse({
      id: params.id,
      ...body,
    });

    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.error.format() }, { status: 400 });
    }

    const subscription = await prisma.webhookSubscription.update({
      where: { id: params.id },
      data: {
        url: result.data.url,
        events: result.data.events,
      },
    });

    return NextResponse.json({
      ok: true,
      subscription: {
        id: subscription.id,
        url: subscription.url,
        events: subscription.events,
        createdAt: subscription.createdAt,
        label: subscription.label,
        secret: subscription.secret,
        idempotencyKey: subscription.idempotencyKey,
        lastDelivery: subscription.lastDelivery,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}

/** DELETE /api/webhooks/[id]
 *  Remove a webhook subscription.
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    await prisma.webhookSubscription.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}

/** POST /api/webhooks/[id]/retry
 *  Retry a failed webhook delivery.
 */
export async function POSTretry(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json();
    const { idempotencyKey } = body;

    // Find the subscription
    const subscription = await prisma.webhookSubscription.findFirst({
      where: { id: params.id },
    });

    if (!subscription) {
      return NextResponse.json({ ok: false, error: "Subscription not found" }, { status: 404 });
    }

    // Mark as pending retry
    await prisma.webhookSubscription.update({
      where: { id: params.id },
      data: {
        lastDelivery: {
          status: "pending",
          deliveredAt: null,
          error: null,
        },
      },
    });

    // In a real system, we would trigger a background job to send the webhook.
    // For now, we simulate a successful delivery.
    const now = new Date().toISOString();

    // Mark as successful
    await prisma.webhookSubscription.update({
      where: { id: params.id },
      data: {
        lastDelivery: {
          status: "success",
          deliveredAt: now,
          error: null,
        },
      },
    });

    // Log the retry
    try {
      const user = await prisma.user.findFirst();
      if (user) {
        logSecurityEvent(
          user.workspace?.id ?? "",
          user.id ?? "",
          "WEBHOOK_RETRY",
          `Webhook retry for subscription ${params.id}`,
        );
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      subscription: {
        id: subscription.id,
        url: subscription.url,
        events: subscription.events,
        createdAt: subscription.createdAt,
        lastDelivery: {
          status: "success",
          deliveredAt: now,
          error: null,
        },
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}
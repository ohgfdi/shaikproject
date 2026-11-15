import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { currentSubscription, parsePlanFeatures, razorpayConfigured } from "@/lib/server/billing";
import { trialStatus } from "@/lib/server/trial";

/** GET /api/billing/plans — catalog + the caller's current subscription. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const [plans, current, trial] = await Promise.all([
      prisma.plan.findMany({ where: { isActive: true }, orderBy: { amountPaise: "asc" } }),
      currentSubscription(ctx.workspace.id),
      trialStatus(ctx.workspace.id),
    ]);
    return ok({
      razorpayConfigured: razorpayConfigured(),
      current: current
        ? {
            planId: current.plan.id,
            planName: current.plan.name,
            status: current.status,
            currentPeriodEnd: current.currentPeriodEnd,
            // Phase 5.1: true when the "current plan" is really a trial, so the
            // UI can say so rather than implying the user has already paid.
            isTrial: Boolean(current.trialEndsAt && current.trialEndsAt.getTime() > Date.now()),
          }
        : null,
      trial: {
        active: trial.active,
        daysRemaining: trial.daysRemaining,
        endsAt: trial.endsAt,
        expiringSoon: trial.expiringSoon,
      },
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        amountPaise: p.amountPaise,
        currency: p.currency,
        interval: p.interval,
        features: parsePlanFeatures(p.features),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

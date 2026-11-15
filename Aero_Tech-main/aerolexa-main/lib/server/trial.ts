/**
 * Free trial lifecycle (Phase 5.1).
 *
 * The product already had a free tier and a paid tier, and the gap between
 * them was the conversion moment: a new user could never experience what they
 * would be paying for. Share links, scheduled delivery and API keys are all
 * Pro entitlements, and all three are exactly the features a consultant needs
 * to feel the difference before paying for it.
 *
 * So a new workspace gets a time-limited Pro trial.
 *
 * The rule that shapes this file: **a trial is a paid entitlement on a timer,
 * and the timer is the only thing that distinguishes it from a subscription.**
 * Getting that wrong in either direction is a real failure — never ending the
 * trial means "start free" quietly becomes "start permanently Pro"; ending it
 * by guessing from `currentPeriodEnd` means a paying customer whose webhook is
 * a minute late gets downgraded to free. Hence a dedicated `trialEndsAt`
 * column: NULL means "not a trial", and only a non-null value can lapse.
 */

import { prisma } from "@/lib/db";

import { ensurePlans } from "./billing";

/** Trial length. Operator-tunable so a deployment can run a longer evaluation. */
export function trialDays(): number {
  const raw = Number(process.env.TRIAL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 14;
}

/** Below this many days remaining, the UI starts prompting for conversion. */
export const TRIAL_WARNING_DAYS = 3;

const DAY_MS = 86_400_000;

export interface TrialStatus {
  /** Is there a live trial right now? */
  active: boolean;
  /** The plan the trial is on (pro), or null when there is no trial. */
  planId: string | null;
  endsAt: Date | null;
  /** Whole days left, floored at 0. Null when there is no live trial. */
  daysRemaining: number | null;
  /** True inside the final TRIAL_WARNING_DAYS window — the conversion prompt. */
  expiringSoon: boolean;
}

/** A trial has lapsed once its deadline is at or before `now`. */
export function isTrialLapsed(trialEndsAt: Date | null | undefined, now: Date): boolean {
  return Boolean(trialEndsAt && trialEndsAt.getTime() <= now.getTime());
}

/**
 * Start (or leave alone) a workspace's Pro trial.
 *
 * Idempotent, and deliberately non-destructive:
 *  - a workspace that already has ANY subscription (trial, paid or cancelled)
 *    is left untouched — starting a trial over an existing paid subscription
 *    would be a way to hand out free Pro to a customer who already pays.
 *  - failures are swallowed. A trial is a marketing affordance; it must never
 *    be able to fail a signup. If the plan catalog is missing, the user simply
 *    gets the free tier, which is what they would have had anyway.
 */
export async function startTrial(workspaceId: string, now: Date = new Date()): Promise<TrialStatus> {
  const none: TrialStatus = { active: false, planId: null, endsAt: null, daysRemaining: null, expiringSoon: false };

  try {
    const existing = await prisma.subscription.findFirst({
      where: { workspaceId },
      select: { id: true },
    });
    if (existing) return trialStatusFor(workspaceId, now);

    // The Subscription -> Plan FK is onDelete: Restrict, so the plan row must
    // exist before the subscription can be created.
    await ensurePlans();

    const endsAt = new Date(now.getTime() + trialDays() * DAY_MS);
    await prisma.subscription.create({
      data: {
        workspaceId,
        planId: "pro",
        status: "active",
        interval: "month",
        currentPeriodStart: now,
        currentPeriodEnd: endsAt,
        trialEndsAt: endsAt,
        // No payment rail: a trial is not a purchase, so it must never look
        // like one to the invoice or webhook paths.
        provider: null,
      },
    });

    return { active: true, planId: "pro", endsAt, daysRemaining: trialDays(), expiringSoon: false };
  } catch {
    return none;
  }
}

/** Read a workspace's trial state without changing anything. */
export async function trialStatus(workspaceId: string, now: Date = new Date()): Promise<TrialStatus> {
  try {
    return await trialStatusFor(workspaceId, now);
  } catch {
    return { active: false, planId: null, endsAt: null, daysRemaining: null, expiringSoon: false };
  }
}

async function trialStatusFor(workspaceId: string, now: Date): Promise<TrialStatus> {
  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, trialEndsAt: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { planId: true, status: true, trialEndsAt: true },
  });

  const inactive: TrialStatus = {
    active: false,
    planId: sub ? sub.planId : null,
    endsAt: sub?.trialEndsAt ?? null,
    daysRemaining: null,
    expiringSoon: false,
  };
  if (!sub?.trialEndsAt || sub.status !== "active" || isTrialLapsed(sub.trialEndsAt, now)) return inactive;

  const msLeft = sub.trialEndsAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(msLeft / DAY_MS);
  return {
    active: true,
    planId: sub.planId,
    endsAt: sub.trialEndsAt,
    daysRemaining,
    expiringSoon: daysRemaining <= TRIAL_WARNING_DAYS,
  };
}

/**
 * Converting a lapsed trial into a real subscription.
 *
 * Called by the payment rails once money is actually recorded: it clears
 * `trialEndsAt` so the entitlement stops being time-boxed, and moves the period
 * end to the paid cycle.
 */
export async function clearTrialOnPurchase(workspaceId: string, now: Date = new Date()): Promise<void> {
  await prisma.subscription.updateMany({
    where: { workspaceId, trialEndsAt: { not: null } },
    data: {
      trialEndsAt: null,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
    },
  });
}

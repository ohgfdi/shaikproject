import { LockKeyhole } from "lucide-react";
import Link from "next/link";

import { PLAN_GATE_EXPLANATION, planGateLabel, type PaidPlan } from "@/lib/client/plan-gate";
import { cn } from "@/lib/utils";

/**
 * The pre-click upgrade state.
 *
 * The server gate is the authority (402 PLAN_UPGRADE_REQUIRED). This component
 * is what the user sees at the moment they hit it, so the wall is a route to
 * Billing rather than a dead end — and it repeats the product rule that a plan
 * never changes a computed result.
 */
export function UpgradeNotice({ plan, feature, className }: { plan: PaidPlan; feature: string; className?: string }) {
  const planName = planGateLabel(plan);
  return (
    <div role="status" className={cn("rounded-lg border border-accent/40 bg-accent/8 p-4", className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <LockKeyhole aria-hidden className="size-4 text-accent" />
        {feature} is a {planName} feature
      </p>
      <p className="mt-1 text-caption text-muted">{PLAN_GATE_EXPLANATION}</p>
      <Link
        href="/settings?tab=billing"
        className="mt-2 inline-block text-sm font-medium text-accent-strong underline underline-offset-2"
      >
        See {planName} in Settings → Billing
      </Link>
    </div>
  );
}

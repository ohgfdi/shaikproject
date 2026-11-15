"use client";

/**
 * Plan-gate recognition on the client.
 *
 * The API already answers a blocked distribution feature with
 * `402 PLAN_UPGRADE_REQUIRED` and a grep-able remedy token in the message:
 *
 *   … Remedy: PLAN_REQUIRED:pro — upgrade in Settings → Billing.
 *
 * Parsing that token here (rather than string-matching copy in every panel)
 * keeps one contract: a panel can turn the server's refusal into an upgrade
 * notice instead of a red error, and a new plan gate needs no UI work beyond
 * rendering the notice.
 *
 * Duck-typed on purpose: the unit test imports this module without booting the
 * fetch/cache client.
 */

export type PaidPlan = "pro" | "firm";

export interface PlanGateInfo {
  plan: PaidPlan;
  /** The original server message, shown as supporting copy when useful. */
  message: string;
}

const REMEDY = /PLAN_REQUIRED:(pro|firm)/;

function isApiClientError(err: unknown): err is { status: number; code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "code" in err &&
    "message" in err &&
    typeof (err as { status: unknown }).status === "number" &&
    typeof (err as { message: unknown }).message === "string"
  );
}

/** The upgrade target for a blocked call, or null when this is a normal error. */
export function planGateFromError(err: unknown): PlanGateInfo | null {
  if (!isApiClientError(err)) return null;
  if (err.status !== 402 && err.code !== "PLAN_UPGRADE_REQUIRED") return null;
  const match = REMEDY.exec(err.message);
  if (!match) return null;
  return { plan: match[1] as PaidPlan, message: err.message };
}

export function planGateLabel(plan: PaidPlan): string {
  return plan === "pro" ? "Pro" : "Firm";
}

/** One sentence explaining the rule, so an upgrade prompt never implies lost data. */
export const PLAN_GATE_EXPLANATION =
  "Your data and every computed number stay exactly as they are — plans gate distribution and automation only.";

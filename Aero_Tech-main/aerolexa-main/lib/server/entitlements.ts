/**
 * Plan entitlements — the monetization gate.
 *
 * Until now `lib/server/billing.ts` was bookkeeping only: plans existed but
 * NOTHING was gated, so there was no reason to upgrade. This module is the
 * enforcement half, with one hard rule inherited from the repo's trust bar:
 *
 *   ❗ Plans gate CAPACITY and DISTRIBUTION — never computed results.
 *
 *   Gated (how much / how far the work product travels):
 *     - org seats            (collaboration capacity)
 *     - public share links   (distribution of dashboards/reports/notebooks)
 *     - external connectors  (data-platform capacity)
 *     - scheduled reports    (automation capacity)
 *     - API keys + the public API (programmatic distribution)
 *     - scheduled connector sync (pipeline automation)
 * - scheduled-notebook publishing (Hex-style app distribution)
 *
 * tenancy-audit: global-operator — entitlements module gates plan capacity
 * and distribution. This is a deployment-wide aggregate rather than a per-tenant
 * query.
 *
 * NEVER gated: every engine, analysis, statistic, export of YOUR data.
 *   A free user's EDA numbers are exactly as computed as a Firm user's.
 *
 * Operators can override any limit with PLAN_OVERRIDES (JSON) — e.g. a
 * grandfathered customer — without a code deploy:
 *   PLAN_OVERRIDES={"pro":{"maxOrgSeats":50}}
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export type PlanId = "free" | "pro" | "firm";

/** Capacity/distribution entitlements per plan. Null = unlimited. */
export interface PlanEntitlements {
  maxOrgSeats: number | null;
  publicShareLinks: boolean;
  externalConnectors: boolean;
  scheduledReports: boolean;
  apiKeys: boolean;
  scheduledConnectorSync: boolean;
  scheduledNotebookPublish: boolean;
  /** Maximum active API keys per workspace (null = unlimited). */
  maxApiKeys: number | null;
}

const UNLIMITED: PlanEntitlements = {
  maxOrgSeats: null,
  publicShareLinks: true,
  externalConnectors: true,
  scheduledReports: true,
  apiKeys: true,
  scheduledConnectorSync: true,
  scheduledNotebookPublish: true,
  maxApiKeys: null,
};

const PRO: PlanEntitlements = {
  ...UNLIMITED,
  maxOrgSeats: 1, // Pro is a solo consultant; orgs are the Firm tier
};

const FREE: PlanEntitlements = {
  maxOrgSeats: 0,
  publicShareLinks: false,
  externalConnectors: false,
  scheduledReports: false,
  apiKeys: false,
  scheduledConnectorSync: false,
  scheduledNotebookPublish: false,
  maxApiKeys: 0,
};

export const PLAN_ENTITLEMENTS: Record<PlanId, PlanEntitlements> = {
  free: FREE,
  pro: PRO,
  firm: UNLIMITED,
};

/** Operator overrides: PLAN_OVERRIDES={"pro":{"maxOrgSeats":50}} */
function loadOverrides(): Partial<Record<PlanId, Partial<PlanEntitlements>>> {
  try {
    const raw = process.env.PLAN_OVERRIDES?.trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<PlanId, Partial<PlanEntitlements>>> = {};
    for (const [plan, patch] of Object.entries(parsed)) {
      if ((["free", "pro", "firm"] as string[]).includes(plan) && patch && typeof patch === "object") {
        out[plan as PlanId] = patch as Partial<PlanEntitlements>;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve a workspace's plan id from its active subscription (default free).
 *
 * A lapsed TRIAL resolves to free. Note this is deliberately narrow: it only
 * applies when `trialEndsAt` is set, because only a trial has a deadline this
 * function is entitled to enforce. A genuine paid subscription whose
 * `currentPeriodEnd` has slipped is still entitled — the payment rail, not a
 * local clock read, is the authority on whether money arrived. Checking the
 * period end here would downgrade paying customers whenever a webhook lagged.
 */
export async function workspacePlanId(workspaceId: string, now: Date = new Date()): Promise<PlanId> {
  const sub = await prisma.subscription.findFirst({
    where: { workspaceId, status: "active" },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (sub?.trialEndsAt && sub.trialEndsAt.getTime() <= now.getTime()) return "free";
  const id = sub?.plan?.id;
  return id === "pro" || id === "firm" ? id : "free";
}

export async function entitlementsForWorkspace(workspaceId: string): Promise<PlanEntitlements> {
  const plan = await workspacePlanId(workspaceId);
  const base = PLAN_ENTITLEMENTS[plan];
  const patch = loadOverrides()[plan];
  return patch ? { ...base, ...patch } : base;
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

export interface GateOptions {
  /** Custom message for the upgrade prompt. */
  feature?: string;
}

function entitlementError(entitlement: string, feature: string): ApiError {
  return new ApiError(
    402,
    "PLAN_UPGRADE_REQUIRED",
    `${feature} requires a paid plan (the ${entitlement} entitlement). ` +
      "How to fix: upgrade to Pro or Firm in Settings → Billing. " +
      "Note: billing never changes computed results — this only gates capacity/distribution.",
  );
}

/** Throw 402 unless the workspace's plan grants the boolean entitlement. */
export async function requireEntitlement(
  workspaceId: string,
  entitlement: keyof PlanEntitlements,
  opts: GateOptions = {},
): Promise<void> {
  const ent = await entitlementsForWorkspace(workspaceId);
  if (ent[entitlement] !== true) {
    throw entitlementError(entitlement, opts.feature ?? "This feature");
  }
}

// ---------------------------------------------------------------------------
// Seat counting (org members) — for maxOrgSeats
// ---------------------------------------------------------------------------

/**
 * Current seat usage: distinct org members for an organization.
 * OWNER is always allowed a seat (they pay the bill), so enforcement counts
 * non-owner members against maxOrgSeats.
 */
export async function countOrgSeats(organizationId: string): Promise<number> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId },
    select: { userId: true },
  });
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { ownerId: true },
  });
  const ownerId = org?.ownerId;
  return ownerId ? members.filter((m) => m.userId !== ownerId).length : members.length;
}

/**
 * Resolve the plan for an ORGANIZATION: the owner's workspace holds the
 * subscription (Organization has no workspace of its own).
 */
export async function entitlementsForOrganization(organizationId: string): Promise<PlanEntitlements> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { owner: { select: { workspaceId: true } } },
  });
  const workspaceId = org?.owner?.workspaceId;
  return workspaceId ? entitlementsForWorkspace(workspaceId) : PLAN_ENTITLEMENTS.free;
}

/**
 * Enforce the seat limit when adding an organization member.
 * Free (maxOrgSeats: 0) can never add members; Pro = owner-only (solo);
 * Firm = unlimited. The plan is the ORG OWNER's subscription — the org is
 * their billable entity.
 */
export async function requireOrgSeatAvailable(organizationId: string): Promise<void> {
  const ent = await entitlementsForOrganization(organizationId);
  if (ent.maxOrgSeats === null) return;
  const seats = await countOrgSeats(organizationId);
  if (seats + 1 > ent.maxOrgSeats) {
    throw new ApiError(
      402,
      "PLAN_UPGRADE_REQUIRED",
      `Your plan includes ${ent.maxOrgSeats} org seat${ent.maxOrgSeats === 1 ? "" : "s"} (this invite would be seat ${seats + 1}). ` +
        "How to fix: upgrade to Firm for unlimited team seats in Settings → Billing.",
    );
  }
}

// ---------------------------------------------------------------------------
// Counting helpers for capped resources
// ---------------------------------------------------------------------------

export async function countActiveApiKeys(workspaceId: string): Promise<number> {
  return prisma.userApiKey.count({ where: { workspaceId, revokedAt: null } });
}

/**
 * Enforce the API-key cap. Throws 402 with the current usage when exceeded.
 */
export async function requireApiKeyAvailable(workspaceId: string): Promise<void> {
  const ent = await entitlementsForWorkspace(workspaceId);
  if (ent.maxApiKeys === null) return;
  const used = await countActiveApiKeys(workspaceId);
  if (used + 1 > ent.maxApiKeys) {
    throw new ApiError(
      402,
      "PLAN_UPGRADE_REQUIRED",
      `Your plan includes ${ent.maxApiKeys} active API key${ent.maxApiKeys === 1 ? "" : "s"} (you have ${used}). ` +
        "How to fix: upgrade to Pro or Firm in Settings → Billing.",
    );
  }
}

/** Feature-flag surface for the UI (Settings → Billing shows what's unlocked). */
export async function entitlementsView(workspaceId: string) {
  const [plan, ent] = await Promise.all([workspacePlanId(workspaceId), entitlementsForWorkspace(workspaceId)]);
  return { plan, ...ent };
}

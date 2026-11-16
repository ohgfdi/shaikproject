/**
 * Plan feature gates — DISTRIBUTION features only.
 *
 * Inherited rule from lib/server/billing.ts, restated because it is the whole
 * point of this file:
 *
 *   No plan gates any engine: billing is bookkeeping, not a meter that changes
 *   computed results.
 *
 * What IS gated here is how far the work product travels and who can reach it:
 * public share links, scheduled deliveries, scheduled connector sync, API
 * keys, org seats beyond the solo cap, SSO and audit-trail export.
 *
 * The boolean capacity matrix (publicShareLinks / scheduledReports /
 * externalConnectors / scheduledConnectorSync / apiKeys / maxOrgSeats) lives
 * in lib/server/entitlements.ts (PLAN_ENTITLEMENTS) and is reused here — one
 * matrix, not two. This module adds the Firm-only governance features (SSO,
 * audit export) that entitlements does not model, the pure per-plan feature
 * list the UI and tests consume, and the remedy-string contract:
 *
 *   A blocked call fails with the repo's plan error (402 PLAN_UPGRADE_REQUIRED)
 *   whose message carries an exact remedy token `PLAN_REQUIRED:<plan>` — the
 *   same "message contains the fix" pattern lib/server/modules.ts uses for
 *   MODULE_DISABLED, so clients and support can grep one string.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - billing features are a deployment-wide aggregate operation
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PLAN_ENTITLEMENTS, workspacePlanId, type PlanId } from "@/lib/server/entitlements";

/** Distribution/governance features a plan can grant. */
export type PlanFeature =
  | "publicShareLinks"
  | "scheduledReports"
  | "scheduledConnectorSync"
  | "apiKeys"
  | "scheduledNotebookPublish"
  | "orgSeats"
  | "sso"
  | "auditExport";

/** Every distribution feature, in plan order. Free grants none of these. */
export const PLAN_FEATURES: PlanFeature[] = [
  "publicShareLinks",
  "scheduledReports",
  "scheduledConnectorSync",
  "apiKeys",
  "scheduledNotebookPublish",
  "orgSeats",
  "sso",
  "auditExport",
];

/**
 * Features a plan holds. Derived from PLAN_ENTITLEMENTS (capacity/distribution)
 * plus the Firm-only governance pair. free → []; pro → the Pro distribution
 * set; firm → everything Pro has plus seats/SSO/audit export.
 */
export function featuresForPlan(planId: PlanId): PlanFeature[] {
  const ent = PLAN_ENTITLEMENTS[planId];
  const features: PlanFeature[] = [];
  if (ent.publicShareLinks) features.push("publicShareLinks");
  if (ent.scheduledReports) features.push("scheduledReports");
  if (ent.scheduledConnectorSync) features.push("scheduledConnectorSync");
  if (ent.apiKeys) features.push("apiKeys");
  if (ent.scheduledNotebookPublish) features.push("scheduledNotebookPublish");
  if (planId === "firm") features.push("orgSeats", "sso", "auditExport");
  return features;
}

export function planHasFeature(planId: PlanId, feature: PlanFeature): boolean {
  return featuresForPlan(planId).includes(feature);
}

/** The cheapest plan that grants the feature (the remedy's upgrade target). */
export function minimumPlanFor(feature: PlanFeature): PlanId {
  return planHasFeature("pro", feature) ? "pro" : "firm";
}

/**
 * The exact remedy token for a blocked feature — `PLAN_REQUIRED:<plan>` —
 * kept in one place so tests pin the contract clients rely on.
 */
export function planRequiredRemedy(feature: PlanFeature): string {
  return `PLAN_REQUIRED:${minimumPlanFor(feature)}`;
}

/** The thrown gate error: repo plan error shape + remedy token in the message. */
export function planFeatureError(feature: PlanFeature, featureLabel: string): ApiError {
  const remedy = planRequiredRemedy(feature);
  return new ApiError(
    402,
    "PLAN_UPGRADE_REQUIRED",
    `${featureLabel} is not in your current plan. Remedy: ${remedy} — upgrade in Settings → Billing. ` +
      "Note: billing never changes computed results; this only gates distribution and governance.",
  );
}

/**
 * Throw unless the WORKSPACE's plan grants the feature. Resolves the plan the
 * same way every existing gate does (owner subscription; lapsed trial → free)
 * and honours PLAN_OVERRIDES. Call at the creation/rotation point only —
 * reading, editing or analysing your own data is never gated.
 */
export async function requirePlanFeature(
  workspaceId: string,
  feature: PlanFeature,
  featureLabel = "This feature",
): Promise<void> {
  const plan = await workspacePlanId(workspaceId);
  if (!planHasFeature(plan, feature)) throw planFeatureError(feature, featureLabel);
}

/** Org-scoped twin — the plan is the ORG OWNER's subscription (see entitlements). */
export async function requirePlanFeatureForOrganization(
  organizationId: string,
  feature: PlanFeature,
  featureLabel = "This feature",
): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { owner: { select: { workspaceId: true } } },
  });
  const plan = org?.owner?.workspaceId ? await workspacePlanId(org.owner.workspaceId) : "free";
  if (!planHasFeature(plan, feature)) throw planFeatureError(feature, featureLabel);
}

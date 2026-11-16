/**
 * DPDP Act 2023 readiness — consent registry, data portability, right to erasure.
 *
 * Implements the three primitives the Act demands of a data fiduciary:
 *
 *  1. CONSENT      — itemized, versioned, revocable. Every purpose (service,
 *                    product improvement, marketing) is a `ConsentRecord` row
 *                    captured at signup and stored with the exact policy
 *                    version the user saw. Withdrawing flips `granted=false`
 *                    (never deletes the row — the Act requires proof).
 *  2. PORTABILITY  — `buildPortabilityBundle()` in `lib/server/portability.ts`
 *                    returns every row tied to the user in a machine-readable
 *                    JSON bundle, with a manifest of what was included and
 *                    which credential fields were withheld (the "right to
 *                    access").
 *  3. ERASURE      — `eraseUser()` anonymizes PII, deletes the personal
 *                    workspace (cascade removes owned artifacts), removes
 *                    org memberships, revokes API keys and sessions, and
 *                    records a durable `ComplianceEvent` (kind DPDP_ERASURE)
 *                    for the retention obligation. That evidence must live in
 *                    `ComplianceEvent`, NOT `Activity`: Activity cascades with
 *                    the workspace erasure deletes, so a proof row there was
 *                    erased by the very operation it documented.
 *                    Org artifacts the user created are preserved (they belong
 *                    to the firm) with `createdById` retained but the User row
 *                    anonymized — DPDP erases personal data, not business records.
 *
 * Deletion of the User row itself is NOT performed (artifact FKs are
 * `onDelete: Restrict` by design); anonymization achieves the statutory goal
 * because no personal data remains attributable to the data principal.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - DPDP Act compliance is a deployment-wide aggregate operation
import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";

/** The itemized consent purposes shown at signup. Versioned. */
export const CONSENT_POLICY_VERSION = "2026-09-20.1";

export const CONSENT_PURPOSES = [
  {
    id: "service",
    required: true,
    description:
      "Provide the service: store your uploads, compute analyses, and render dashboards/reports inside your workspace.",
  },
  {
    id: "product-improvement",
    required: false,
    description:
      "Product improvement: aggregated, de-identified usage analytics to fix bugs and prioritize features. Optional.",
  },
  {
    id: "marketing",
    required: false,
    description: "Marketing: occasional product updates by email. Optional; can be withdrawn anytime.",
  },
] as const;

export type ConsentPurposeId = (typeof CONSENT_PURPOSES)[number]["id"];

/** Persist one consent decision (granted or refused) for auditability. */
export async function recordConsent(input: {
  userId: string;
  purpose: ConsentPurposeId;
  granted: boolean;
  ipHash?: string | null;
}): Promise<void> {
  if (!CONSENT_PURPOSES.some((p) => p.id === input.purpose)) {
    throw new Error(`Unknown consent purpose: ${input.purpose}`);
  }
  await prisma.consentRecord.create({
    data: {
      userId: input.userId,
      purpose: input.purpose,
      granted: input.granted,
      policyVersion: CONSENT_POLICY_VERSION,
      ipHash: input.ipHash ?? null,
    },
  });
}

/** Record the full itemized signup consent set in one call. */
export async function recordSignupConsents(
  userId: string,
  grants: Partial<Record<ConsentPurposeId, boolean>>,
  ipHash?: string | null,
): Promise<void> {
  for (const purpose of CONSENT_PURPOSES) {
    // Required purposes are always granted (service cannot work otherwise);
    // optional purposes default to refused (DPDP forbids pre-ticked boxes).
    const granted = purpose.required ? true : (grants[purpose.id] ?? false);
    await recordConsent({ userId, purpose: purpose.id, granted, ipHash });
  }
}

/** Current consent state per purpose (latest record wins). */
export async function currentConsents(userId: string): Promise<Record<string, boolean>> {
  const rows = await prisma.consentRecord.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const state: Record<string, boolean> = {};
  for (const row of rows) {
    if (!(row.purpose in state)) state[row.purpose] = row.granted;
  }
  return state;
}

/** Withdraw (or re-grant) a previously recorded consent. */
export async function withdrawConsent(userId: string, purpose: ConsentPurposeId, granted = false): Promise<void> {
  await recordConsent({ userId, purpose, granted });
}

/** Stable one-way hash of the request IP for consent proof (no raw IP stored). */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/**
 * Append durable compliance evidence that must outlive the data it describes.
 *
 * Stored in `ComplianceEvent` (no workspace/tenant FK, no cascade) because the
 * DPDP erasure proof cannot live in `Activity` — Activity cascades when the
 * personal workspace is deleted, so the proof was being deleted by the erasure
 * it recorded.
 *
 * It throws on write failure by design: evidence that silently fails to record
 * is not evidence, so callers must treat a failure here as a failed erasure.
 */
export async function recordComplianceEvent(input: {
  kind: string;
  subjectId?: string | null;
  organizationId?: string | null;
  ipHash?: string | null;
  detail?: string | null;
}): Promise<void> {
  await prisma.complianceEvent.create({
    data: {
      kind: input.kind,
      subjectId: input.subjectId ?? null,
      organizationId: input.organizationId ?? null,
      ipHash: input.ipHash ?? null,
      detail: input.detail ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Right to access / portability
//
// Implemented in lib/server/portability.ts (buildPortabilityBundle). An
// earlier `exportUserData()` lived here and returned metadata stubs —
// `{ id, name, rowCount }` for datasets, `{ id, title }` for notebooks —
// which is an index of the subject's data rather than a copy of it: notebook
// cells, chat transcripts, report sections and analysis configs were all
// absent. It was removed rather than kept alongside the bundle, because two
// competing export paths is how a compliance control quietly stops being one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Right to erasure
// ---------------------------------------------------------------------------

export interface ErasureResult {
  anonymized: true;
  workspaceDeleted: boolean;
  orgMembershipsRemoved: number;
  projectMembershipsRemoved: number;
  apiKeysRevoked: number;
  anonymousId: string;
}

/**
 * Erase the user's personal data. Safe to call for org members: firm artifacts
 * survive; only the person is anonymized. Returns a summary for the audit log.
 *
 * The durable proof-of-erasure `ComplianceEvent` is written HERE (not by the
 * route) so the guarantee is intrinsic to erasure: evidence only exists if the
 * erasure above it completed, and no caller can forget to record it.
 */
export async function eraseUser(
  userId: string,
  context?: { ipHash?: string | null; reason?: string | null },
): Promise<ErasureResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  // Deterministic anonymous identity: the same user always maps to the same
  // placeholder, so historical audit rows stay internally consistent without
  // retaining any personal data.
  const anonymousId = `deleted-user-${createHash("sha256").update(userId).digest("hex").slice(0, 12)}`;

  // 1. Revoke every API key (dead credentials must not outlive the account).
  const revoked = await prisma.userApiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // 2. Remove memberships (org + project sharing rows reference the person).
  const orgRemoved = await prisma.organizationMember.deleteMany({ where: { userId } });
  const projRemoved = await prisma.projectMember.deleteMany({ where: { userId } });

  // 3. Delete the personal workspace — cascades to owned datasets, analyses,
  //    dashboards, reports, notebooks, schedules, chats, prompts, etc.
  //
  //    Detach the owner FIRST. `User.workspace` is `onDelete: Cascade`, so
  //    deleting a Workspace deletes its owning User row; step 4 below then
  //    fails with "No record was found for an update", leaving a half-erased
  //    account and a 500. Clearing `workspaceId` removes the FK edge, so the
  //    delete still cascades through the workspace's own children but never
  //    reaches the identity row we are about to anonymize. (It also unblocks
  //    org members, whose firm artifacts hold Restrict FKs to the user row.)
  let workspaceDeleted = false;
  if (user.workspaceId) {
    const ws = await prisma.workspace.findUnique({ where: { id: user.workspaceId }, select: { id: true } });
    if (ws) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { workspaceId: null } }),
        prisma.workspace.delete({ where: { id: ws.id } }),
      ]);
      workspaceDeleted = true;
    }
  }

  // 4. Anonymize the identity row. Activity.actorId is SetNull on delete, so we
  //    keep the User row (Restrict FKs from firm artifacts) but strip all PII:
  //    email is unique in the schema — rewrite it to the anonymous id.
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: `${anonymousId}@erased.invalid`,
      name: "Deleted user",
      passwordHash: `!erased:${anonymousId}`, // bcrypt-verify will always fail
      profileRole: null,
      goals: null,
      organization: null,
      industry: null,
      experience: null,
      onboardedAt: null,
    },
  });

  // 5. Verification tokens reference the user with Cascade; clean leftovers.
  await prisma.verificationToken.deleteMany({ where: { userId } });

  // 6. Durable proof of the erasure. Stored in ComplianceEvent (no workspace
  //    FK, no cascade) so it survives the workspace deletion in step 3 — the
  //    Activity row written by the route does not, which is why this exists.
  //    Written last: it only exists if every step above committed.
  await recordComplianceEvent({
    kind: "DPDP_ERASURE",
    subjectId: userId,
    ipHash: context?.ipHash ?? null,
    detail:
      `workspace=${workspaceDeleted ? "deleted" : "none"} ` +
      `orgMemberships=${orgRemoved.count} projectMemberships=${projRemoved.count} ` +
      `apiKeys=${revoked.count}` +
      (context?.reason ? ` reasonChars=${context.reason.length}` : ""),
  });

  return {
    anonymized: true,
    workspaceDeleted,
    orgMembershipsRemoved: orgRemoved.count,
    projectMembershipsRemoved: projRemoved.count,
    apiKeysRevoked: revoked.count,
    anonymousId,
  };
}

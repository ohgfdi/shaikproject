/**
 * Engagement governance — the CA-practice layer over the firm/client tenancy.
 *
 * Companion to lib/server/members.ts + lib/server/organization.ts.
 *
 * Tenancy recap (already in the schema and members.ts):
 *   Organization (the firm) ──> OrganizationMember (firm-wide role)
 *   Organization ──> Engagement (one client silo) ──> Project[] ──> artifacts
 *
 * This module adds the CA-practice semantics a firm actually runs on:
 *
 *  1. PRACTICE ROLES — PARTNER > MANAGER > REVIEWER > SENIOR > ASSISTANT, plus
 *     a read-only AUDITOR. These are layered over the underlying ProjectRole
 *     space (OWNER|EDITOR|VIEWER|AUDITOR) so nothing else in the app changes.
 *
 *  2. ENGAGEMENT-SCOPED ACCESS — access is per client engagement, not just
 *     firm-wide. An explicit EngagementMember row assigns a practice role on
 *     ONE engagement; a firm role is only a fallback. This is the difference
 *     between "works at the firm" and "works on this client".
 *
 *  3. JURISDICTION-AWARE RETENTION — every engagement carries a jurisdiction
 *     (default India) and a computed retention floor; a legal hold suspends
 *     purge regardless. See lib/server/jurisdiction.ts.
 *
 *  4. INDIA-CA DATA CLASSIFICATION — PAN/GSTIN/CIN/DIN/Aadhaar/bank identifiers
 *     are classified and redacted by role, so a non-partner export never leaks
 *     a full taxpayer identifier.
 *
 * All checks are server-side only. The engagement is resolved from the caller's
 * organization first, so a caller can never learn whether an engagement in
 * another firm exists (404, never 403).
 */

import { ApiError, forbiddenError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import { jurisdictionProfile, retentionFloorDays, retentionUntilFor } from "@/lib/server/jurisdiction";
import { requireOrgRole } from "@/lib/server/members";
import { withTenantDb } from "@/lib/server/tenant-db";
import type {
  DataClassification,
  OrganizationPrivacySettings,
  OrganizationRole,
  OrganizationSettings,
  PracticeRole,
  ProjectRole,
} from "@/lib/types";

export type { OrganizationRole, OrganizationSettings, PracticeRole } from "@/lib/types";
export { requireOrgRole } from "@/lib/server/members";

// ---------------------------------------------------------------------------
// Practice roles
// ---------------------------------------------------------------------------

/** Backwards-compatible alias: the CA practice role on an engagement. */
export type EngagementPracticeRole = PracticeRole;

const PRACTICE_ROLES: readonly PracticeRole[] = ["PARTNER", "MANAGER", "REVIEWER", "SENIOR", "ASSISTANT", "AUDITOR"];

const PRACTICE_RANK: Record<PracticeRole, number> = {
  PARTNER: 6,
  MANAGER: 5,
  REVIEWER: 4,
  SENIOR: 3,
  ASSISTANT: 2,
  AUDITOR: 1,
};

const PRACTICE_LABEL: Record<PracticeRole, string> = {
  PARTNER: "Partner",
  MANAGER: "Manager",
  REVIEWER: "Reviewer",
  SENIOR: "Senior",
  ASSISTANT: "Assistant",
  AUDITOR: "Auditor (read-only)",
};

/** Narrow an arbitrary string to a practice role, or null. */
export function normalizePracticeRole(value: string | null | undefined): PracticeRole | null {
  return PRACTICE_ROLES.includes(value as PracticeRole) ? (value as PracticeRole) : null;
}

/** Map a practice role to the minimum ProjectRole it implies for writes. */
export function practiceRoleToProjectRole(role: PracticeRole): ProjectRole {
  switch (role) {
    case "PARTNER":
      return "OWNER";
    case "MANAGER":
    case "REVIEWER":
    case "SENIOR":
    case "ASSISTANT":
      return "EDITOR";
    case "AUDITOR":
      return "AUDITOR";
  }
}

/** Human label for the team UI. */
export function practiceRoleLabel(role: PracticeRole): string {
  return PRACTICE_LABEL[role] ?? role;
}

/** Numeric rank (higher = more authority). */
export function practiceRank(role: PracticeRole | null | undefined): number {
  return role ? PRACTICE_RANK[role] : 0;
}

/** Roles that can prepare/edit client work (not the read-only auditor). */
export function canPrepareWork(role: PracticeRole): boolean {
  return role !== "AUDITOR";
}

/** Roles that can review another preparer's work. */
export function canReview(role: PracticeRole): boolean {
  return role === "PARTNER" || role === "MANAGER" || role === "REVIEWER";
}

/** Roles that can approve/sign off a change to client data. */
export function canSignOff(role: PracticeRole): boolean {
  return role === "PARTNER" || role === "MANAGER";
}

/** Roles that can raise/own a change request. */
export function canRequestChange(role: PracticeRole): boolean {
  return role !== "AUDITOR";
}

/** Roles that may change who has access to an engagement. */
export function canManageAccess(role: PracticeRole): boolean {
  return role === "PARTNER" || role === "MANAGER";
}

/** Org role → practice role used when no explicit engagement assignment exists. */
const ORG_ROLE_TO_PRACTICE: Record<OrganizationRole, PracticeRole> = {
  OWNER: "PARTNER",
  ADMIN: "MANAGER",
  MEMBER: "ASSISTANT",
  AUDITOR: "AUDITOR",
};

/** ProjectMember role → practice role (legacy per-project sharing). */
const PROJECT_ROLE_TO_PRACTICE: Record<ProjectRole, PracticeRole> = {
  OWNER: "PARTNER",
  EDITOR: "SENIOR",
  VIEWER: "ASSISTANT",
  AUDITOR: "AUDITOR",
};

// ---------------------------------------------------------------------------
// Engagement resolution + access
// ---------------------------------------------------------------------------

/** Engagement row shape used by route handlers and this module. */
export interface EngagementRow {
  id: string;
  organizationId: string;
  name?: string;
  code?: string | null;
  jurisdiction?: string;
  status?: string;
  legalHold?: boolean;
  retentionUntil?: Date | null;
  dataClassification?: string;
  workspaceId?: string | null;
  ownerId?: string | null;
  createdAt?: Date;
}

/** Project context for an engagement (its artifact container). */
export interface EngagementProject {
  id: string;
  ownerId: string;
  workspaceId: string;
}

export interface EngagementContext {
  engagement: EngagementRow;
  project: EngagementProject | null;
}

/**
 * Load an engagement in the caller's firm (404 otherwise), together with its
 * first project. This is the single lookup every engagement route funnels
 * through, so org isolation is enforced in exactly one place.
 */
export async function loadEngagement(ctx: AuthContext, engagementId: string): Promise<EngagementContext> {
  if (!ctx.organization) throw notFoundError("Engagement not found.");
  return withTenantDb(ctx, async (db) => {
    const engagement = await db.engagement.findFirst({
      where: { id: engagementId, organizationId: ctx.organization!.id },
    });
    if (!engagement) throw notFoundError("Engagement not found.");
    const project = await db.project.findFirst({
      where: { engagementId: engagement.id, organizationId: ctx.organization!.id },
      select: { id: true, ownerId: true, workspaceId: true },
      orderBy: { updatedAt: "desc" },
    });
    return { engagement, project };
  });
}

/**
 * Resolve the caller's effective practice role on an engagement.
 *
 * Precedence (deliberate — the narrower grant wins over the broader one):
 *   1. explicit EngagementMember row (per-engagement assignment)
 *   2. ProjectMember row on the engagement's project (legacy sharing)
 *   3. the caller's firm-wide OrganizationMember role (fallback)
 *   4. otherwise no access (null)
 */
export async function engagementPracticeRole(
  ctx: AuthContext,
  engagement: EngagementRow,
  project?: EngagementProject | null,
): Promise<PracticeRole | null> {
  if (!ctx.organization || ctx.organization.id !== engagement.organizationId) return null;

  return withTenantDb(ctx, async (db) => {
    // 1. Explicit per-engagement assignment.
    const assignment = await db.engagementMember.findUnique({
      where: { engagementId_userId: { engagementId: engagement.id, userId: ctx.user.id } },
      select: { practiceRole: true },
    });
    const assigned = normalizePracticeRole(assignment?.practiceRole);
    if (assigned) return assigned;

    // 2. Legacy per-project membership.
    const projectId = project?.id ?? null;
    if (projectId) {
      const member = await db.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: ctx.user.id } },
        select: { role: true },
      });
      const mapped = member ? PROJECT_ROLE_TO_PRACTICE[member.role as ProjectRole] : undefined;
      if (mapped) return mapped;
    }

    // 3. Firm-wide role fallback.
    const orgMembership = await db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: engagement.organizationId, userId: ctx.user.id } },
      select: { role: true },
    });
    const orgRole = orgMembership?.role as OrganizationRole | undefined;
    return orgRole ? ORG_ROLE_TO_PRACTICE[orgRole] : null;
  });
}

/**
 * Assert the caller may act on the engagement with at least `min` practice
 * role. Throws 404 when the engagement is not in the caller's firm, 403 when
 * the role is insufficient. Returns the resolved role.
 */
export async function requireEngagementAccess(
  ctx: AuthContext,
  engagement: EngagementRow,
  project: EngagementProject | null | undefined,
  min: PracticeRole = "ASSISTANT",
): Promise<PracticeRole> {
  const role = await engagementPracticeRole(ctx, engagement, project ?? null);
  if (!role) throw notFoundError("Engagement not found.");
  if (practiceRank(role) < practiceRank(min)) {
    throw forbiddenError(`This action needs ${practiceRoleLabel(min)} access on the engagement.`);
  }
  return role;
}

/** Convenience: load the engagement, then assert `min` access. */
export async function requireEngagementRole(
  ctx: AuthContext,
  engagementId: string,
  min: PracticeRole = "ASSISTANT",
): Promise<{ role: PracticeRole; engagement: EngagementRow; project: EngagementProject | null }> {
  const { engagement, project } = await loadEngagement(ctx, engagementId);
  const role = await requireEngagementAccess(ctx, engagement, project, min);
  return { role, engagement, project };
}

// ---------------------------------------------------------------------------
// Per-engagement access management
// ---------------------------------------------------------------------------

export interface EngagementAccessEntry {
  userId: string;
  name: string;
  email: string;
  practiceRole: PracticeRole;
  source: "assigned" | "firm-role";
  assignedAt: string | null;
  isSelf: boolean;
}

/** Roster of who can act on the engagement, including firm-role fallbacks. */
export async function listEngagementAccess(
  ctx: AuthContext,
  engagementId: string,
): Promise<{ engagementId: string; assignments: EngagementAccessEntry[]; callerRole: PracticeRole }> {
  const { engagement, project } = await loadEngagement(ctx, engagementId);
  const callerRole = await requireEngagementAccess(ctx, engagement, project, "ASSISTANT");

  const [assignments, firmMembers] = await Promise.all([
    prisma.engagementMember.findMany({
      where: { engagementId: engagement.id },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    prisma.organizationMember.findMany({
      where: { organizationId: engagement.organizationId },
      include: { user: { select: { id: true, name: true, email: true } } },
      take: 200,
    }),
  ]);

  const assignedIds = new Set(assignments.map((a) => a.userId));
  const extraIds = assignments.map((a) => a.userId).filter((id) => !firmMembers.some((m) => m.userId === id));
  const extraUsers = extraIds.length
    ? await prisma.user.findMany({ where: { id: { in: extraIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userById = new Map<string, { id: string; name: string; email: string }>();
  for (const m of firmMembers) userById.set(m.user.id, m.user);
  for (const u of extraUsers) userById.set(u.id, u);

  const entries: EngagementAccessEntry[] = [];
  for (const a of assignments) {
    const user = userById.get(a.userId);
    if (!user) continue;
    const role = normalizePracticeRole(a.practiceRole) ?? "ASSISTANT";
    entries.push({
      userId: a.userId,
      name: user.name,
      email: user.email,
      practiceRole: role,
      source: "assigned",
      assignedAt: a.createdAt.toISOString(),
      isSelf: a.userId === ctx.user.id,
    });
  }
  for (const m of firmMembers) {
    if (assignedIds.has(m.userId)) continue;
    const orgRole = m.role as OrganizationRole;
    entries.push({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      practiceRole: ORG_ROLE_TO_PRACTICE[orgRole] ?? "ASSISTANT",
      source: "firm-role",
      assignedAt: null,
      isSelf: m.userId === ctx.user.id,
    });
  }

  return { engagementId: engagement.id, assignments: entries, callerRole };
}

export interface GrantEngagementAccessInput {
  userId: string;
  practiceRole: PracticeRole;
}

/**
 * Grant (or update) an explicit practice role on one engagement. Requires
 * firm-admin authority AND partner/manager standing on the engagement, and the
 * target must already be a member of the firm — access can be narrowed, never
 * extended beyond the firm.
 */
export async function grantEngagementAccess(
  ctx: AuthContext,
  engagementId: string,
  input: GrantEngagementAccessInput,
): Promise<EngagementAccessEntry> {
  if (!ctx.organization) throw notFoundError("Engagement not found.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");
  const { engagement, project } = await loadEngagement(ctx, engagementId);
  const callerRole = await requireEngagementAccess(ctx, engagement, project, "MANAGER");
  if (!canManageAccess(callerRole)) throw forbiddenError("Only a partner or manager may change engagement access.");

  const practiceRole = normalizePracticeRole(input.practiceRole);
  if (!practiceRole) throw new ApiError(400, "VALIDATION", "Invalid practice role.");

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: engagement.organizationId, userId: input.userId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!member) {
    throw new ApiError(400, "VALIDATION", "That user is not a member of this firm. Add them to the firm first.");
  }

  const row = await prisma.engagementMember.upsert({
    where: { engagementId_userId: { engagementId: engagement.id, userId: input.userId } },
    create: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      userId: input.userId,
      practiceRole,
      assignedById: ctx.user.id,
    },
    update: { practiceRole, assignedById: ctx.user.id },
  });

  await logOrgActivity(ctx, "ENGAGEMENT_ACCESS_GRANTED", `${member.user.name} → ${practiceRole} on this engagement`, {
    engagementId: engagement.id,
    userId: input.userId,
    practiceRole,
  });

  return {
    userId: member.user.id,
    name: member.user.name,
    email: member.user.email,
    practiceRole,
    source: "assigned",
    assignedAt: row.createdAt.toISOString(),
    isSelf: member.user.id === ctx.user.id,
  };
}

/** Remove an explicit practice role (the firm-role fallback then applies). */
export async function revokeEngagementAccess(
  ctx: AuthContext,
  engagementId: string,
  userId: string,
): Promise<{ removed: string }> {
  if (!ctx.organization) throw notFoundError("Engagement not found.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");
  const { engagement, project } = await loadEngagement(ctx, engagementId);
  const callerRole = await requireEngagementAccess(ctx, engagement, project, "MANAGER");
  if (!canManageAccess(callerRole)) throw forbiddenError("Only a partner or manager may change engagement access.");

  const existing = await prisma.engagementMember.findUnique({
    where: { engagementId_userId: { engagementId: engagement.id, userId } },
  });
  if (!existing) throw notFoundError("That user has no explicit assignment on this engagement.");

  await prisma.engagementMember.delete({ where: { id: existing.id } });
  await logOrgActivity(ctx, "ENGAGEMENT_ACCESS_REVOKED", `Explicit engagement access revoked`, {
    engagementId: engagement.id,
    userId,
  });
  return { removed: userId };
}

// ---------------------------------------------------------------------------
// India-CA sensitive data classification + redaction
// ---------------------------------------------------------------------------

/** Categories of sensitive client data under Indian practice posture. */
export type SensitiveCategory =
  | "pan"
  | "gstin"
  | "cin"
  | "din"
  | "tan"
  | "aadhaar_partial"
  | "bank_account_partial"
  | "taxpayer_name"
  | "employee_name"
  | "else";

const NAME_RE = /(^|_|\b)(name|clientname|payeename|employeename|partnername|directorname)$/i;

/**
 * Classify a field by its name (heuristic, by naming convention). Callers use
 * this before logging or exporting identifiers; the exact masking rules live in
 * redactSensitiveValue so the taxonomy can be tightened independently.
 */
export function classifySensitiveField(name: string, value?: string | null): SensitiveCategory {
  const key = (name ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (key === "pan" || key === "permanentaccountnumber") return "pan";
  if (key === "gstin" || key === "gst" || key === "gstno" || key === "gstnumber") return "gstin";
  if (key === "cin" || key === "corporateidentitynumber") return "cin";
  if (key === "din" || key === "directoridentificationnumber") return "din";
  if (key === "tan" || key === "taxdeductionaccountnumber") return "tan";
  if (key === "aadhaar" || key === "aadhaarnumber" || key === "uidai") return "aadhaar_partial";
  if (
    key === "accountnumber" ||
    key === "bankaccount" ||
    key === "bankaccountnumber" ||
    key === "ifsc" ||
    key.startsWith("bankac")
  ) {
    return "bank_account_partial";
  }
  if (NAME_RE.test(name ?? "") || key === "clientname" || key === "payeename" || key === "employeename") {
    return "taxpayer_name";
  }
  void value; // reserved for a value-shape fallback
  return "else";
}

/**
 * Redact an identifier for a caller who may not see it in full.
 *
 * Rules are India-CA oriented but conservative: PAN/GSTIN/CIN/DIN/TAN and
 * Aadhaar/bank values show only the last four characters; names are replaced
 * with a stable per-engagement pseudonym so a redacted export stays internally
 * consistent without revealing identity.
 */
export function redactSensitiveValue(
  category: SensitiveCategory,
  value: string | null | undefined,
  showFull: boolean,
): string {
  if (!value) return "";
  if (showFull) return value;

  const v = value.toString().trim();
  const last4 = v.length >= 4 ? v.slice(-4).toUpperCase() : "";
  switch (category) {
    case "pan":
      return last4 ? `PAN •••• ${last4}` : "PAN ••••";
    case "gstin":
      return last4 ? `GSTIN •••• ${last4}` : "GSTIN ••••";
    case "cin":
    case "din":
    case "tan":
      return last4 ? `•••• ${last4}` : "••••";
    case "aadhaar_partial":
    case "bank_account_partial":
      return last4 ? `•••• ${last4}` : "••••";
    case "taxpayer_name":
      return `Client ••• (${stableToken(v)})`;
    default:
      return v;
  }
}

/** Deterministic pseudonym token for names (so redacted exports stay consistent). */
export function stableToken(raw: string): string {
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return `X-${Math.abs(h).toString(36).slice(0, 6).toUpperCase()}`;
}

/**
 * Redact a structured payload's sensitive fields for a role that should not
 * see full identifiers. Returns a safe copy suitable for logs / exports /
 * change-request summaries; nested objects and string arrays are handled.
 */
export function redactPayload(
  payload: Record<string, unknown>,
  showFull: boolean,
  fieldCategories?: Partial<Record<string, SensitiveCategory>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const category = fieldCategories?.[key] ?? classifySensitiveField(key, value as string | undefined);
    if (value == null) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = redactSensitiveValue(category, value, showFull);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "string" ? redactSensitiveValue(category, v, showFull) : v));
    } else if (typeof value === "object") {
      out[key] = redactPayload(value as Record<string, unknown>, showFull, fieldCategories);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Free-text identifier scrubber. Field-name classification cannot protect an
 * identifier that a user typed into a narration or a change summary, so any
 * text bound for a redacted export or log passes through here first. Order
 * matters: GSTIN before PAN (a GSTIN contains a PAN-like substring).
 */
const TEXT_IDENTIFIER_PATTERNS: { category: SensitiveCategory; re: RegExp }[] = [
  { category: "gstin", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g },
  { category: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { category: "tan", re: /\b[A-Z]{4}\d{5}[A-Z]\b/g },
  { category: "cin", re: /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g },
  { category: "aadhaar_partial", re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
];

/** Mask every recognizable identifier scheme inside free text. */
export function scrubIdentifiersInText(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const { category, re } of TEXT_IDENTIFIER_PATTERNS) {
    out = out.replace(re, (match) => redactSensitiveValue(category, match.replace(/\s/g, ""), false));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Jurisdiction-aware retention posture
// ---------------------------------------------------------------------------

export interface EngagementRetention {
  jurisdiction: string;
  jurisdictionName: string;
  knownJurisdiction: boolean;
  classification: DataClassification;
  legalHold: boolean;
  /** The floor the law imposes, in days, from the engagement's creation. */
  floorDays: number;
  /** The effective purge-eligible instant (explicit or jurisdiction-derived). */
  purgeEligibleAt: string;
  /** True when a routine purge may run today. */
  purgeEligible: boolean;
  statutoryBases: string[];
}

/**
 * Compute the retention posture for an engagement under the firm's privacy
 * settings. A legal hold makes purge ineligible regardless of dates.
 */
export interface RetentionInput {
  jurisdiction?: string | null;
  legalHold?: boolean | null;
  retentionUntil?: Date | null;
  dataClassification?: string | null;
  createdAt?: Date;
}

export function engagementRetention(
  engagement: RetentionInput,
  privacy: OrganizationPrivacySettings,
  now: Date = new Date(),
): EngagementRetention {
  const jurisdiction = engagement.jurisdiction ?? "IN";
  const profile = jurisdictionProfile(jurisdiction);
  const floorDays = retentionFloorDays(jurisdiction, "working-paper");
  const explicit = engagement.retentionUntil ? new Date(engagement.retentionUntil) : null;
  const computed = retentionUntilFor(jurisdiction, new Date(engagement.createdAt ?? now), {
    kind: "working-paper",
    overrideDays: privacy.retentionDays,
  });
  const purgeEligibleAt = explicit && explicit > computed ? explicit : computed;
  const legalHold = engagement.legalHold === true;
  return {
    jurisdiction: profile.code,
    jurisdictionName: profile.name,
    knownJurisdiction: profile.code !== "??",
    classification: (engagement.dataClassification as DataClassification) ?? "CONFIDENTIAL",
    legalHold,
    floorDays,
    purgeEligibleAt: purgeEligibleAt.toISOString(),
    purgeEligible: !legalHold && now.getTime() >= purgeEligibleAt.getTime(),
    statutoryBases: profile.retentionBases,
  };
}

// ---------------------------------------------------------------------------
// Org privacy / retention settings
// ---------------------------------------------------------------------------

export const DEFAULT_ORG_PRIVACY: OrganizationPrivacySettings = {
  panRedactionDefault: true,
  fullDiffLoggingDefault: false,
  taxpayerExportConsentRequired: true,
  retentionDays: null,
  autoArchiveEngagementDays: null,
  crossBorderTransferAllowed: false,
  requireClientConsentForExport: true,
};

/**
 * Read the firm's privacy posture, filling every missing field with its safe
 * default. A legacy firm that never opened the panel is therefore compliant by
 * default (redact, require consent, no forced deletion).
 */
export function orgPrivacySettings(
  raw?: string | null,
): OrganizationSettings & { privacy: OrganizationPrivacySettings } {
  const base = parseJson<OrganizationSettings & { privacy?: unknown }>(raw ?? null, {});
  const stored =
    typeof base?.privacy === "object" && base.privacy ? (base.privacy as Partial<OrganizationPrivacySettings>) : {};
  return {
    ...base,
    privacy: { ...DEFAULT_ORG_PRIVACY, ...stored },
  } as OrganizationSettings & { privacy: OrganizationPrivacySettings };
}

export interface UpdateOrgPrivacyInput {
  panRedactionDefault?: boolean;
  fullDiffLoggingDefault?: boolean;
  taxpayerExportConsentRequired?: boolean;
  retentionDays?: number | null;
  autoArchiveEngagementDays?: number | null;
  crossBorderTransferAllowed?: boolean;
  requireClientConsentForExport?: boolean;
}

/** Update the firm privacy posture (ADMIN+). Returns the merged posture. */
export async function updateOrgPrivacy(
  ctx: AuthContext,
  input: UpdateOrgPrivacyInput,
): Promise<OrganizationPrivacySettings> {
  if (!ctx.organization) throw notFoundError("No organization.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");

  const current = await prisma.organization.findUnique({
    where: { id: ctx.organization.id },
    select: { settings: true },
  });
  const currentSettings = orgPrivacySettings(current?.settings ?? null);
  const mergedPrivacy: OrganizationPrivacySettings = { ...currentSettings.privacy, ...input };

  if (
    mergedPrivacy.retentionDays !== null &&
    (!Number.isFinite(mergedPrivacy.retentionDays) || mergedPrivacy.retentionDays < 0)
  ) {
    throw new ApiError(400, "VALIDATION", "retentionDays must be a non-negative number or null.");
  }
  if (
    mergedPrivacy.autoArchiveEngagementDays !== null &&
    (!Number.isFinite(mergedPrivacy.autoArchiveEngagementDays) || mergedPrivacy.autoArchiveEngagementDays < 0)
  ) {
    throw new ApiError(400, "VALIDATION", "autoArchiveEngagementDays must be a non-negative number or null.");
  }

  const merged = { ...currentSettings, privacy: mergedPrivacy };
  await prisma.organization.update({
    where: { id: ctx.organization.id },
    data: { settings: stringifyJson(merged) },
  });
  await logOrgActivity(ctx, "ORGANIZATION_PRIVACY_UPDATED", "Organization privacy/retention settings updated", {
    privacy: mergedPrivacy,
  });
  return mergedPrivacy;
}

// ---------------------------------------------------------------------------
// Org activity helper
// ---------------------------------------------------------------------------

/** Append an org-level activity row (best-effort; never blocks the caller). */
export async function logOrgActivity(
  ctx: AuthContext,
  kind: string,
  message: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await prisma.activity.create({
    data: {
      workspaceId: ctx.workspace.id,
      actorId: ctx.user.id,
      organizationId: ctx.organization?.id ?? null,
      type: kind,
      message,
      targetType: "organization",
      targetId: ctx.organization?.id ?? null,
      meta: stringifyJson(meta),
    },
  });
}

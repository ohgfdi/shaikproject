/**
 * Organization (firm) administration + Engagement (client silo) management.
 *
 * Tenancy model (lib/auth/guard.ts + lib/server/members.ts):
 *   User ── owns ──> Workspace (legacy single-tenant account)
 *   Organization (firm) ── has many ──> OrganizationMember (OWNER|ADMIN|MEMBER|AUDITOR)
 *   Organization ── has many ──> Engagement (per-client silo) ── owns ──> Project[] ──> artifacts
 *
 * An org member accesses an engagement's artifacts through the role mapping in
 * members.ts (OWNER→OWNER, ADMIN→EDITOR, MEMBER→VIEWER, AUDITOR→AUDITOR) even
 * when the project lives in a different member's workspace. All writes here are
 * guarded by requireOrgRole so a MEMBER/AUDITOR can never mutate firm config.
 *
 * Every query runs through withTenantDb(), so the workspace/firm GUCs the
 * PostgreSQL RLS policies compare against are set inside one transaction.
 * requireOrgRole() is deliberately called outside those transactions — it
 * resolves the role through its own scoped read, and nesting interactive
 * transactions is how deadlocks start.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { stringifyJson } from "@/lib/json";
import { requireOrgSeatAvailable } from "@/lib/server/entitlements";
import { listOrganizationMembers, orgRank, requireOrgRole } from "@/lib/server/members";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { OrganizationRole, OrganizationSettings } from "@/lib/types";

export const ORG_ADMIN_ROLES: OrganizationRole[] = ["OWNER", "ADMIN"];
export const INVITABLE_ORG_ROLES: OrganizationRole[] = ["ADMIN", "MEMBER", "AUDITOR"];

/** Single source of truth for allowed activity on org rows. */
export function assertOrgActivityOK(kind: string): string | null {
  const kinds = [
    "ORGANIZATION_CREATED",
    "ORGANIZATION_UPDATED",
    "ORGANIZATION_MEMBER_ADDED",
    "ORGANIZATION_MEMBER_UPDATED",
    "ORGANIZATION_MEMBER_REMOVED",
    "ENGAGEMENT_CREATED",
    "ENGAGEMENT_UPDATED",
    "ENGAGEMENT_ARCHIVED",
  ];
  return kinds.includes(kind) ? kind : null;
}

async function logOrgActivity(
  ctx: AuthContext,
  kind: string,
  message: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const resolved = assertOrgActivityOK(kind);
  if (!resolved) return;
  await withTenantDb(ctx, (db) =>
    db.activity.create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.user.id,
        organizationId: ctx.organization?.id ?? null,
        type: resolved,
        message,
        targetType: "organization",
        targetId: ctx.organization?.id ?? null,
        meta: stringifyJson(meta),
      },
    }),
  );
}

export interface OrgSnapshot {
  id: string;
  name: string;
  gstin: string | null;
  settings: OrganizationSettings | null;
  role: OrganizationRole | null;
  isOwner: boolean;
  memberCount: number;
  engagementCount: number;
  projectCount: number;
  createdAt: string;
}

const DEFAULT_ORG_SETTINGS: OrganizationSettings = {};

/** Current organization snapshot for the signed-in user, or null. */
export async function getOrganizationSnapshot(ctx: AuthContext): Promise<OrgSnapshot | null> {
  if (!ctx.organization) return null;
  const org = await withTenantDb(ctx, (db) =>
    db.organization.findUnique({
      where: { id: ctx.organization!.id },
      include: {
        _count: { select: { members: true, engagements: true, projects: true } },
      },
    }),
  );
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    gstin: org.gstin,
    settings: org.settings ? (JSON.parse(org.settings) as OrganizationSettings) : DEFAULT_ORG_SETTINGS,
    role: ctx.organizationRole as OrganizationRole | null,
    isOwner: org.ownerId === ctx.user.id,
    memberCount: org._count.members,
    engagementCount: org._count.engagements,
    projectCount: org._count.projects,
    createdAt: org.createdAt.toISOString(),
  };
}

export interface CreateOrgInput {
  name: string;
  gstin?: string;
  settings?: OrganizationSettings;
}

/** Create the firm account. The creator becomes the OWNER as an OrganizationMember. */
export async function createOrganization(ctx: AuthContext, input: CreateOrgInput): Promise<OrgSnapshot> {
  if (ctx.organization) {
    throw new ApiError(409, "ORGANIZATION_EXISTS", "This account already belongs to an organization.");
  }
  // DB-level guard: protects against a cold-start session where ctx.organization
  // is unset but a membership already exists.
  const existingMembership = await withTenantDb(ctx, (db) =>
    db.organizationMember.findFirst({ where: { userId: ctx.user.id } }),
  );
  if (existingMembership) {
    throw new ApiError(409, "ORGANIZATION_EXISTS", "This account already belongs to an organization.");
  }
  const name = input.name.trim();
  if (name.length < 2) throw new ApiError(400, "VALIDATION", "Organization name must be at least 2 characters.");

  const org = await withTenantDb(ctx, async (tx) => {
    const created = await tx.organization.create({
      data: {
        name,
        gstin: input.gstin?.trim() || null,
        settings: input.settings ? stringifyJson(input.settings) : null,
        ownerId: ctx.user.id,
      },
    });
    await tx.organizationMember.create({
      data: { organizationId: created.id, userId: ctx.user.id, role: "OWNER" },
    });
    return created;
  });

  await logOrgActivity(ctx, "ORGANIZATION_CREATED", `Organization “${name}” created`, { organizationId: org.id });
  return {
    id: org.id,
    name: org.name,
    gstin: org.gstin,
    settings: null,
    role: "OWNER",
    isOwner: true,
    memberCount: 1,
    engagementCount: 0,
    projectCount: 0,
    createdAt: org.createdAt.toISOString(),
  };
}

export interface UpdateOrgInput {
  name?: string;
  gstin?: string | null;
  settings?: OrganizationSettings;
}

export async function updateOrganization(ctx: AuthContext, input: UpdateOrgInput): Promise<OrgSnapshot> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");

  const org = await withTenantDb(ctx, (db) =>
    db.organization.update({
      where: { id: ctx.organization!.id },
      data: {
        name: input.name ? input.name.trim() : undefined,
        gstin: input.gstin === null ? null : input.gstin?.trim() || undefined,
        settings: input.settings ? stringifyJson(input.settings) : undefined,
      },
    }),
  );
  await logOrgActivity(ctx, "ORGANIZATION_UPDATED", `Organization “${org.name}” updated`, { organizationId: org.id });
  return (await getOrganizationSnapshot(ctx))!;
}

export type { OrgMemberWithRole } from "@/lib/server/members";

/** Firm roster (requires at least MEMBER/AUDITOR). */
export async function listOrgMembers(ctx: AuthContext): Promise<ReturnType<typeof listOrganizationMembers>> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
  return listOrganizationMembers(ctx.organization);
}

export interface InviteMemberInput {
  email: string;
  role: OrganizationRole;
}

export async function inviteOrganizationMember(ctx: AuthContext, input: InviteMemberInput): Promise<unknown> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");

  const email = (input.email ?? "").trim().toLowerCase();
  if (!email) throw new ApiError(400, "VALIDATION", "Enter the member's email address.");
  if (!INVITABLE_ORG_ROLES.includes(input.role)) {
    throw new ApiError(400, "VALIDATION", "Role must be ADMIN, MEMBER or AUDITOR (OWNER is reserved).");
  }
  const invited = await withTenantDb(ctx, (db) => db.user.findUnique({ where: { email } }));
  if (!invited) {
    throw new ApiError(400, "NOT_FOUND", `No account exists for “${email}”. They need to sign up first.`);
  }
  const existing = await withTenantDb(ctx, (db) =>
    db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: ctx.organization!.id, userId: invited.id } },
    }),
  );
  if (existing) throw new ApiError(400, "VALIDATION", "That user is already a member of this organization.");

  // Seat entitlement: Free includes no org seats, Pro is owner-only (solo),
  // Firm is unlimited. The org owner's subscription is the billable plan.
  await requireOrgSeatAvailable(ctx.organization.id);

  const memberRow = await withTenantDb(ctx, (db) =>
    db.organizationMember.create({
      data: { organizationId: ctx.organization!.id, userId: invited.id, role: input.role },
    }),
  );
  await logOrgActivity(ctx, "ORGANIZATION_MEMBER_ADDED", `${invited.name} (${email}) added as ${input.role}`, {
    memberId: memberRow.id,
    role: input.role,
  });
  return {
    userId: invited.id,
    name: invited.name,
    email: invited.email,
    role: input.role,
    isOwner: false,
    addedAt: memberRow.createdAt.toISOString(),
  };
}

export async function updateOrganizationMember(
  ctx: AuthContext,
  userId: string,
  role: OrganizationRole,
): Promise<unknown> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");
  if (!INVITABLE_ORG_ROLES.includes(role)) {
    throw new ApiError(400, "VALIDATION", "Role must be ADMIN, MEMBER or AUDITOR (OWNER is reserved).");
  }
  const [memberRow, org] = await withTenantDb(ctx, (db) =>
    Promise.all([
      db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: ctx.organization!.id, userId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      db.organization.findUnique({ where: { id: ctx.organization!.id }, select: { ownerId: true } }),
    ]),
  );
  if (!memberRow) throw new ApiError(404, "NOT_FOUND", "That user is not a member of this organization.");
  if (memberRow.role === "OWNER" || (org && org.ownerId === userId)) {
    throw new ApiError(403, "PROTECTED", "The organization owner's role cannot be changed.");
  }
  const updated = await withTenantDb(ctx, (db) =>
    db.organizationMember.update({
      where: { id: memberRow.id },
      data: { role },
    }),
  );
  await logOrgActivity(ctx, "ORGANIZATION_MEMBER_UPDATED", `${memberRow.user.name} → ${role}`, {
    memberId: memberRow.id,
    role,
  });
  return {
    userId: memberRow.user.id,
    name: memberRow.user.name,
    email: memberRow.user.email,
    role,
    isOwner: false,
    addedAt: updated.createdAt.toISOString(),
  };
}

export async function removeOrganizationMember(ctx: AuthContext, userId: string): Promise<{ removed: string }> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");
  const [memberRow, org] = await withTenantDb(ctx, (db) =>
    Promise.all([
      db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: ctx.organization!.id, userId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      db.organization.findUnique({ where: { id: ctx.organization!.id }, select: { ownerId: true } }),
    ]),
  );
  if (!memberRow) throw new ApiError(404, "NOT_FOUND", "That user is not a member of this organization.");
  if (memberRow.role === "OWNER" || (org && org.ownerId === userId)) {
    throw new ApiError(403, "PROTECTED", "The organization owner cannot be removed.");
  }
  await withTenantDb(ctx, (db) => db.organizationMember.delete({ where: { id: memberRow.id } }));
  await logOrgActivity(ctx, "ORGANIZATION_MEMBER_REMOVED", `${memberRow.user.name} removed from the organization`, {
    memberId: memberRow.id,
  });
  return { removed: userId };
}

export interface EngagementSummary {
  id: string;
  name: string;
  code: string | null;
  gstin: string | null;
  status: string;
  description: string | null;
  projectCount: number;
  projectId: string | null;
  updatedAt: string;
  createdAt: string;
}

/** List the firm's engagements (requires at least MEMBER/AUDITOR). */
export async function listOrganizationEngagements(ctx: AuthContext): Promise<EngagementSummary[]> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
  const engagements = await withTenantDb(ctx, (db) =>
    db.engagement.findMany({
      where: { organizationId: ctx.organization!.id },
      include: { projects: { select: { id: true }, orderBy: { updatedAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  );
  return engagements.map((e) => ({
    id: e.id,
    name: e.name,
    code: e.code,
    gstin: e.gstin,
    status: e.status,
    description: e.description,
    projectCount: e.projects.length,
    projectId: e.projects[0]?.id ?? null,
    updatedAt: e.updatedAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
  }));
}

export interface CreateEngagementInput {
  name: string;
  code?: string;
  gstin?: string;
  description?: string;
  /** Auto-create a Project to hold the engagement's artifacts (default true). */
  createProject?: boolean;
}

/**
 * Create a client Engagement under the firm. When createProject is true (the
 * default) a Project is created in the caller's workspace, tagged with the
 * engagement + organization — org teammates then access it through the
 * org-role mapping in members.ts.
 */
export async function createEngagement(
  ctx: AuthContext,
  input: CreateEngagementInput,
): Promise<{ engagement: EngagementSummary; projectId: string | null }> {
  const organization = ctx.organization;
  if (!organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, organization.id, "ADMIN");

  const name = (input.name ?? "").trim();
  if (name.length < 2) throw new ApiError(400, "VALIDATION", "Engagement name must be at least 2 characters.");
  const code = input.code?.trim() || null;
  if (code) {
    const dupe = await withTenantDb(ctx, (db) =>
      db.engagement.findUnique({
        where: { organizationId_code: { organizationId: organization.id, code } },
      }),
    );
    if (dupe) throw new ApiError(400, "VALIDATION", `An engagement with the code “${code}” already exists.`);
  }

  const result = await withTenantDb(ctx, async (tx) => {
    const engagement = await tx.engagement.create({
      data: {
        organizationId: organization.id,
        name,
        code,
        gstin: input.gstin?.trim() || null,
        description: input.description?.trim() || null,
        status: "ACTIVE",
      },
    });
    const createProject = input.createProject !== false;
    let project: { id: string } | null = null;
    if (createProject) {
      project = await tx.project.create({
        data: {
          workspaceId: ctx.workspace.id,
          ownerId: ctx.user.id,
          name,
          description: input.description?.trim() || null,
          organizationId: organization.id,
          engagementId: engagement.id,
          status: "ACTIVE",
        },
      });
    }
    return { engagement, project };
  });

  await logOrgActivity(ctx, "ENGAGEMENT_CREATED", `Engagement “${name}” created`, {
    engagementId: result.engagement.id,
    projectId: result.project?.id ?? null,
  });
  const summary: EngagementSummary = {
    id: result.engagement.id,
    name: result.engagement.name,
    code: result.engagement.code,
    gstin: result.engagement.gstin,
    status: result.engagement.status,
    description: result.engagement.description,
    projectCount: result.project ? 1 : 0,
    projectId: result.project?.id ?? null,
    updatedAt: result.engagement.updatedAt.toISOString(),
    createdAt: result.engagement.createdAt.toISOString(),
  };
  return { engagement: summary, projectId: result.project?.id ?? null };
}

export interface UpdateEngagementInput {
  name?: string;
  code?: string | null;
  gstin?: string | null;
  description?: string | null;
  status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
}

export async function updateEngagement(
  ctx: AuthContext,
  engagementId: string,
  input: UpdateEngagementInput,
): Promise<EngagementSummary> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  await requireOrgRole(ctx, ctx.organization.id, "ADMIN");

  const engagement = await withTenantDb(ctx, (db) =>
    db.engagement.findFirst({
      where: { id: engagementId, organizationId: ctx.organization!.id },
    }),
  );
  if (!engagement) throw new ApiError(404, "NOT_FOUND", "Engagement not found.");

  const updated = await withTenantDb(ctx, (db) =>
    db.engagement.update({
      where: { id: engagement.id },
      data: {
        name: input.name ? input.name.trim() : undefined,
        code: input.code === null ? null : input.code?.trim() || undefined,
        gstin: input.gstin === null ? null : input.gstin?.trim() || undefined,
        description: input.description === null ? null : input.description?.trim() || undefined,
        status: input.status,
      },
    }),
  );
  await logOrgActivity(ctx, "ENGAGEMENT_UPDATED", `Engagement “${updated.name}” updated`, { engagementId: updated.id });
  const project = await withTenantDb(ctx, (db) =>
    db.project.findFirst({
      where: { engagementId: updated.id },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    }),
  );
  return {
    id: updated.id,
    name: updated.name,
    code: updated.code,
    gstin: updated.gstin,
    status: updated.status,
    description: updated.description,
    projectCount: 1,
    projectId: project?.id ?? null,
    updatedAt: updated.updatedAt.toISOString(),
    createdAt: updated.createdAt.toISOString(),
  };
}

const ENGAGEMENT_ARCHIVE_STATUS: UpdateEngagementInput["status"] = "ARCHIVED";

/** Archive an engagement (soft delete) — requires ADMIN. */
export async function archiveEngagement(ctx: AuthContext, engagementId: string): Promise<EngagementSummary> {
  const updated = await updateEngagement(ctx, engagementId, { status: ENGAGEMENT_ARCHIVE_STATUS });
  await logOrgActivity(ctx, "ENGAGEMENT_ARCHIVED", `Engagement “${updated.name}” archived`, { engagementId });
  return updated;
}

/** Convenience: orgRank wrapper so API routes can lint an org role without importing members.ts. */
export function canAdminister(role: OrganizationRole | null): boolean {
  return orgRank(role) >= orgRank("ADMIN");
}

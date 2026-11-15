/**
 * Collaboration authorization (shared projects).
 *
 * Ledgerly's prototype data model is one self-hosted workspace per account with
 * workspace-level isolation enforced on every route. Sharing extends it
 * explicitly: a Project may carry ProjectMember rows granting another account
 * a role on the project (OWNER | EDITOR | VIEWER).
 *
 *   OWNER  — the project's owner (or a same-workspace legacy account).
 *   EDITOR — may create/edit project artifacts (analyses, dashboards, …).
 *   VIEWER — read-only access; may comment.
 *
 * Every check funnels through ONE resolver so behaviour is consistent:
 *
 *   1. The user is the project's owner          → OWNER.
 *   2. A ProjectMember row exists for the user   → that row's role.
 *   3. The artifact lives in the user's own
 *      workspace (legacy single-owner model)     → OWNER.
 *   4. otherwise                                → no access.
 *
 * Role checks are server-side only; no client-trusted ownership IDs.
 * Workspace isolation for non-shared rows is unchanged (rule 3 = OWNER), so
 * every existing single-user flow and test behaves exactly as before.
 */

import { forbiddenError, notFoundError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { ProjectRole, OrganizationRole } from "@/lib/types";

const RANK: Record<ProjectRole, number> = { OWNER: 3, EDITOR: 2, VIEWER: 1, AUDITOR: 1 };

const ORG_RANK: Record<OrganizationRole, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, AUDITOR: 1 };

export function rank(role: ProjectRole | null): number {
  return role ? RANK[role] : 0;
}

export function orgRank(role: OrganizationRole | null): number {
  return role ? ORG_RANK[role] : 0;
}

export interface ArtifactRow {
  id?: string;
  workspaceId: string;
  projectId?: string | null;
  ownerId?: string | null;
}

function toRole(value: string | null | undefined): ProjectRole | null {
  if (value === "OWNER" || value === "EDITOR" || value === "VIEWER") return value;
  return null;
}

/**
 * Resolve the current user's role for an artifact (or project) row.
 * Returns null when the user has no access at all.
 *
 * Org-aware: for organization-owned engagements it resolves through the
 * OrganizationMember role (see artifactRoleWithOrg).
 */
export async function artifactRole(ctx: AuthContext, row: ArtifactRow | null | undefined): Promise<ProjectRole | null> {
  return artifactRoleWithOrg(ctx, row);
}

/** Assert the user may act on `row` with at least `min` role. Returns the role. */
export async function requireRowRole(
  ctx: AuthContext,
  row: ArtifactRow | null | undefined,
  min: ProjectRole = "VIEWER",
): Promise<ProjectRole> {
  return requireRowRoleWithOrg(ctx, row, min);
}

/** Convenience guard for project-level routes. */
export async function requireProjectRole(
  ctx: AuthContext,
  project: ArtifactRow | null | undefined,
  min: ProjectRole = "VIEWER",
): Promise<ProjectRole> {
  if (!project) throw notFoundError("Project not found.");
  return requireRowRoleWithOrg(ctx, { ...project, projectId: project.id, ownerId: project.ownerId }, min);
}

export interface MemberWithRole {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  isOwner: boolean;
  addedAt: string | null;
}

/** Team roster for a project: owner + member rows. */
export async function listProjectMembers(project: { id: string; ownerId: string }): Promise<MemberWithRole[]> {
  const owner = await prisma.user.findUnique({
    where: { id: project.ownerId },
    select: { id: true, name: true, email: true },
  });
  const rows = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const members: MemberWithRole[] = [];
  if (owner) {
    members.push({
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      role: "OWNER",
      isOwner: true,
      addedAt: null,
    });
  }
  for (const row of rows) {
    const role = toRole(row.role);
    if (!role) continue;
    members.push({
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      role,
      isOwner: false,
      addedAt: row.createdAt.toISOString(),
    });
  }
  return members;
}

/**
 * Tenancy enforcement: organization-aware role resolution.
 *
 * When a Project has `organizationId` set, it is an Engagement belonging to
 * that Organization. Access is derived from the user's OrganizationMember role
 * + explicit ProjectMember row (which takes precedence).
 *
 * OrganizationRole → ProjectRole mapping (for org-level access without explicit
 * ProjectMember):
 *   OWNER  → OWNER
 *   ADMIN  → EDITOR
 *   MEMBER → VIEWER
 *   AUDITOR → AUDITOR (read-only on ALL org engagements)
 */

const ORG_ROLE_TO_PROJECT_ROLE: Record<OrganizationRole, ProjectRole> = {
  OWNER: "OWNER",
  ADMIN: "EDITOR",
  MEMBER: "VIEWER",
  AUDITOR: "AUDITOR",
};

export interface OrgMemberWithRole {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  isOwner: boolean;
  addedAt: string | null;
}

/** Resolve the user's role within an organization. Returns null if not a member. */
export async function organizationRoleFor(ctx: AuthContext, organizationId: string): Promise<OrganizationRole | null> {
  const membership = await withTenantDb(ctx, (db) =>
    db.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: ctx.user.id } },
    }),
  );
  if (!membership) return null;
  return membership.role as OrganizationRole;
}

/** Map an OrganizationRole to the corresponding ProjectRole for org-level access. */
export function mapOrgRoleToProjectRole(orgRole: OrganizationRole): ProjectRole {
  return ORG_ROLE_TO_PROJECT_ROLE[orgRole];
}

/**
 * Assert the user may act on an organization with at least `min` org role.
 * Enforces the single-active-org contract (guard.getAuth) + real membership.
 * @returns the user's resolved OrganizationRole.
 */
export async function requireOrgRole(
  ctx: AuthContext,
  organizationId: string,
  min: OrganizationRole = "MEMBER",
): Promise<OrganizationRole> {
  if (!ctx.organization || ctx.organization.id !== organizationId) {
    throw forbiddenError("You are not a member of this organization.");
  }
  const role = await organizationRoleFor(ctx, organizationId);
  if (!role || orgRank(role) < orgRank(min)) throw forbiddenError();
  return role;
}

/**
 * Resolve the user's effective role for an artifact that belongs to an
 * organization-owned project (Engagement). Precedence:
 *   1. Explicit ProjectMember row on the project (owns write/read).
 *   2. OrganizationMember role mapped via ORG_ROLE_TO_PROJECT_ROLE.
 *   3. Legacy workspace ownership (for backward compatibility).
 */
export async function artifactRoleWithOrg(
  ctx: AuthContext,
  row: ArtifactRow | null | undefined,
): Promise<ProjectRole | null> {
  if (!row) return null;
  const projectId = row.projectId ?? (row.ownerId !== undefined ? row.id : null);
  if (!projectId) {
    return row.workspaceId === ctx.workspace.id ? "OWNER" : null;
  }

  // First check explicit project membership (highest precedence for write access)
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: ctx.user.id } },
    include: { project: { select: { ownerId: true, workspaceId: true, organizationId: true } } },
  });

  if (membership?.project.ownerId === ctx.user.id) return "OWNER";
  const memberRole = toRole(membership?.role);
  if (memberRole) return memberRole;

  // Legacy single-owner model (rule 3 = OWNER): same workspace means
  // owner-level access — every existing single-user flow is unchanged.
  const projectWorkspace = membership?.project.workspaceId ?? row.workspaceId;
  if (projectWorkspace === ctx.workspace.id) return "OWNER";

  // Org-scoped engagement: resolve the project's organization even when the
  // caller has no ProjectMember row (the include above only runs then), then
  // map the user's OrganizationMember role onto the project role space.
  const projectOrgId =
    membership?.project.organizationId ??
    (await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } }))?.organizationId ??
    null;
  if (projectOrgId) {
    const orgRole = await organizationRoleFor(ctx, projectOrgId);
    if (orgRole) return mapOrgRoleToProjectRole(orgRole);
  }

  return null;
}

/**
 * Publish/unpublish authorization (SEC-2).
 *
 * Making an artifact publicly reachable (share link, no sign-in) is the most
 * sensitive action in the collaboration model, so it requires MORE than the
 * legacy workspace rule gives: artifactRoleWithOrg grants every same-workspace
 * account OWNER on projectless rows (rule 3 — that is correct for ordinary
 * reads), but publish must be limited to the artifact's CREATOR when it has no
 * project, and to the project OWNER when it has one. Workspace scoping is
 * enforced in both branches: a caller from another workspace gets a 404 (not
 * a 403, which would leak the artifact's existence).
 */
export async function requirePublishRole(
  ctx: AuthContext,
  row: (ArtifactRow & { createdById?: string | null }) | null | undefined,
  label = "Resource",
): Promise<ProjectRole> {
  if (!row) throw notFoundError(`${label} not found.`);

  // Workspace scoping FIRST — cross-workspace callers must not learn that the
  // artifact exists (404, never 403).
  if (row.workspaceId !== ctx.workspace.id) throw notFoundError(`${label} not found.`);

  if (row.projectId) {
    const project = await prisma.project.findUnique({ where: { id: row.projectId } });
    return requireProjectRole(ctx, project, "OWNER");
  }

  // Projectless artifact: only its creator (or the workspace's owning
  // account) may publish it.
  if (row.createdById && row.createdById !== ctx.user.id) {
    const workspaceOwner = await prisma.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { user: { select: { id: true } } },
    });
    if (workspaceOwner?.user?.id !== ctx.user.id) throw forbiddenError();
  }
  return "OWNER";
}

/**
 * Assert the user may act on an org-scoped row with at least `min` role.
 * Uses artifactRoleWithOrg for org-aware resolution.
 */
export async function requireRowRoleWithOrg(
  ctx: AuthContext,
  row: ArtifactRow | null | undefined,
  min: ProjectRole = "VIEWER",
): Promise<ProjectRole> {
  const role = await artifactRoleWithOrg(ctx, row);
  if (!row) throw notFoundError("Resource not found.");
  if (!role || rank(role) < rank(min)) throw forbiddenError();
  return role;
}

/** Convenience guard for org-scoped project routes. */
export async function requireProjectRoleWithOrg(
  ctx: AuthContext,
  project: ArtifactRow | null | undefined,
  min: ProjectRole = "VIEWER",
): Promise<ProjectRole> {
  if (!project) throw notFoundError("Project not found.");
  return requireRowRoleWithOrg(ctx, { ...project, projectId: project.id, ownerId: project.ownerId }, min);
}

/** List organization members with roles (for firm dashboard / member management). */
export async function listOrganizationMembers(organization: { id: string }): Promise<OrgMemberWithRole[]> {
  const owner = await prisma.user.findUnique({
    where: {
      id:
        (await prisma.organization.findUnique({ where: { id: organization.id }, select: { ownerId: true } }))
          ?.ownerId ?? "",
    },
    select: { id: true, name: true, email: true },
  });
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId: organization.id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const members: OrgMemberWithRole[] = [];
  if (owner) {
    members.push({
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      role: "OWNER",
      isOwner: true,
      addedAt: null,
    });
  }
  for (const row of rows) {
    const role = row.role as OrganizationRole;
    members.push({
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      role,
      isOwner: false,
      addedAt: row.createdAt.toISOString(),
    });
  }
  return members;
}

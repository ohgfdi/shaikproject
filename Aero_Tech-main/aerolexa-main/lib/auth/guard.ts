import { redirect } from "next/navigation";

import type { User, Workspace, Organization } from "@/generated/prisma/browser";
import { readActiveOrganizationId, selectActiveMembership } from "@/lib/auth/active-org";
import { readSession } from "@/lib/auth/session";
import { parseJson } from "@/lib/json";
import { withUserContext } from "@/lib/server/tenancy";
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "@/lib/types";

/** Error carrying an HTTP status + machine-readable code for API responses. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Extra response headers (e.g. Retry-After on 429s). */
  headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function notFoundError(message = "Resource not found"): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function forbiddenError(message = "You do not have access to this resource"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export interface AuthContext {
  user: User;
  workspace: Workspace;
  settings: WorkspaceSettings;
  organization: Organization | null;
  organizationRole: string | null;
  isAdmin: boolean;
}

/**
 * Load the signed-in user + their workspace + organization (if any).
 * Returns null for anonymous requests.
 */
export async function getAuth(): Promise<AuthContext | null> {
  const session = await readSession();
  if (!session?.sub) return null;
  // Bootstrap read: the session names the user, but the active organization is
  // not known yet. withUserContext() sets only app.current_user, and the RLS
  // policies allow a user to read their own memberships under that context.
  const user = await withUserContext(session.sub, (db) =>
    db.user.findUnique({
      where: { id: session.sub },
      include: { workspace: true, organizationMemberships: { include: { organization: true } } },
    }),
  );
  if (!user || !user.workspace) return null;
  const settings = parseJson<WorkspaceSettings>(user.workspace.settings, DEFAULT_WORKSPACE_SETTINGS);

  // Resolve the organization the user explicitly selected. Falling back to
  // the first membership is only acceptable for a brand-new user; using it
  // unconditionally made the active tenant depend on row order for anyone in
  // more than one organization.
  const activeOrganizationId = await readActiveOrganizationId();
  const orgMembership = selectActiveMembership(user.organizationMemberships, activeOrganizationId);
  const organization = orgMembership?.organization ?? null;
  const organizationRole = orgMembership?.role ?? null;

  return { user, workspace: user.workspace, settings, organization, organizationRole, isAdmin: user.isAdmin };
}

/** Route-handler guard: throws 401 when not authenticated. */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuth();
  if (!ctx) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  return ctx;
}

/** Server-component guard: redirects to /login when anonymous. */
export async function requirePageAuth(): Promise<AuthContext> {
  const ctx = await getAuth();
  if (!ctx) redirect("/login?next=" + encodeURIComponent(getPathname()));
  return ctx;
}

function getPathname(): string {
  // next/headers pathname is only available in some contexts; pages pass their
  // own `next` param through middleware instead. Default is safe.
  return "/";
}

/**
 * Workspace-level authorization. Every read/write on a workspace-scoped model
 * passes through here — the check is the prototype's equivalent of RLS and is
 * enforced server-side on every route (never trusted from the client).
 */
export function assertWorkspaceAccess(
  ctx: AuthContext,
  row: { workspaceId: string } | null | undefined,
  label = "Resource",
): void {
  if (!row) throw notFoundError(`${label} not found.`);
  if (row.workspaceId !== ctx.workspace.id) throw forbiddenError();
}

/**
 * Organization-level authorization. For org-owned resources (Engagements),
 * checks the user's OrganizationMember role.
 */
export function assertOrganizationAccess(ctx: AuthContext, orgId: string, label = "Resource"): void {
  if (!ctx.organization || ctx.organization.id !== orgId) {
    throw forbiddenError(`${label} belongs to a different organization.`);
  }
}

/**
 * Organization-level authorization with a role requirement. Membership alone
 * is not enough for owner/admin actions (billing, member management, filing
 * credentials); callers name the roles that may perform the write.
 */
export function requireOrganizationRole(
  ctx: AuthContext,
  orgId: string,
  roles: readonly string[],
  label = "Resource",
): void {
  assertOrganizationAccess(ctx, orgId, label);
  const actual = (ctx.organizationRole ?? "").toUpperCase();
  const allowed = roles.map((r) => r.toUpperCase());
  if (!allowed.includes(actual)) {
    throw forbiddenError(`Your organization role (${ctx.organizationRole ?? "none"}) cannot modify ${label}.`);
  }
}

/** Fetch a workspace-scoped record and assert the current user may see it. */
export async function getScopedOrThrow<T extends { workspaceId: string }>(
  ctx: AuthContext,
  loader: () => Promise<T | null>,
  label = "Resource",
): Promise<T> {
  const row = await loader();
  assertWorkspaceAccess(ctx, row, label);
  return row as T;
}

/** Normalize a user for safe client serialization (never leak password hashes). */
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    profileRole: user.profileRole,
    organization: user.organization,
    industry: user.industry,
    experience: user.experience,
    onboardedAt: user.onboardedAt,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}

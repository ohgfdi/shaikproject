/**
 * Tenant-scoped database access — the one place that sets the PostgreSQL GUCs
 * the RLS policies compare against.
 *
 * Two keys exist in this schema:
 *   * Workspace-scoped tables (`workspaceId`) use `app.tenant_id`, which holds
 *     a Workspace id. Ids are cuid strings, so the GUC is compared as text.
 *   * Organization-scoped tables (`organizationId`) use `app.organization_id`.
 *     `prisma/rls.sql` keeps the older `app.current_workspace` /
 *     `app.current_organization` names for the analytics tables; `withTenant`
 *     sets both the new and the legacy workspace GUCs so one call satisfies
 *     either policy.
 *
 * `set_config(..., true)` is transaction-local, so the context cannot leak to
 * the next request that borrows the same pooled connection. The value is bound
 * as a parameter (`$1`) — never interpolated into SQL.
 *
 * FAIL CLOSED: a missing tenant id throws before any query runs. A query with
 * no GUC set returns zero rows on PostgreSQL (the comparison is NULL), and an
 * INSERT is rejected by WITH CHECK; both are intentional, not a bug.
 *
 * SQLite (development) has no RLS. `withTenant` still opens a transaction and
 * passes its client through, so call sites are provider-agnostic; the
 * application-layer workspace filters remain the boundary there.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/** The transaction client handed to `withTenant` callbacks. */
export type TenantDb = Prisma.TransactionClient;

function isPostgresUrl(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith("postgres://") || url.startsWith("postgresql://")));
}

/**
 * The tenant coordinates a scoped callback runs under. Accepts either an
 * `AuthContext` (the shape services already receive) or an explicit id pair.
 *
 * Every key a shipped policy reads is set here, because setting only some of
 * them makes the remaining policies compare against NULL and hide every row
 * instead of failing loudly: `app.tenant_id` (workspace-keyed tables, the
 * majority), `app.current_workspace` (the legacy analytics policies),
 * `app.organization_id` / `app.current_organization` (firm-scoped tables) and
 * `app.current_user` (auth bootstrap). `__tests__/unit/rls-guc-contract.test.ts`
 * holds that list to the policies that actually ship.
 */
export interface TenantScopeLike {
  workspace?: { id: string } | null;
  workspaceId?: string | null;
  organization?: { id: string } | null;
  organizationId?: string | null;
  user?: { id: string } | null;
}

/** Shared core: one transaction, every GUC the policies may key on. */
async function runScoped<T>(
  scope: { workspaceId: string; organizationId: string | null; userId: string },
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  const postgres = isPostgresUrl(process.env.DATABASE_URL);
  return prisma.$transaction(async (tx) => {
    if (postgres) {
      // Parameterized: every value is bound by the driver, never concatenated.
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${scope.workspaceId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_workspace', ${scope.workspaceId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId ?? ""}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_organization', ${scope.organizationId ?? ""}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_user', ${scope.userId}, true)`;
    }
    return fn(tx);
  });
}

/**
 * Run `fn` inside a transaction scoped to one workspace.
 *
 * @param tenantId Workspace id. Empty/null is refused — the caller must have
 *   resolved a tenant before querying, never fall back to "all rows".
 */
export async function withTenant<T>(tenantId: string | null | undefined, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  if (!tenantId) {
    throw new TenantContextError("withTenant called without a tenant id — refusing to run a tenant query (fail closed).");
  }
  return runScoped({ workspaceId: tenantId, organizationId: null, userId: "" }, fn);
}

/**
 * Run `fn` under a caller-supplied tenant scope (workspace and/or firm).
 *
 * This is the helper services taking an `AuthContext` use: it derives the ids
 * from the context and refuses a scope with neither, so a bug in tenant
 * resolution surfaces as an error rather than as an empty (or unfiltered)
 * result set.
 */
export async function withTenantDb<T>(
  ctx: TenantScopeLike,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  const workspaceId = ctx.workspace?.id ?? ctx.workspaceId ?? "";
  const organizationId = ctx.organization?.id ?? ctx.organizationId ?? null;
  if (!workspaceId && !organizationId) {
    throw new TenantContextError(
      "withTenantDb called without a workspace or organization — refusing to run a tenant query (fail closed).",
    );
  }
  return runScoped({ workspaceId, organizationId, userId: ctx.user?.id ?? "" }, fn);
}

/**
 * Run `fn` inside a transaction scoped to one organization (firm).
 *
 * Used by the client-portal and filing tables, whose policies key off
 * `organizationId`. Refuses a missing organization for the same fail-closed
 * reason as `withTenant`.
 */
export async function withOrganization<T>(
  organizationId: string | null | undefined,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  if (!organizationId) {
    throw new TenantContextError(
      "withOrganization called without an organization id — refusing to run a firm query (fail closed).",
    );
  }
  // Firm-scoped tables have no workspace of their own; the organization keys
  // are what the policies compare against, so the workspace GUC stays empty.
  return runScoped({ workspaceId: "", organizationId, userId: "" }, fn);
}

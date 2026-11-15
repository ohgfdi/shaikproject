/**
 * PostgreSQL Row-Level Security tenant context.
 *
 * RLS (prisma/rls.sql) filters on the GUCs `app.current_workspace` and
 * `app.current_organization`. Prisma's connection pool makes per-query SET
 * unreliable, so tenant-scoped work must run inside one interactive
 * transaction: we pin the connection, set the GUCs (SET LOCAL — transaction
 * scoped), then run the callback.
 *
 * On SQLite (dev default) — which cannot run RLS or SET LOCAL — this is a
 * transparent pass-through so dev behaviour is unchanged. Enable enforcement
 * on PostgreSQL by setting RLS_ENABLED=true after applying prisma/rls.sql.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { RLS_AUDIT_COMMAND, RLS_QUERY_LAYER_WIRED } from "@/lib/server/rls-status";

/**
 * Whether every tenant-scoped query is wrapped in withTenantContext().
 *
 * RLS policies compare against the `app.current_*` GUCs, which ONLY
 * withTenantContext() sets. The constant is false until `npm run tenancy:audit`
 * reports zero unwrapped tenant files; enabling RLS before that hides rows.
 */
export { RLS_QUERY_LAYER_WIRED };

/** True when the runtime uses the PostgreSQL provider. */
export function isPostgres(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("postgres");
}

/** True when the deployment has applied prisma/rls.sql and wants RLS on. */
export function rlsEnabled(): boolean {
  return process.env.RLS_ENABLED === "true" && isPostgres();
}

/**
 * Why `RLS_ENABLED=true` is unsafe right now, or null when the configuration
 * is coherent. Enabling RLS before the query layer is wired makes the policies
 * compare against unset GUCs and hides every row — a broken, deceptive state.
 * The health endpoint surfaces this so an operator is never misled.
 */
export function rlsConfigError(): string | null {
  if (process.env.RLS_ENABLED !== "true") return null;
  if (!isPostgres()) {
    return "RLS_ENABLED=true but DATABASE_URL is not PostgreSQL — RLS is a no-op here.";
  }
  if (!RLS_QUERY_LAYER_WIRED) {
    return `RLS_ENABLED=true but the query layer is not yet wrapped in withTenantContext() (ROADMAP 2.5); enabling it now would hide every row. Leave RLS_ENABLED=false — isolation is enforced in the application (lib/auth/guard.ts, lib/server/members.ts). Measure the gap with ${RLS_AUDIT_COMMAND}.`;
  }
  return null;
}

/** Live enforcement truth for PostgreSQL: are the policies actually active? */
export async function rlsEnforcementStatus(): Promise<{
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  tablesWithRls: number;
  tablesWithoutForce: number;
}> {
  const rows = await prisma.$queryRaw<
    { role: string; rolsuper: boolean; rolbypassrls: boolean; with_rls: number; missing_force: number }[]
  >`SELECT current_user AS role,
           r.rolsuper,
           r.rolbypassrls,
           (SELECT COUNT(*) FROM pg_class c
             WHERE c.relname IN ('Organization','OrganizationMember','Engagement','Project','Dataset',
                                 'Analysis','Insight','Dashboard','Report','Presentation','Activity',
                                 'ComplianceFilingRun','ComplianceFilingEvent','ClientPortalToken',
                                 'ClientPortalAccount','ClientPortalLoginToken','ClientPortalUpload',
                                 'ClientComplianceProfile','ClientComplianceStatus','FilingRollout','MailOutbox')
               AND c.relrowsecurity)::int AS with_rls,
           (SELECT COUNT(*) FROM pg_class c
             WHERE c.relname IN ('Organization','OrganizationMember','Engagement','Project','Dataset',
                                 'Analysis','Insight','Dashboard','Report','Presentation','Activity',
                                 'ComplianceFilingRun','ComplianceFilingEvent','ClientPortalToken',
                                 'ClientPortalAccount','ClientPortalLoginToken','ClientPortalUpload',
                                 'ClientComplianceProfile','ClientComplianceStatus','FilingRollout','MailOutbox')
               AND c.relrowsecurity AND NOT c.relforcerowsecurity)::int AS missing_force
      FROM pg_roles r
     WHERE r.rolname = current_user`;
  const row = rows[0];
  return {
    role: row?.role ?? "unknown",
    superuser: row?.rolsuper ?? false,
    bypassRls: row?.rolbypassrls ?? false,
    tablesWithRls: row?.with_rls ?? 0,
    tablesWithoutForce: row?.missing_force ?? 0,
  };
}

/**
 * Bootstrap context for the first request lookup: the user is known (from the
 * session cookie) but the active organization is not. Policies must allow the
 * user to read their OWN memberships under this context, otherwise getAuth()
 * cannot discover which firm to enter.
 */
async function setUserContext(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await setTenantContext(tx, "", "", userId);
}

/** Run `fn` with only `app.current_user` set (no tenant yet). */
export async function withUserContext<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!rlsEnabled()) return fn(prisma);
  return prisma.$transaction(async (tx) => {
    await setUserContext(tx, userId);
    return fn(tx);
  });
}

/** Set the tenant GUCs for the current transaction (PostgreSQL only). */
async function setTenantContext(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  organizationId: string | null,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId ?? ""}, true)`;
}

/**
 * Run `fn` with the tenant context set. On PostgreSQL+RLS the callback
 * receives a transaction client that enforces RLS; elsewhere it receives the
 * shared `prisma` client (no-op wrapper).
 */
export async function withTenantContext<T>(
  opts: { workspaceId: string; organizationId: string | null; userId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!rlsEnabled()) return fn(prisma);
  return prisma.$transaction(async (tx) => {
    await setTenantContext(tx, opts.workspaceId, opts.organizationId, opts.userId);
    return fn(tx);
  });
}

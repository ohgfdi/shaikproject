/**
 * Tenant-scoped database access.
 *
 * A thin wrapper over withTenantContext() that derives the GUCs from the
 * authenticated context. Callers pass the transaction client to every query in
 * the operation, so the RLS policies can see the tenant. When RLS is off (the
 * current default), this is a transparent pass-through to the shared client.
 *
 * Use this at the boundary of a server operation, not per query: one operation
 * should run inside one context.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "@/lib/auth/guard";

import { withTenantContext } from "./tenancy";

export type TenantDb = Prisma.TransactionClient;

export async function withTenantDb<T>(ctx: AuthContext, fn: (db: TenantDb) => Promise<T>): Promise<T> {
  return withTenantContext(
    {
      workspaceId: ctx.workspace.id,
      organizationId: ctx.organization?.id ?? null,
      userId: ctx.user.id,
    },
    fn,
  );
}

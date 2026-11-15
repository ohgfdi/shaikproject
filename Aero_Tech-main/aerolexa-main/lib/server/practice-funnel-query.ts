/**
 * Database counts for the practice funnel.
 *
 * Split from the pure `practice-funnel.ts` rules so the rules can be tested
 * without a Prisma client, and so the one place that reads across tenants is
 * explicit and auditable.
 *
 * tenancy-audit: global-operator — these are deployment-wide operator counts.
 * They must cross tenants by design and cannot use withTenantContext(); the
 * audit lists this file as a declared exception rather than an unwrapped gap.
 */

import { prisma } from "@/lib/db";
import type { PracticeCounts } from "@/lib/server/practice-funnel";

/** Global counts for the operator view. */
export async function practiceFunnelSnapshot(): Promise<PracticeCounts> {
  const [engagements, portalAccounts, preparedFilings, filedFilings, reconciledFilings] = await Promise.all([
    prisma.engagement.count(),
    prisma.clientPortalAccount.count({ where: { revokedAt: null } }),
    prisma.complianceFilingRun.count(),
    prisma.complianceFilingRun.count({ where: { filedAt: { not: null } } }),
    prisma.complianceFilingRun.count({ where: { verificationStatus: "verified" } }),
  ]);
  return { engagements, portalAccounts, preparedFilings, filedFilings, reconciledFilings };
}

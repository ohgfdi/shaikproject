/**
 * Collect the pilot-readiness snapshot from the running instance.
 *
 * Kept separate from `pilot-readiness.ts` so the rules stay pure and importable
 * without a database. Every read is best-effort: a table that cannot be counted
 * reports zero, and the check that consumes it states the consequence — a
 * readiness report must never claim a fact it could not read.
 *
 * tenancy-audit: global-operator — pilot readiness is a deployment-wide check
 * (how many engagements, portal accounts and filings exist across the firm).
 * It has no single tenant context by design; the audit lists it as a declared
 * exception rather than an unwrapped gap.
 */

import { prisma } from "@/lib/db";
import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import { backupPosture, readBackupReceipt } from "@/lib/server/backup-evidence";
import type { PilotSnapshot } from "@/lib/server/pilot-readiness";
import { queueHealth } from "@/lib/server/queue-health";
import { rlsPosture } from "@/lib/server/rls-posture";

export async function collectPilotSnapshot(now: Date = new Date()): Promise<PilotSnapshot> {
  const [workspaces, subscriptions, engagements, portalAccounts, liveFilings, reconciledFilings, backup, queue] =
    await Promise.all([
      prisma.workspace.count(),
      prisma.subscription.findMany({
        where: { status: "active" },
        select: { workspaceId: true, planId: true, trialEndsAt: true },
      }),
      prisma.engagement.count(),
      prisma.clientPortalAccount.count({ where: { revokedAt: null } }),
      prisma.complianceFilingRun.count({ where: { filedAt: { not: null } } }),
      prisma.complianceFilingRun.count({ where: { verificationStatus: "verified" } }),
      readBackupReceipt().then((receipt) => backupPosture(receipt, now)),
      queueHealth(now),
    ]);

  // A lapsed trial is not an entitlement (same rule as workspacePlanId).
  const rls = rlsPosture();

  const paidWorkspaces = new Set(
    subscriptions
      .filter(
        (sub) =>
          (sub.planId === "pro" || sub.planId === "firm") &&
          (!sub.trialEndsAt || sub.trialEndsAt.getTime() > now.getTime()),
      )
      .map((sub) => sub.workspaceId),
  ).size;

  return {
    workspaces,
    paidWorkspaces,
    engagements,
    portalAccounts,
    liveFilings,
    reconciledFilings,
    mailTransport: (process.env.MAIL_TRANSPORT ?? "console").trim(),
    smtpHost: (process.env.SMTP_HOST ?? "").trim(),
    workerEnabled: process.env.JOB_WORKER_ENABLED === "true",
    backup: { severity: backup.severity, summary: backup.summary, remedy: backup.remedy },
    queue: { severity: queue.severity, summary: queue.summary, remedy: queue.remedy, pending: queue.pending },
    rls: {
      severity: rls.severity,
      summary: rls.summary,
      remedy: rls.remedy,
      database: rls.database,
      enforced: rls.enforced,
    },
    filing: (() => {
      const health = filingGatewayHealth();
      return { provider: health.provider, liveEligible: health.liveEligible, activeChannel: health.activeChannel };
    })(),
  };
}

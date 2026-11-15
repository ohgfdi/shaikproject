/**
 * Data retention / storage limitation (Phase 5.3).
 *
 * Storage limitation is the one GDPR principle that is purely a deletion duty
 * (Art. 5(1)(e)), and it is the one a self-hosted app most often fails. The
 * DPDP consent registry and the erasure right in `lib/server/dpdp.ts` both work
 * correctly, but nothing in this codebase ever removed anything on its own.
 * An account that never logs in again therefore kept its error reports,
 * search-query log, delivery logs and expired auth tokens forever.
 *
 * Scope discipline — what is deliberately NOT swept:
 *  - `Activity` is the statutory audit trail for a firm doing books. Retention
 *    is a jurisdiction-specific retention period, not a default. Deleting it
 *    here would quietly destroy the compliance record this product exists to
 *    produce.
 *  - `ConsentRecord` is never swept: the Act requires PROOF of what a user
 *    consented to, so the record must outlive the consent.
 *  - `Feedback` is customer correspondence and drives product decisions.
 *
 * What IS swept is telemetry and dead operational rows: data that serves no
 * purpose once its debugging or delivery window has passed, and which in the
 * case of ErrorReport and SearchQueryLog is personal data tied to an
 * identifiable user.
 *
 * Every policy is expressed as a `deleteMany` against an explicit cutoff, so
 * the sweep is idempotent and safe to run concurrently on several replicas:
 * the loser of a race deletes zero rows.
 */

import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

const DAY_MS = 86_400_000;
const days = (n: number): number => n * DAY_MS;

/** One retention rule. `run` must be idempotent and return the rows removed. */
export interface RetentionPolicy {
  id: string;
  /** What this deletes, in operator-facing language. */
  description: string;
  /** Why the data may be kept until this point and not after. */
  basis: string;
  run: (now: Date) => Promise<number>;
}

/**
 * The retention schedule.
 *
 * Order is irrelevant (disjoint tables), but the windows are not arbitrary:
 *  - 90 days is comfortably longer than any realistic "something broke last
 *    quarter" support cycle, while bounding an unbounded table.
 *  - Auth tokens (verification/OTP) are swept almost immediately after expiry:
 *    once expired they can never authenticate anything, and they are a
 *    credential that should not sit in the table.
 */
export const RETENTION_POLICIES: RetentionPolicy[] = [
  {
    id: "error-reports-resolved",
    description: "Resolved error reports, 90 days after last occurrence",
    basis: "Debugging value is exhausted once an operator has triaged the report.",
    run: async (now) =>
      (
        await prisma.errorReport.deleteMany({
          where: { resolvedAt: { not: null }, lastSeenAt: { lt: new Date(now.getTime() - days(90)) } },
        })
      ).count,
  },
  {
    id: "error-reports-open",
    description: "Still-untriaged error reports, 180 days after last occurrence",
    basis: "An unfixed error seen for six months is either fixed or not actionable.",
    run: async (now) =>
      (
        await prisma.errorReport.deleteMany({
          where: { resolvedAt: null, lastSeenAt: { lt: new Date(now.getTime() - days(180)) } },
        })
      ).count,
  },
  {
    id: "search-query-log",
    description: "Search-query log, 180 days",
    basis:
      "Pure product analytics, and the terms users search for are themselves sensitive (client names, PAN numbers).",
    run: async (now) =>
      (await prisma.searchQueryLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days(180)) } } }))
        .count,
  },
  {
    id: "webhook-events",
    description: "Processed webhook delivery records, 90 days",
    basis: "Delivery de-duplication only needs a short replay window.",
    run: async (now) =>
      (await prisma.webhookEvent.deleteMany({ where: { processedAt: { lt: new Date(now.getTime() - days(90)) } } }))
        .count,
  },
  {
    id: "job-queue-terminal",
    description: "Finished and dead job-queue rows, 30 days after completion",
    basis: "Reclaim space from the durable queue; the run result lives on the artifact it produced.",
    run: async (now) =>
      (
        await prisma.jobQueue.deleteMany({
          where: {
            status: { in: ["done", "dead"] },
            finishedAt: { not: null, lt: new Date(now.getTime() - days(30)) },
          },
        })
      ).count,
  },
  {
    id: "notifications-read",
    description: "Read notifications, 180 days",
    basis: "The user has already acted on them; they are inbox history, not a record.",
    run: async (now) =>
      (
        await prisma.notification.deleteMany({
          where: { readAt: { not: null }, createdAt: { lt: new Date(now.getTime() - days(180)) } },
        })
      ).count,
  },
  {
    id: "expired-verification-tokens",
    description: "Expired or used email verification / password-reset tokens",
    basis:
      "An expired token can never authenticate anything, and an unexpired one is a live credential — it must not linger past its expiry.",
    run: async (now) => (await prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: now } } })).count,
  },
  {
    id: "expired-phone-otp",
    description: "Expired phone OTP challenges, 7 days after expiry",
    basis: "Only a short forensic window is useful for OTP abuse investigations.",
    run: async (now) =>
      (
        await prisma.phoneOtp.deleteMany({
          where: { expiresAt: { lt: new Date(now.getTime() - days(7)) } },
        })
      ).count,
  },
  {
    id: "assistant-runs",
    description: "Books-assistant run and tool-call log, 90 days",
    basis:
      "The run log is operational telemetry (tokens, hashes, verdicts), not the statutory books. Tool results are not copied into it, and 90 days is enough for cost review and incident response.",
    run: async (now) => {
      const retentionDays = serverEnv().ASSISTANT_LOG_RETENTION_DAYS;
      const cutoff = new Date(now.getTime() - days(retentionDays));
      // Tool calls cascade from the run.
      const runs = await prisma.assistantRun.deleteMany({ where: { createdAt: { lt: cutoff } } });
      return runs.count;
    },
  },
];

export interface RetentionSweepResult {
  /** ISO timestamp of the sweep. */
  ranAt: string;
  /** Rows removed, per policy id. */
  deleted: Record<string, number>;
  /** Policies that threw. A failed policy never blocks the others. */
  failures: { id: string; error: string }[];
  totalDeleted: number;
}

/**
 * Run every retention policy once.
 *
 * Policies are isolated: one failing table (a dropped column on an older
 * migration, a locked SQLite file) must not leave the rest un-swept, and must
 * never propagate into the scheduler tick that calls this.
 */
export async function runRetentionSweep(now: Date = new Date()): Promise<RetentionSweepResult> {
  const deleted: Record<string, number> = {};
  const failures: { id: string; error: string }[] = [];

  for (const policy of RETENTION_POLICIES) {
    try {
      deleted[policy.id] = await policy.run(now);
    } catch (err) {
      deleted[policy.id] = 0;
      failures.push({ id: policy.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    ranAt: now.toISOString(),
    deleted,
    failures,
    totalDeleted: Object.values(deleted).reduce((a, b) => a + b, 0),
  };
}

/**
 * Gate the sweep to once per calendar day per process.
 *
 * The scheduler ticks every 60s, and a full sweep on every tick would be
 * pointless load. This is a per-process guard, not a distributed lock: that is
 * deliberate and safe, because every policy is an idempotent `deleteMany`, so
 * several replicas running the same sweep concurrently simply delete the rows
 * once between them.
 */
let lastSweepDay: string | null = null;

export function maybeRunRetentionSweep(now: Date = new Date()): Promise<RetentionSweepResult | null> {
  const day = now.toISOString().slice(0, 10);
  if (lastSweepDay === day) return Promise.resolve(null);
  lastSweepDay = day;
  return runRetentionSweep(now);
}

/** Test seam: forget that today's sweep already ran. */
export function resetRetentionSweepGuard(): void {
  lastSweepDay = null;
}

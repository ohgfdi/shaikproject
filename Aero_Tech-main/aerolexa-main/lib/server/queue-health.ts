/**
 * Job-queue observability.
 *
 * The queue is durable (leases, backoff, dead-letter) but was invisible: a
 * stopped worker and an idle queue looked identical from outside, and a dead
 * job waited for someone to open the database. This module turns the stored
 * counts into a posture with an explicit severity, so `/api/health` can show
 * the difference.
 *
 * Rules:
 *  - only `pending` jobs are "waiting"; `running` jobs are leased, not stuck;
 *  - a pending job past the warn threshold means the worker is not draining;
 *  - any `dead` job is surfaced by count, because it needs a human;
 *  - a failed read reports unknown, never healthy.
 */

import { prisma } from "@/lib/db";

export type QueueSeverity = "ok" | "warn" | "critical";

export interface QueueSnapshot {
  counts: Record<string, number>;
  /** runAt of the oldest pending job, or null when nothing is pending. */
  oldestPendingAt: Date | string | null;
}

export interface QueuePosture {
  pending: number;
  running: number;
  done: number;
  dead: number;
  /** Age of the oldest pending job, in ms. Null when nothing is pending. */
  oldestPendingAgeMs: number | null;
  severity: QueueSeverity;
  summary: string;
  remedy: string;
}

export interface QueueThresholds {
  pendingWarnMinutes: number;
  pendingCriticalMinutes: number;
}

export const QUEUE_THRESHOLDS: QueueThresholds = {
  pendingWarnMinutes: 15,
  pendingCriticalMinutes: 60,
};

const MINUTE = 60_000;

/**
 * Alert thresholds, overridable per deployment. The critical threshold is always
 * at least one minute above the warning threshold so a misconfiguration cannot
 * invert the matrix.
 */
export function queueThresholds(env: Record<string, string | undefined> = process.env): QueueThresholds {
  const read = (key: string, fallback: number): number => {
    const value = Number(env[key]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const pendingWarnMinutes = read("QUEUE_PENDING_WARN_MINUTES", QUEUE_THRESHOLDS.pendingWarnMinutes);
  const pendingCriticalMinutes = Math.max(
    pendingWarnMinutes + 1,
    read("QUEUE_PENDING_CRITICAL_MINUTES", QUEUE_THRESHOLDS.pendingCriticalMinutes),
  );
  return { pendingWarnMinutes, pendingCriticalMinutes };
}

function ms(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Pure posture matrix — injected clock so the rule is oracle-testable. */
export function summariseQueue(
  snapshot: QueueSnapshot,
  now: Date,
  thresholds: QueueThresholds = QUEUE_THRESHOLDS,
): QueuePosture {
  const pending = snapshot.counts.pending ?? 0;
  const running = snapshot.counts.running ?? 0;
  const done = snapshot.counts.done ?? 0;
  const dead = snapshot.counts.dead ?? 0;

  let oldestPendingAgeMs: number | null = null;
  if (pending > 0 && snapshot.oldestPendingAt !== null) {
    const at = ms(snapshot.oldestPendingAt);
    if (Number.isFinite(at)) oldestPendingAgeMs = Math.max(0, now.getTime() - at);
  }
  const oldestMinutes = oldestPendingAgeMs === null ? null : Math.floor(oldestPendingAgeMs / MINUTE);

  if (oldestMinutes !== null && oldestMinutes >= thresholds.pendingCriticalMinutes) {
    return {
      pending,
      running,
      done,
      dead,
      oldestPendingAgeMs,
      severity: "critical",
      summary: `The oldest pending job has waited ${oldestMinutes} minutes — the worker is not draining the queue.`,
      remedy:
        "Check that JOB_WORKER_ENABLED=true and the worker process is alive; then confirm the queue counts in /api/health fall.",
    };
  }

  if (dead > 0 || (oldestMinutes !== null && oldestMinutes >= thresholds.pendingWarnMinutes)) {
    return {
      pending,
      running,
      done,
      dead,
      oldestPendingAgeMs,
      severity: "warn",
      summary:
        dead > 0
          ? `${dead} job${dead === 1 ? "" : "s"} parked as dead after exhausting retries.`
          : `A pending job has waited ${oldestMinutes} minutes (warn at ${thresholds.pendingWarnMinutes}).`,
      remedy:
        dead > 0
          ? "Inspect JobQueue rows with status='dead' and their lastError, fix the cause, then re-enqueue the job."
          : "Confirm the worker tick is running; a slow tick is the usual cause.",
    };
  }

  return {
    pending,
    running,
    done,
    dead,
    oldestPendingAgeMs,
    severity: "ok",
    summary:
      pending === 0
        ? "The queue is empty."
        : `${pending} job${pending === 1 ? "" : "s"} pending, oldest ${oldestMinutes ?? 0} minute${oldestMinutes === 1 ? "" : "s"}.`,
    remedy: "No action.",
  };
}

/**
 * Read the queue from the database. Best-effort: a failed query reports an
 * explicit unknown rather than pretending the queue is healthy.
 */
export async function queueHealth(now: Date = new Date()): Promise<QueuePosture & { available: boolean }> {
  try {
    const [grouped, oldest] = await Promise.all([
      prisma.jobQueue.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.jobQueue.findFirst({
        where: { status: "pending" },
        orderBy: { runAt: "asc" },
        select: { runAt: true },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const group of grouped) counts[group.status] = group._count._all;

    return {
      ...summariseQueue({ counts, oldestPendingAt: oldest?.runAt ?? null }, now, queueThresholds()),
      available: true,
    };
  } catch (err) {
    return {
      pending: 0,
      running: 0,
      done: 0,
      dead: 0,
      oldestPendingAgeMs: null,
      severity: "warn",
      summary: `The job queue could not be read (${err instanceof Error ? err.message : "unknown error"}).`,
      remedy: "Check database connectivity; queue depth is unknown until the query succeeds.",
      available: false,
    };
  }
}

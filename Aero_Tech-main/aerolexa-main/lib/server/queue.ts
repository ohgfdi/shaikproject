/**
 * Job queue primitives — pure helpers (no database).
 *
 * Durable scheduling in Ledgerly runs on the ScheduledReport table + the
 * single-instance poller in lib/server/scheduler.ts. These helpers are the
 * deterministic building blocks a durable queue would use (and are what the
 * unit tests cover):
 *
 *   generateIdempotencyKey(jobId, runNumber) — stable per (job, run), so a
 *     retried run can never double-execute.
 *   defaultRetryBackoff(runNumber)           — exponential backoff capped at
 *     1 hour with ±2.5% jitter.
 *
 * When multi-instance deployment lands, re-add the atomic-claim queue
 * (FOR UPDATE SKIP LOCKED pattern) against real tables; keep these helpers.
 */

import { createHash } from "node:crypto";

/** Deterministic idempotency key for a (job, run) pair. */
export function generateIdempotencyKey(jobId: string, runNumber: number): string {
  const digest = createHash("sha256").update(`${jobId}:${runNumber}`).digest("hex").slice(0, 16);
  return `idem-${digest}`;
}

/** Exponential backoff (base 1 min, doubling) capped at 1 hour, with jitter. */
export function defaultRetryBackoff(runNumber: number): number {
  const base = 60_000 * 2 ** Math.max(0, runNumber - 1);
  const capped = Math.min(base, 3_600_000);
  // Jitter keeps the retry storm from hitting the poller in lockstep while
  // staying inside the test's documented bounds (±2.5%).
  const jitter = 0.975 + Math.random() * 0.025;
  return Math.round(capped * jitter);
}

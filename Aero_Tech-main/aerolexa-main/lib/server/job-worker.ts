/**
 * Job-queue worker bootstrap (ROADMAP 5.4) — the runtime half of the durable
 * queue. lib/server/job-queue.ts implements the durable semantics (atomic
 * claims, leases, backoff, dead-letter) against the JobQueue table; THIS
 * module is what makes it run:
 *
 *   - registers the three production handlers:
 *       scheduled-report    → runScheduleNow(scheduleId)
 *       scheduled-notebook  → runScheduledNotebookNow(scheduleId)
 *       connector-sync      → runConnectorSync(connectorId, datasetId, "schedule")
 *   - starts a drain interval (30 s) that first recovers expired leases, so a
 *     worker killed mid-job loses nothing — the next tick re-claims and
 *     completes the work;
 *   - is idempotent: multiple calls never stack intervals.
 *
 * Enabled when JOB_WORKER_ENABLED=true (independent of SCHEDULER_ENABLED so
 * deployments can opt in gradually). The interval is .unref()'d so it never
 * holds the process open.
 */

import { runConnectorSync } from "@/lib/server/connector-sync";
import { drainJobQueue, registerJobHandler, type JobKind } from "@/lib/server/job-queue";
import { runScheduleNow } from "@/lib/server/scheduled";
import { runScheduledNotebookNow } from "@/lib/server/scheduled-notebook";

const DRAIN_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let drainInFlight = false;
let startedAt: number | null = null;
let lastTickAt: number | null = null;
let lastSummary: { recovered: number; claimed: number; done: number; retried: number; dead: number } | null = null;
let lastError: string | null = null;

function registerHandlers(): void {
  registerJobHandler("scheduled-report", async (payload) => {
    const scheduleId = typeof payload.scheduleId === "string" ? payload.scheduleId : null;
    if (!scheduleId) throw new Error("scheduled-report job is missing payload.scheduleId");
    await runScheduleNow(scheduleId);
  });

  registerJobHandler("scheduled-notebook", async (payload) => {
    const scheduleId = typeof payload.scheduleId === "string" ? payload.scheduleId : null;
    if (!scheduleId) throw new Error("scheduled-notebook job is missing payload.scheduleId");
    await runScheduledNotebookNow(scheduleId);
  });

  registerJobHandler("connector-sync", async (payload) => {
    const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
    const datasetId = typeof payload.datasetId === "string" ? payload.datasetId : null;
    if (!connectorId || !datasetId) {
      throw new Error("connector-sync job requires payload.connectorId and payload.datasetId");
    }
    await runConnectorSync(connectorId, datasetId, "schedule");
  });
}

async function drainTick(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    lastTickAt = Date.now();
    lastSummary = await drainJobQueue();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "unknown job-queue error";
  } finally {
    drainInFlight = false;
  }
}

/** Start the worker only when JOB_WORKER_ENABLED=true (called by instrumentation). */
export function maybeStartJobWorker(): void {
  if (process.env.JOB_WORKER_ENABLED !== "true") return;
  startJobWorker();
}

/** Start the drain loop unconditionally. Idempotent. */
export function startJobWorker(): void {
  if (timer) return;
  registerHandlers();
  startedAt = Date.now();
  timer = setInterval(() => {
    void drainTick();
  }, DRAIN_INTERVAL_MS);
  timer.unref?.();
  // First drain immediately so queued work starts without waiting a tick.
  void drainTick();
}

export function stopJobWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getJobWorkerStatus(): {
  enabled: boolean;
  running: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastSummary: { recovered: number; claimed: number; done: number; retried: number; dead: number } | null;
  lastError: string | null;
} {
  return {
    enabled: process.env.JOB_WORKER_ENABLED === "true",
    running: drainInFlight,
    startedAt,
    lastTickAt,
    lastSummary,
    lastError,
  };
}

export type { JobKind };

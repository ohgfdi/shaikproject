/**
 * Single-instance background scheduler (production model: ScheduledReport).
 *
 * Polls due scheduled-report rows (5-field cron) and runs them through
 * lib/server/scheduled.ts — export generation, notification, mail transport
 * and audit. Started from instrumentation.ts when the scheduler module is
 * enabled (moduleEnabled("SCHEDULER_ENABLED") — on by default under the pro
 * profile, or via SCHEDULER_ENABLED=true).
 *
 * Design notes:
 * - Multi-instance safe: before executing, a due schedule is CLAIMED with a
 *   conditional UPDATE (`SET lastRunAt = now WHERE lastRunAt = <value seen)`).
 *   Exactly one replica's claim succeeds — the others see zero rows updated
 *   and skip. This is the compare-and-swap pattern; it needs no locks, no
 *   leases, and no external queue, and it stays correct even with several
 *   second-long clock skews between replicas.
 * - At-most-once per due date: the claim stores the schedule's previous
 *   lastRunAt, so two ticks in the same process are also idempotent.
 * - Due detection is deterministic from `nextRunAt(cron, lastRunAt ?? now)`;
 *   a schedule whose last run is in the future is simply not due yet.
 * - The run logic it drives (lib/server/scheduled.ts) is stateless.
 */

import { prisma } from "@/lib/db";
import { nextRunAt } from "@/lib/engine/cron";

import { enqueueJob } from "./job-queue";
import { moduleEnabled } from "./modules";
import { generateIdempotencyKey } from "./queue";
import { runScheduleNow } from "./scheduled";

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  startedAt: number | null;
  lastTickAt: number | null;
  lastRunCount: number;
  lastError: string | null;
}

const POLL_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let startedAt: number | null = null;
let lastTickAt: number | null = null;
let lastRunCount = 0;
let lastError: string | null = null;

/**
 * Start the poller only when the scheduler module is enabled (called by
 * instrumentation). Uses moduleEnabled() rather than raw env so it agrees with
 * the nav and the API gate under LEDGERLY_PROFILE — a frozen module must not
 * run its background service, and an enabled one must.
 */
export function maybeStartScheduler(): void {
  if (!moduleEnabled("SCHEDULER_ENABLED")) return;
  startScheduler();
}

/** Start the poller unconditionally. Idempotent. */
export function startScheduler(): void {
  if (timer) return;
  startedAt = Date.now();
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  // Kick immediately so a due schedule runs within the first poll interval.
  void tick();
}

/** Stop the poller. */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getSchedulerStatus(): SchedulerStatus {
  return {
    enabled: moduleEnabled("SCHEDULER_ENABLED"),
    running: tickInFlight,
    startedAt,
    lastTickAt,
    lastRunCount,
    lastError,
  };
}

/** A due schedule row (id + cron + last run). */
export interface DueSchedule {
  id: string;
  cron: string;
  lastRunAt: Date | null;
}

/** Find enabled schedules whose next run is due (or past due). */
export async function findDueSchedules(): Promise<DueSchedule[]> {
  const schedules = await prisma.scheduledReport.findMany({
    where: { enabled: true },
    select: { id: true, cron: true, lastRunAt: true },
  });
  const now = new Date();
  const due: DueSchedule[] = [];
  for (const schedule of schedules) {
    try {
      const next = nextRunAt(schedule.cron, schedule.lastRunAt ?? now);
      if (next && next.getTime() <= now.getTime()) due.push(schedule);
    } catch {
      // Invalid cron is rejected at insert; skip defensively.
    }
  }
  return due;
}

/**
 * Claim a due schedule atomically: set lastRunAt = now ONLY IF lastRunAt is
 * still the value we saw. On success this replica owns the run; every other
 * replica's identical claim updates zero rows and skips. Returns the number
 * of claimed rows (0 or 1).
 */
export async function claimSchedule(id: string, previousLastRunAt: Date | null): Promise<boolean> {
  const now = new Date();
  // Postgres/SQLite-compatible compare-and-swap via updateMany. `lastRunAt:
  // previousLastRunAt` with null matches SQL `IS NULL` in Prisma semantics.
  const claimed = await prisma.scheduledReport.updateMany({
    where: { id, lastRunAt: previousLastRunAt },
    data: { lastRunAt: now },
  });
  return claimed.count === 1;
}

/** Run one poll tick: claim and execute every due schedule. Returns runs executed by THIS instance. */
export async function tick(): Promise<number> {
  if (tickInFlight) return 0;
  tickInFlight = true;
  let ran = 0;
  try {
    lastTickAt = Date.now();
    const due = await findDueSchedules();
    const durable = process.env.JOB_WORKER_ENABLED === "true";
    for (const schedule of due) {
      // Claim BEFORE running/enqueueing: with N replicas polling, exactly one
      // claim per due date succeeds. Losers skip; the winner proceeds.
      const won = await claimSchedule(schedule.id, schedule.lastRunAt);
      if (!won) continue;
      if (durable) {
        // Durable path (ROADMAP 5.4): the run becomes a JobQueue row executed
        // by the job worker with atomic claims, exponential backoff and crash
        // recovery — a worker killed mid-run loses nothing; restart completes
        // it. The idempotency key is stable per (schedule, claimed lastRunAt)
        // so a retry of the same tick can never double-execute a run.
        await enqueueJob({
          workspaceId:
            (await prisma.scheduledReport.findUnique({ where: { id: schedule.id }, select: { workspaceId: true } }))
              ?.workspaceId ?? "",
          kind: "scheduled-report",
          payload: { scheduleId: schedule.id },
          idempotencyKey: generateIdempotencyKey(`${schedule.id}:${schedule.lastRunAt?.toISOString() ?? "never"}`, 1),
        });
      } else {
        try {
          await runScheduleNow(schedule.id);
        } catch (runErr) {
          // The run failed AFTER the claim — record it as the schedule's last
          // error state (runScheduleNow normally updates this itself; this
          // covers hard crashes before that update).
          const message = runErr instanceof Error ? runErr.message : "scheduled run crashed";
          await prisma.scheduledReport
            .update({ where: { id: schedule.id }, data: { lastRunStatus: "error", lastRunMessage: message } })
            .catch(() => undefined);
        }
      }
      ran += 1;
    }
    // Data alerts (staleness + resolve-without-sync): evaluated on the same
    // poll cadence. Failures are isolated — alerts never break the scheduler.
    try {
      const { runDueAlertChecks } = await import("./alerts");
      await runDueAlertChecks(new Date());
    } catch {
      // isolated: alert problems never surface as scheduler errors
    }
    // Storage-limitation sweep (Phase 5.3): purges telemetry and dead
    // operational rows on a daily cadence. Also isolated, for the same reason.
    try {
      const { maybeRunRetentionSweep } = await import("./retention");
      await maybeRunRetentionSweep(new Date());
    } catch {
      // isolated: retention problems never surface as scheduler errors
    }
    // Live filing credential monitor: a background credential preflight that
    // alerts firm admins when the portal credentials stop working — so it
    // surfaces before a due date, not on one. Isolated like the rest.
    try {
      const { runFilingCredentialCheck } = await import("./filing-credential-monitor");
      await runFilingCredentialCheck(new Date());
    } catch {
      // isolated: monitor problems never surface as scheduler errors
    }
    // Filing reminders + escalations: T-7/T-3/T-0 nudges to the assignee and
    // an overdue escalation to owners/admins. Deduped through the filing event
    // log, so restarts and multiple replicas cannot notify twice. Isolated.
    try {
      const { runFilingAutomation } = await import("./filing-automation");
      await runFilingAutomation(new Date());
    } catch {
      // isolated: reminder problems never surface as scheduler errors
    }
    // Acknowledgement reconciliation: a filed run is checked against the live
    // portal when the gateway exposes status. Offline providers are marked
    // unverifiable — never silently treated as acknowledged. Isolated.
    try {
      const { reconcileFilingAcknowledgements } = await import("./filing-reconciliation");
      await reconcileFilingAcknowledgements(new Date());
    } catch {
      // isolated: reconciliation problems never surface as scheduler errors
    }
    lastRunCount += ran;
    lastError = null;
    return ran;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "unknown scheduler error";
    return 0;
  } finally {
    tickInFlight = false;
  }
}

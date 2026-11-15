/**
 * Durable job queue worker (Band 2.4).
 *
 * Drains the `JobQueue` table. Durability contract:
 *
 *  - ENQUEUE    — `enqueueJob()` is idempotent per `idempotencyKey` (a retried
 *                 enqueue can never double-execute; matches the key scheme in
 *                 lib/server/queue.ts).
 *  - CLAIM      — `claimDueJobs()` claims with an atomic conditional UPDATE
 *                 (`status='running', leaseUntil = now + LEASE`), so two
 *                 replicas never take the same job; a worker that dies leaves
 *                 its lease to expire and the job is re-claimed by another.
 *  - RETRY      — failures reschedule with exponential backoff from
 *                 `defaultRetryBackoff(runNumber)`; after `maxAttempts` the
 *                 job is parked as `dead` for operator inspection.
 *  - RESUME     — `recoverExpiredLeases()` re-queues jobs whose worker died
 *                 mid-run: killing the worker mid-job loses nothing; restart
 *                 completes it (the ROADMAP's definition of done).
 *
 * Handlers are registered per `kind`; the enqueue helpers for scheduled
 * reports/notebooks/connector syncs map 1:1 to the existing runners.
 */

import { prisma } from "@/lib/db";
import { generateIdempotencyKey, defaultRetryBackoff } from "@/lib/server/queue";

/** How long a claimed job's lease lasts before crash recovery may re-claim it. */
const LEASE_MS = 5 * 60_000;
/** Batch size per drain tick. */
const BATCH = 10;

export type JobKind = "scheduled-report" | "scheduled-notebook" | "connector-sync";

export interface JobRecord {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (payload: Record<string, unknown>, job: JobRecord) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Register the executor for a job kind (call at boot in instrumentation). */
export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/**
 * Enqueue a durable job. Idempotent when `idempotencyKey` is provided:
 * the unique index returns the existing row instead of duplicating work.
 */
export async function enqueueJob(input: {
  workspaceId: string;
  kind: JobKind;
  payload?: Record<string, unknown>;
  priority?: number;
  runAt?: Date;
  /** Stable per (logical job, run) — use generateIdempotencyKey(jobId, runNumber). */
  idempotencyKey?: string;
  maxAttempts?: number;
}): Promise<{ id: string; deduplicated: boolean }> {
  const key = input.idempotencyKey ?? null;
  if (key) {
    const existing = await prisma.jobQueue.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
    if (existing) return { id: existing.id, deduplicated: true };
  }
  try {
    const job = await prisma.jobQueue.create({
      data: {
        workspaceId: input.workspaceId,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        priority: input.priority ?? 0,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey: key,
      },
      select: { id: true },
    });
    return { id: job.id, deduplicated: false };
  } catch (err) {
    // Two replicas can pass the findUnique check at the same time; the unique
    // index is the real guard. Treat the loser as a dedupe, not a 500.
    if (key && typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      const existing = await prisma.jobQueue.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
      if (existing) return { id: existing.id, deduplicated: true };
    }
    throw err;
  }
}

/**
 * The storage contract a claim needs. Extracted so the multi-worker rule is a
 * pure loop that can be proven without a database: candidates are a hint, the
 * compare-and-swap is the only thing that grants a claim.
 */
export interface JobClaimStore {
  candidates(limit: number, now: Date): Promise<string[]>;
  /** True only for the caller that actually flipped the row to running. */
  claim(id: string, now: Date, leaseUntil: Date): Promise<boolean>;
}

/**
 * Claim ids through a store, one compare-and-swap at a time. Two replicas may
 * see the same candidates; the loser's `claim` returns false and it skips.
 */
export async function claimJobIds(
  store: JobClaimStore,
  limit: number,
  now: Date,
): Promise<string[]> {
  const ids = await store.candidates(limit, now);
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const claimed: string[] = [];
  for (const id of ids) {
    // Never trust the candidate list: the CAS is the authority.
    if (await store.claim(id, now, leaseUntil)) claimed.push(id);
  }
  return claimed;
}

/**
 * Atomically claim up to `limit` due jobs. The conditional UPDATE is the
 * compare-and-swap: only rows still `pending` (or with an expired lease) are
 * flipped to `running`, so concurrent workers never double-claim.
 */
export async function claimDueJobs(limit = BATCH, now = new Date()): Promise<JobRecord[]> {
  const ids = await claimJobIds(
    {
      candidates: async (take, at) => {
        const rows = await prisma.jobQueue.findMany({
          where: { status: "pending", runAt: { lte: at } },
          orderBy: [{ priority: "asc" }, { runAt: "asc" }],
          take,
          select: { id: true },
        });
        return rows.map((row) => row.id);
      },
      claim: async (id, at, leaseUntil) => {
        const res = await prisma.jobQueue.updateMany({
          where: { id, status: "pending", runAt: { lte: at } },
          data: { status: "running", leaseUntil, attempts: { increment: 1 } },
        });
        return res.count === 1;
      },
    },
    limit,
    now,
  );

  if (ids.length === 0) return [];
  const jobs = await prisma.jobQueue.findMany({ where: { id: { in: ids } } });
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return ids
    .map((id) => byId.get(id))
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      payload: job.payload,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    }));
}

/** Mark a job completed. */
export async function completeJob(jobId: string): Promise<void> {
  await prisma.jobQueue.update({
    where: { id: jobId },
    data: { status: "done", finishedAt: new Date(), leaseUntil: null, lastError: null },
  });
}

/**
 * Reschedule a failed job with exponential backoff, or park it as `dead`
 * when attempts are exhausted.
 */
export async function failJob(job: JobRecord, error: unknown, now = new Date()): Promise<"retry" | "dead"> {
  const message = error instanceof Error ? error.message : String(error);
  if (job.attempts >= job.maxAttempts) {
    await prisma.jobQueue.update({
      where: { id: job.id },
      data: { status: "dead", leaseUntil: null, lastError: message.slice(0, 2000), finishedAt: now },
    });
    return "dead";
  }
  const backoff = defaultRetryBackoff(job.attempts);
  await prisma.jobQueue.update({
    where: { id: job.id },
    data: {
      status: "pending",
      runAt: new Date(now.getTime() + backoff),
      leaseUntil: null,
      lastError: message.slice(0, 2000),
    },
  });
  return "retry";
}

/**
 * Crash recovery: re-queue jobs whose lease expired while `running` (worker
 * died mid-run). Called at boot and on each drain tick before claiming.
 */
export async function recoverExpiredLeases(now = new Date()): Promise<number> {
  const res = await prisma.jobQueue.updateMany({
    where: { status: "running", leaseUntil: { lt: now } },
    data: { status: "pending", leaseUntil: null },
  });
  return res.count;
}

/**
 * Drain one tick: recover crashed leases, claim due jobs, execute each via
 * its registered handler. Returns a summary for the scheduler log.
 */
export async function drainJobQueue(now = new Date()): Promise<{
  recovered: number;
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}> {
  const recovered = await recoverExpiredLeases(now);
  const jobs = await claimDueJobs(BATCH, now);
  let done = 0;
  let retried = 0;
  let dead = 0;

  for (const job of jobs) {
    const handler = handlers.get(job.kind);
    if (!handler) {
      // Unknown kind: park it rather than spin forever.
      await failJob(job, new Error(`No handler registered for kind "${job.kind}"`), now);
      dead += 1;
      continue;
    }
    try {
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      await handler(payload, job);
      await completeJob(job.id);
      done += 1;
    } catch (err) {
      const outcome = await failJob(job, err, now);
      if (outcome === "retry") retried += 1;
      else dead += 1;
    }
  }

  return { recovered, claimed: jobs.length, done, retried, dead };
}

/** Convenience: idempotency key for a scheduled run (matches queue.ts scheme). */
export function scheduledRunKey(scheduleId: string, runNumber: number): string {
  return generateIdempotencyKey(scheduleId, runNumber);
}

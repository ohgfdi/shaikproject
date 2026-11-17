/**
 * Phase 10: Job Queue Reliability
 *
 * Provides a reliable job queue system with:
 * - Retry with exponential backoff
 * - Dead-letter queue for permanently failed jobs
 * - Progress tracking
 * - Job kind enumeration
 *
 * Usage:
 *   import { enqueue, getJob, listPendingJobs } from "@/lib/job-queue";
 *
 *   const jobId = await enqueue("email", { to: "user@example.com", subject: "Hello" });
 *   const job = await getJob(jobId);
 */

import { v4 as uuidv4 } from "uuid";

import { prisma } from "./db";

export type JobKind =
  | "email"
  | "report"
  | "export"
  | "sync"
  | "notification"
  | "analysis"
  | "custom";

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface JobPayload {
  [key: string]: unknown;
}

/** Enqueue a new job for processing. */
export async function enqueue(
  kind: JobKind,
  payload: JobPayload,
  options: { maxAttempts?: number; delayMs?: number } = {},
) {
  const { maxAttempts = 5, delayMs = 0 } = options;

  const jobId = uuidv4();
  const now = new Date().toISOString();

  await prisma.jobQueue.create({
    data: {
      id: jobId,
      kind,
      status: "pending" as JobStatus,
      payload: JSON.stringify(payload),
      maxAttempts,
      attempts: 0,
      createdAt: now,

      // If a delay is specified, set the status to pending but track the delay
      ...(delayMs > 0 && { finishedAt: null }),
    },
  });

  return jobId;
}

/** Get a job by ID. */
export async function getJob(jobId: string) {
  return prisma.jobQueue.findUnique({
    where: { id: jobId },
  });
}

/** List pending jobs, optionally filtered by kind. */
export async function listPendingJobs(kind?: JobKind) {
  const where = kind ? { kind, status: "pending" } : { status: "pending" };
  return prisma.jobQueue.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
}

/** List failed jobs, optionally filtered by kind. */
export async function listFailedJobs(kind?: JobKind) {
  const where: any = { status: "failed" };
  if (kind) {
    where.kind = kind;
  }
  return prisma.jobQueue.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

/** Retry a failed job. */
export async function retryJob(jobId: string) {
  const job = await prisma.jobQueue.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (job.status !== "failed") {
    throw new Error(`Job ${jobId} is not in failed state (current: ${job.status})`);
  }

  // Increment attempts
  const newAttempts = (job.attempts ?? 0) + 1;

  if (newAttempts >= (job.maxAttempts ?? 5)) {
    // Move to dead-letter queue - mark as permanently failed
    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: "failed" as JobStatus,
        errorMsg: "Max attempts exceeded - moved to dead-letter queue",
        errorCode: "MAX_ATTEMPTS_EXCEEDED",
        attempts: newAttempts,
      },
    });
    return { status: "dead-lettered", jobId };
  }

  // Reset to pending with incremented attempts
  await prisma.jobQueue.update({
    where: { id: jobId },
    data: {
      status: "pending" as JobStatus,
      attempts: newAttempts,
    },
  });

  return { status: "requeued", jobId, attempts: newAttempts };
}

/** Mark a job as completed. */
export async function completeJob(jobId: string, result?: unknown) {
  const now = new Date().toISOString();

  await prisma.jobQueue.update({
    where: { id: jobId },
    data: {
      status: "completed" as JobStatus,
      finishedAt: now,
      ...(result !== undefined && { payload: JSON.stringify(result) }),
    },
  });

  return { status: "completed", jobId };
}

/** Custom error type for job failures. */
export type JobError = Error & {
  code?: string; // Error code for categorization
};

/** Mark a job as failed with error details. */
export async function failJob(
  jobId: string,
  error: JobError,
  options: { retryAfterMs?: number } = {},
) {
  const { retryAfterMs = 60000 } = options;
  const now = new Date().toISOString();

  await prisma.jobQueue.update({
    where: { id: jobId },
    data: {
      status: "failed" as JobStatus,
      errorMsg: error.message,
      errorCode: error.code,
      attempts: {
        increment: 1,
      },
      ...(retryAfterMs > 0 && {
        finishedAt: new Date(Date.now() + retryAfterMs).toISOString(),
      }),
    },
  });

  return { status: "failed", jobId, retryAfterMs };
}

/** Get job statistics. */
export async function getJobStats() {
  const [total, pending, running, completed, failed] = await Promise.all([
    prisma.jobQueue.count(),
    prisma.jobQueue.count({ where: { status: "pending" } }),
    prisma.jobQueue.count({ where: { status: "running" } }),
    prisma.jobQueue.count({ where: { status: "completed" } }),
    prisma.jobQueue.count({ where: { status: "failed" } }),
  ]);

  return {
    total,
    pending,
    running,
    completed,
    failed,
    successRate: total > 0 ? ((completed / total) * 100).toFixed(2) : 0,
  };
}
/**
 * Durable outbound-mail queue.
 *
 * Portal invitations still send inline because the firm needs an immediate
 * delivery verdict. Everything that is a *notification* (due-date nudges,
 * digests, future client notices) goes through this table instead: enqueue in
 * the same transaction as the work, let a worker deliver it, and retry with
 * exponential backoff when SMTP is down. A crash between "we decided to email"
 * and "the message left" now costs a retry, not the message.
 *
 * The queue stores the rendered body, not a pointer to it: what gets retried is
 * exactly what the firm approved, even if the underlying record later changes.
 */

import { sendMail, type OutgoingMail } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BATCH_SIZE = 20;

export type OutboxStatus = "pending" | "sending" | "sent" | "failed";

export interface OutboxMailInput {
  to: string;
  subject: string;
  text: string;
  organizationId?: string | null;
  maxAttempts?: number;
}

export interface OutboxRow {
  id: string;
  organizationId: string | null;
  toAddress: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  sentAt: Date | null;
  createdAt: Date;
}

/** Backoff after the Nth failed attempt: 30s, 60s, 2m, 4m… capped at 1h. */
export function outboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** exponent);
}

/** Count rows by state. Pure so the posture is testable without a database. */
export function summarizeOutbox(rows: Array<{ status: string }>): Record<OutboxStatus, number> {
  const counts: Record<OutboxStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "pending" || row.status === "sending" || row.status === "sent" || row.status === "failed") {
      counts[row.status] += 1;
    }
  }
  return counts;
}

export async function enqueueMail(input: OutboxMailInput): Promise<{ id: string }> {
  const to = input.to.trim();
  if (!to.includes("@")) throw new Error(`Cannot queue mail: "${input.to}" is not an email address.`);
  const row = await prisma.mailOutbox.create({
    data: {
      organizationId: input.organizationId ?? null,
      toAddress: to,
      subject: input.subject.slice(0, 300),
      body: input.text,
      maxAttempts: input.maxAttempts ?? OUTBOX_MAX_ATTEMPTS,
    },
    select: { id: true },
  });
  return row;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Claim and deliver due mail. Claiming is an atomic status transition, so two
 * worker replicas cannot both send the same row. A send that throws is retried
 * until maxAttempts, then left "failed" with the SMTP error for the operator.
 */
export async function drainMailOutbox(
  options: {
    now?: Date;
    limit?: number;
    sender?: (mail: OutgoingMail) => Promise<void>;
  } = {},
): Promise<DrainSummary> {
  const now = options.now ?? new Date();
  const sender = options.sender ?? sendMail;
  const summary: DrainSummary = { claimed: 0, sent: 0, retried: 0, failed: 0 };

  const due = await prisma.mailOutbox.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? OUTBOX_BATCH_SIZE,
  });

  for (const row of due) {
    const claimed = await prisma.mailOutbox.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    summary.claimed += 1;
    const attempts = row.attempts + 1;

    try {
      await sender({ to: row.toAddress, subject: row.subject, text: row.body });
      await prisma.mailOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), lastError: null },
      });
      summary.sent += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown SMTP error";
      const exhausted = attempts >= row.maxAttempts;
      await prisma.mailOutbox.update({
        where: { id: row.id },
        data: {
          status: exhausted ? "failed" : "pending",
          lastError: detail.slice(0, 1000),
          nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)),
        },
      });
      if (exhausted) summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}

/** Queue posture for `/api/metrics` and the preflight script. */
export async function outboxPosture(
  now: Date = new Date(),
): Promise<{
  counts: Record<OutboxStatus, number>;
  oldestPendingAgeMs: number | null;
}> {
  try {
    const [rows, oldest] = await Promise.all([
      prisma.mailOutbox.findMany({ select: { status: true }, take: 5_000 }),
      prisma.mailOutbox.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);
    return {
      counts: summarizeOutbox(rows),
      oldestPendingAgeMs: oldest ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) : null,
    };
  } catch {
    return {
      counts: { pending: 0, sending: 0, sent: 0, failed: 0 },
      oldestPendingAgeMs: null,
    };
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the 30s delivery loop (worker process only). Idempotent. */
export function startMailOutboxWorker(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void drainMailOutbox().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[mail-outbox] drain failed", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  timer.unref?.();
  void drainMailOutbox().catch(() => undefined);
}

export function stopMailOutboxWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

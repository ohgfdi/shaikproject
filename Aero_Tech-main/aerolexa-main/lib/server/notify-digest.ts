/**
 * Notification digest (ROADMAP 7.3) — a background loop that bundles each
 * user's unread notifications into one email and marks them read.
 *
 * Why a digest: scheduled-report failures, connector errors and analysis
 * alerts arrive while nobody is watching; a per-event email storm trains
 * people to ignore the inbox. One periodic bundle with everything unread is
 * the honest middle ground — and it reuses the EXACT in-app notification
 * rows the bell icon shows, so there is a single source of truth (no
 * separate "email queue" that could drift from what the app displays).
 *
 * Design notes (mirrors lib/server/scheduler.ts):
 * - Enabled with DIGEST_ENABLED=true from instrumentation.ts; the interval
 *   never holds the process open (.unref()).
 * - Read-marking is a conditional updateMany on `readAt: null` rows, so a
 *   user who reads a notification in-app between the email and the mark
 *   never gets it re-marked (their readAt wins; we only stamp unread rows).
 * - Email delivery is best-effort per user: a console-transport failure is
 *   logged and skipped, never thrown — the digest still marks those rows
 *   read because the in-app inbox remains the system of record.
 * - Notification-type preferences are enforced upstream by notify()
 *   (silenced types never reach the inbox), so the digest needs no second
 *   preference filter — it bundles exactly what the bell icon shows.
 */

import { mailFooter, sendMail } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";
import { appUrl } from "@/lib/env";

/** How far back "unread" reaches — 6 hours by default. */
export const DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Cap per email; the overflow is summarized, never silently dropped. */
export const DIGEST_MAX_ENTRIES = 25;

export interface DigestEntry {
  id: string;
  type: string;
  title: string;
  message: string | null;
  createdAt: Date;
}

export interface DigestResult {
  userId: string;
  email: string;
  /** Entries included in the email (capped at DIGEST_MAX_ENTRIES). */
  bundled: number;
  /** Total unread found — bundled + summarized overflow. */
  unread: number;
  emailed: boolean;
  markedRead: number;
  error: string | null;
}

/** Unread notifications for one user, oldest first, capped. */
export async function findUnreadNotifications(userId: string, since: Date): Promise<DigestEntry[]> {
  return prisma.notification.findMany({
    where: { userId, readAt: null, createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    take: DIGEST_MAX_ENTRIES,
    select: { id: true, type: true, title: true, message: true, createdAt: true },
  });
}

/** Human line for one entry: "• [report] Scheduled report ready — … (12:04)". */
export function formatDigestLine(entry: DigestEntry): string {
  const time = entry.createdAt.toISOString().slice(11, 16) + " UTC";
  const message = entry.message ? ` — ${entry.message}` : "";
  return `• [${entry.type}] ${entry.title}${message} (${time})`;
}

/** Plain-text email body for a digest bundle. */
export function renderDigestEmail(
  name: string,
  entries: DigestEntry[],
  unreadTotal: number,
): { subject: string; text: string } {
  if (entries.length === 0) {
    return {
      subject: "Ledgerly — no unread notifications",
      text: `Hi ${name},\n\n` + "You have no unread notifications. Nothing needs your attention.\n" + mailFooter(),
    };
  }

  const subject =
    unreadTotal === 1 ? "Ledgerly — 1 unread notification" : `Ledgerly — ${unreadTotal} unread notifications`;

  const lines = entries.map(formatDigestLine);
  const overflow = unreadTotal - entries.length;
  if (overflow > 0) {
    lines.push(`… and ${overflow} more — see the full list in the app.`);
  }

  const text =
    `Hi ${name},\n\n` +
    `You have ${unreadTotal} unread notification${unreadTotal === 1 ? "" : "s"}:\n\n` +
    lines.join("\n") +
    `\n\nView all: ${appUrl()}/notifications\n` +
    mailFooter();

  return { subject, text };
}

/**
 * Stamp the given notification rows read — but ONLY rows still unread, so a
 * user reading in-app concurrently keeps their own readAt timestamp.
 */
export async function markDigestRead(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await prisma.notification.updateMany({
    where: { id: { in: ids }, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}

/** Run one digest pass for every user with unread notifications. */
export async function runDigestOnce(now = new Date()): Promise<DigestResult[]> {
  const since = new Date(now.getTime() - DIGEST_INTERVAL_MS);
  const users = await prisma.user.findMany({
    where: { notifications: { some: { readAt: null, createdAt: { gt: since } } } },
    select: { id: true, email: true, name: true },
  });

  const results: DigestResult[] = [];
  for (const user of users) {
    const result: DigestResult = {
      userId: user.id,
      email: user.email,
      bundled: 0,
      unread: 0,
      emailed: false,
      markedRead: 0,
      error: null,
    };
    try {
      const entries = await findUnreadNotifications(user.id, since);
      const unreadTotal = await prisma.notification.count({
        where: { userId: user.id, readAt: null, createdAt: { gt: since } },
      });
      result.unread = unreadTotal;
      result.bundled = entries.length;
      if (entries.length === 0) {
        // Everything was read in-app between the prefetch and now — nothing to do.
        results.push(result);
        continue;
      }
      const { subject, text } = renderDigestEmail(user.name, entries, unreadTotal);
      try {
        await sendMail({ to: user.email, subject, text });
        result.emailed = true;
      } catch (err) {
        // Transport failure is logged, never fatal — the inbox is the record.
        result.error = err instanceof Error ? err.message : "mail transport failed";
      }
      result.markedRead = await markDigestRead(
        user.id,
        entries.map((e) => e.id),
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : "digest pass failed";
    }
    results.push(result);
  }
  return results;
}

// --- Scheduler loop (same pattern as lib/server/scheduler.ts) --------------

const DIGEST_POLL_INTERVAL_MS = 30 * 60 * 1000; // check twice an hour; each pass bundles the last 6h

let timer: NodeJS.Timeout | null = null;
let runInFlight = false;
let startedAt: number | null = null;
let lastRunAt: number | null = null;
let lastEmailed = 0;
let lastError: string | null = null;

/** Start only when DIGEST_ENABLED=true (called by instrumentation). */
export function maybeStartDigestScheduler(): void {
  if (process.env.DIGEST_ENABLED !== "true") return;
  startDigestScheduler();
}

/** Start the digest loop unconditionally. Idempotent. */
export function startDigestScheduler(): void {
  if (timer) return;
  startedAt = Date.now();
  timer = setInterval(() => {
    void digestTick();
  }, DIGEST_POLL_INTERVAL_MS);
  timer.unref?.();
  void digestTick();
}

export function stopDigestScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function digestTick(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;
  try {
    const results = await runDigestOnce();
    lastRunAt = Date.now();
    lastEmailed = results.filter((r) => r.emailed).length;
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "unknown digest error";
  } finally {
    runInFlight = false;
  }
}

export function getDigestSchedulerStatus(): {
  enabled: boolean;
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  lastEmailed: number;
  lastError: string | null;
} {
  return {
    enabled: process.env.DIGEST_ENABLED === "true",
    running: runInFlight,
    startedAt,
    lastRunAt,
    lastEmailed,
    lastError,
  };
}

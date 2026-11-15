/**
 * Fiscal period locks.
 *
 * A lock is a hard stop, not a UI preference: once a period is locked, no
 * voucher or subledger posting may be dated inside it until an operator
 * explicitly unlocks it. Corrections are made by posting into the current
 * period, which is what keeps a filed return and the ledger consistent.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export class PeriodLockError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "PeriodLockError";
  }
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

export function assertPeriodFormat(period: string): string {
  if (!PERIOD_RE.test(period)) {
    throw new PeriodLockError(400, "VALIDATION", "Period must be in yyyy-mm format.");
  }
  return period;
}

type DbClient = Pick<typeof prisma, "fiscalPeriodLock">;

/** Throw 409 when the voucher date falls inside a locked period. */
export async function assertPeriodOpen(bookId: string, date: string, client: DbClient = prisma): Promise<void> {
  const period = periodOf(date);
  const lock = await client.fiscalPeriodLock.findUnique({
    where: { bookId_period: { bookId, period } },
    select: { period: true, reason: true },
  });
  if (lock) {
    throw new PeriodLockError(
      409,
      "PERIOD_LOCKED",
      `Period ${lock.period} is locked${lock.reason ? ` (${lock.reason})` : ""}. Post the correction in an open period.`,
    );
  }
}

export async function listPeriodLocks(bookId: string) {
  return prisma.fiscalPeriodLock.findMany({ where: { bookId }, orderBy: { period: "asc" } });
}

export async function lockPeriod(input: { bookId: string; period: string; actorId: string; reason?: string | null }) {
  const period = assertPeriodFormat(input.period);
  const existing = await prisma.fiscalPeriodLock.findUnique({
    where: { bookId_period: { bookId: input.bookId, period } },
  });
  if (existing) return existing;
  return prisma.fiscalPeriodLock.create({
    data: {
      bookId: input.bookId,
      period,
      lockedById: input.actorId,
      reason: input.reason ?? null,
    },
  });
}

export async function unlockPeriod(input: { bookId: string; period: string; actorId: string }) {
  const period = assertPeriodFormat(input.period);
  const existing = await prisma.fiscalPeriodLock.findUnique({
    where: { bookId_period: { bookId: input.bookId, period } },
  });
  if (!existing) throw new PeriodLockError(404, "NOT_FOUND", `Period ${period} is not locked.`);
  await prisma.fiscalPeriodLock.delete({ where: { id: existing.id } });
  return existing;
}

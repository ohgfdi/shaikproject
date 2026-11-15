/**
 * Closing Entries — period-end closing journals for revenue, expense,
 * depreciation, provisions, tax.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateEntry, type AccountType, type JournalEntry } from "@/lib/engine/accounting";
import { stringifyJson } from "@/lib/json";
import { assertIsoDate, assertJournalLines } from "@/lib/server/finance-validation";
import { assertPeriodOpen } from "@/lib/server/period-locks";
import { voucherTotals } from "@/lib/server/voucher-fields";

export class ClosingEntryStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "ClosingEntryStoreError";
  }
}

export interface ClosingEntryInput {
  number: string;
  date: string;
  narration: string;
  period: string; // "2025-26" or "2025-03"
  closingType: string; // revenue | expense | depreciation | provision | tax | other
  lines: { accountCode: string; amount: number; narration?: string | null }[];
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createClosingEntry(
  workspaceId: string,
  bookId: string,
  input: ClosingEntryInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  assertIsoDate(input.date, "Closing entry date");
  assertJournalLines(input.lines);

  const existing = await prisma.closingEntry.findUnique({
    where: { bookId_number: { bookId, number: input.number } },
  });
  if (existing) throw new ClosingEntryStoreError(409, "DUPLICATE", `Closing entry ${input.number} already exists.`);

  // Validate accounts exist
  const accounts = await prisma.bookAccount.findMany({ where: { bookId } });
  if (accounts.length === 0) throw new ClosingEntryStoreError(400, "NO_ACCOUNTS", "Book has no chart of accounts.");

  const byCode = new Map(accounts.map((a) => [a.code, a] as const));

  // Convert to engine entry for validation
  const engineEntry: JournalEntry = {
    id: input.number,
    date: input.date,
    narration: input.narration,
    lines: input.lines.map((l) => {
      if (!byCode.has(l.accountCode)) {
        throw new ClosingEntryStoreError(400, "UNKNOWN_ACCOUNT", `Account ${l.accountCode} does not exist.`);
      }
      return { accountCode: l.accountCode, amount: l.amount, narration: l.narration ?? undefined };
    }),
  };

  try {
    validateEntry(
      engineEntry,
      accounts.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type as AccountType,
        category: a.category,
        description: a.description ?? undefined,
      })),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AccountingError") {
      throw new ClosingEntryStoreError(400, "UNBALANCED_ENTRY", err.message);
    }
    throw err;
  }

  const entry = await prisma.closingEntry.create({
    data: {
      bookId,
      number: input.number,
      date: input.date,
      narration: input.narration,
      period: input.period,
      closingType: input.closingType,
      lines: {
        create: engineEntry.lines.map((l) => ({
          accountId: byCode.get(l.accountCode)!.id,
          amount: l.amount,
          narration: l.narration ?? null,
        })),
      },
      status: "draft",
      createdById: actorId,
    },
    include: { lines: { include: { account: true } } },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ClosingEntry",
      entityId: entry.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return entry;
}

export async function listClosingEntries(
  workspaceId: string,
  bookId: string,
  opts: { period?: string; closingType?: string; status?: string; limit?: number; offset?: number } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.period) where.period = opts.period;
  if (opts.closingType) where.closingType = opts.closingType;
  if (opts.status) where.status = opts.status;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [entries, total] = await Promise.all([
    prisma.closingEntry.findMany({
      where,
      orderBy: [{ date: "desc" }, { number: "desc" }],
      take: limit,
      skip: offset,
      include: { lines: { include: { account: true } } },
    }),
    prisma.closingEntry.count({ where }),
  ]);

  return { entries, total, limit, offset };
}

export async function getClosingEntry(workspaceId: string, bookId: string, entryId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const entry = await prisma.closingEntry.findFirst({
    where: { id: entryId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!entry) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Closing entry not found.");
  return entry;
}

export async function updateClosingEntry(
  workspaceId: string,
  bookId: string,
  entryId: string,
  input: Partial<ClosingEntryInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.closingEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Closing entry not found.");
  if (existing.status !== "draft")
    throw new ClosingEntryStoreError(400, "INVALID_STATE", "Only draft closing entries can be updated.");

  if (input.date !== undefined) assertIsoDate(input.date, "Closing entry date");
  if (input.lines !== undefined) assertJournalLines(input.lines);

  let engineEntry: JournalEntry | undefined;
  if (input.lines) {
    const accounts = await prisma.bookAccount.findMany({ where: { bookId } });
    const byCode = new Map(accounts.map((a) => [a.code, a] as const));
    engineEntry = {
      id: input.number ?? existing.number,
      date: input.date ?? existing.date,
      narration: input.narration ?? existing.narration,
      lines: input.lines.map((l) => {
        if (!byCode.has(l.accountCode))
          throw new ClosingEntryStoreError(400, "UNKNOWN_ACCOUNT", `Account ${l.accountCode} does not exist.`);
        return { accountCode: l.accountCode, amount: l.amount, narration: l.narration ?? undefined };
      }),
    };
    try {
      validateEntry(
        engineEntry,
        accounts.map((a) => ({
          code: a.code,
          name: a.name,
          type: a.type as AccountType,
          category: a.category,
          description: a.description ?? undefined,
        })),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AccountingError") {
        throw new ClosingEntryStoreError(400, "UNBALANCED_ENTRY", err.message);
      }
      throw err;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (engineEntry) {
      await tx.closingEntryLine.deleteMany({ where: { entryId } });
      const accounts = await tx.bookAccount.findMany({ where: { bookId } });
      const byCode = new Map(accounts.map((a) => [a.code, a.id] as const));
      await tx.closingEntry.update({
        where: { id: entryId },
        data: {
          number: input.number ?? undefined,
          date: input.date ?? undefined,
          narration: input.narration ?? undefined,
          period: input.period ?? undefined,
          closingType: input.closingType ?? undefined,
          lines: {
            create: engineEntry!.lines.map((l) => ({
              accountId: byCode.get(l.accountCode)!,
              amount: l.amount,
              narration: l.narration ?? null,
            })),
          },
        },
      });
    } else {
      await tx.closingEntry.update({
        where: { id: entryId },
        data: {
          number: input.number ?? undefined,
          date: input.date ?? undefined,
          narration: input.narration ?? undefined,
          period: input.period ?? undefined,
          closingType: input.closingType ?? undefined,
        },
      });
    }
    return tx.closingEntry.findUnique({ where: { id: entryId }, include: { lines: { include: { account: true } } } });
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ClosingEntry",
      entityId: entryId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function approveClosingEntry(workspaceId: string, bookId: string, entryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.closingEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Closing entry not found.");
  if (existing.status !== "draft")
    throw new ClosingEntryStoreError(400, "INVALID_STATE", "Only draft entries can be approved.");

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.closingEntry.updateMany({
      where: { id: entryId, bookId, status: "draft" },
      data: { status: "approved", approvedById: actorId, approvedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ClosingEntryStoreError(409, "INVALID_STATE", "This closing entry is no longer a draft.");
    }

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "ClosingEntry",
        entityId: entryId,
        action: "approve",
        fieldChanges: stringifyJson({ status: { old: "draft", new: "approved" } }),
        actorId,
      },
    });

    return tx.closingEntry.findUniqueOrThrow({ where: { id: entryId } });
  });
}

export async function postClosingEntry(workspaceId: string, bookId: string, entryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.closingEntry.findFirst({
    where: { id: entryId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!existing) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Closing entry not found.");
  if (existing.status !== "approved")
    throw new ClosingEntryStoreError(400, "INVALID_STATE", "Only approved entries can be posted.");

  // Posting is one atomic unit: claim the entry (compare-and-swap on status),
  // create the voucher, flip the status and write the audit row. A crash can
  // never leave a voucher without a posted entry (or vice versa), and two
  // concurrent post attempts cannot both create a voucher.
  const result = await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(bookId, existing.date, tx);
    const claimed = await tx.closingEntry.updateMany({
      where: { id: entryId, bookId, status: "approved" },
      data: { status: "posting" },
    });
    if (claimed.count !== 1) {
      throw new ClosingEntryStoreError(409, "ALREADY_POSTED", "This closing entry was already posted.");
    }

    const totals = voucherTotals(existing.lines);
    const voucher = await tx.bookVoucher.create({
      data: {
        bookId,
        number: existing.number,
        date: existing.date,
        narration: `[CLOSING] ${existing.narration}`,
        reference: `CLS:${existing.number}`,
        voucherType: "journal",
        status: "posted",
        postedAt: new Date(),
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: {
          create: existing.lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount,
            narration: l.narration ?? null,
          })),
        },
      },
    });

    const entry = await tx.closingEntry.update({
      where: { id: entryId },
      data: { status: "posted", postedById: actorId, postedAt: new Date() },
    });

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "ClosingEntry",
        entityId: entryId,
        action: "post",
        fieldChanges: stringifyJson({ status: { old: "approved", new: "posted" }, voucherId: voucher.id }),
        actorId,
      },
    });

    return { entry, voucher };
  });

  return result;
}

export async function deleteClosingEntry(workspaceId: string, bookId: string, entryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.closingEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new ClosingEntryStoreError(404, "NOT_FOUND", "Closing entry not found.");
  if (existing.status === "posted")
    throw new ClosingEntryStoreError(400, "INVALID_STATE", "Cannot delete a posted closing entry; reverse it instead.");

  await prisma.closingEntry.delete({ where: { id: entryId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ClosingEntry",
      entityId: entryId,
      action: "delete",
      actorId,
    },
  });
}

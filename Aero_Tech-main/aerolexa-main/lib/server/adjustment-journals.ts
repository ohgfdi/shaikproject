/**
 * Adjustment Journal — period-end adjustments with reversing entry support.
 * Supports accruals, deferrals, depreciation, provisions, revaluations.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateEntry, type AccountType, type JournalEntry } from "@/lib/engine/accounting";
import { stringifyJson } from "@/lib/json";
import { assertIsoDate, assertJournalLines } from "@/lib/server/finance-validation";

export class AdjustmentJournalStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "AdjustmentJournalStoreError";
  }
}

export interface AdjustmentJournalInput {
  number: string;
  date: string;
  narration: string;
  reference?: string | null;
  adjustmentType: string; // accrual | deferral | depreciation | provision | revaluation | other
  reverses?: boolean;
  reverseDate?: string | null;
  reversedFromId?: string | null;
  lines: { accountCode: string; amount: number; narration?: string | null }[];
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createAdjustmentJournal(
  workspaceId: string,
  bookId: string,
  input: AdjustmentJournalInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  assertIsoDate(input.date, "Adjustment journal date");
  assertJournalLines(input.lines);
  if (input.reverseDate) assertIsoDate(input.reverseDate, "Reversal date");

  // Validate adjustment journal number uniqueness
  const existing = await prisma.adjustmentJournal.findUnique({
    where: { bookId_number: { bookId, number: input.number } },
  });
  if (existing)
    throw new AdjustmentJournalStoreError(409, "DUPLICATE", `Adjustment journal ${input.number} already exists.`);

  // Validate accounts exist
  const accounts = await prisma.bookAccount.findMany({ where: { bookId } });
  if (accounts.length === 0)
    throw new AdjustmentJournalStoreError(400, "NO_ACCOUNTS", "Book has no chart of accounts.");

  const byCode = new Map(accounts.map((a) => [a.code, a] as const));

  // Convert to engine entry for validation
  const engineEntry: JournalEntry = {
    id: input.number,
    date: input.date,
    narration: input.narration,
    reference: input.reference ?? undefined,
    lines: input.lines.map((l) => {
      if (!byCode.has(l.accountCode)) {
        throw new AdjustmentJournalStoreError(400, "UNKNOWN_ACCOUNT", `Account ${l.accountCode} does not exist.`);
      }
      return { accountCode: l.accountCode, amount: l.amount, narration: l.narration ?? undefined };
    }),
  };

  // Validate balances
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
      throw new AdjustmentJournalStoreError(400, "UNBALANCED_ENTRY", err.message);
    }
    throw err;
  }

  // Create journal with lines
  const journal = await prisma.adjustmentJournal.create({
    data: {
      bookId,
      number: input.number,
      date: input.date,
      narration: input.narration,
      reference: input.reference ?? null,
      adjustmentType: input.adjustmentType,
      reverses: input.reverses ?? false,
      reverseDate: input.reverseDate ?? null,
      reversedFromId: input.reversedFromId ?? null,
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
      entityType: "AdjustmentJournal",
      entityId: journal.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return journal;
}

export async function listAdjustmentJournals(
  workspaceId: string,
  bookId: string,
  opts: { status?: string; adjustmentType?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.status) where.status = opts.status;
  if (opts.adjustmentType) where.adjustmentType = opts.adjustmentType;
  if (opts.from || opts.to) {
    where.date = {};
    if (opts.from) (where.date as Record<string, string>).gte = opts.from;
    if (opts.to) (where.date as Record<string, string>).lte = opts.to;
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [journals, total] = await Promise.all([
    prisma.adjustmentJournal.findMany({
      where,
      orderBy: [{ date: "desc" }, { number: "desc" }],
      take: limit,
      skip: offset,
      include: { lines: { include: { account: true } } },
    }),
    prisma.adjustmentJournal.count({ where }),
  ]);

  return { journals, total, limit, offset };
}

export async function getAdjustmentJournal(workspaceId: string, bookId: string, journalId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const journal = await prisma.adjustmentJournal.findFirst({
    where: { id: journalId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!journal) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  return journal;
}

export async function updateAdjustmentJournal(
  workspaceId: string,
  bookId: string,
  journalId: string,
  input: Partial<AdjustmentJournalInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.adjustmentJournal.findFirst({ where: { id: journalId, bookId } });
  if (!existing) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  if (existing.status !== "draft") {
    throw new AdjustmentJournalStoreError(400, "INVALID_STATE", "Only draft journals can be updated.");
  }

  if (input.date !== undefined) assertIsoDate(input.date, "Adjustment journal date");
  if (input.reverseDate !== undefined && input.reverseDate !== null) {
    assertIsoDate(input.reverseDate, "Reversal date");
  }
  if (input.lines !== undefined) assertJournalLines(input.lines);

  // Validate if lines provided
  let engineEntry: JournalEntry | undefined;
  if (input.lines) {
    const accounts = await prisma.bookAccount.findMany({ where: { bookId } });
    const byCode = new Map(accounts.map((a) => [a.code, a] as const));
    engineEntry = {
      id: input.number ?? existing.number,
      date: input.date ?? existing.date,
      narration: input.narration ?? existing.narration,
      reference: input.reference ?? existing.reference ?? undefined,
      lines: input.lines.map((l) => {
        if (!byCode.has(l.accountCode))
          throw new AdjustmentJournalStoreError(400, "UNKNOWN_ACCOUNT", `Account ${l.accountCode} does not exist.`);
        return { accountCode: l.accountCode, amount: l.amount, narration: l.narration ?? undefined };
      }),
    };
    try {
      validateEntry(
        engineEntry!,
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
        throw new AdjustmentJournalStoreError(400, "UNBALANCED_ENTRY", err.message);
      }
      throw err;
    }
  }

  // Update in transaction
  const updated = await prisma.$transaction(async (tx) => {
    if (engineEntry) {
      // Delete old lines, create new
      await tx.adjustmentJournalLine.deleteMany({ where: { journalId } });
      const accounts = await tx.bookAccount.findMany({ where: { bookId } });
      const byCode = new Map(accounts.map((a) => [a.code, a.id] as const));
      await tx.adjustmentJournal.update({
        where: { id: journalId },
        data: {
          number: input.number ?? undefined,
          date: input.date ?? undefined,
          narration: input.narration ?? undefined,
          reference: input.reference ?? undefined,
          adjustmentType: input.adjustmentType ?? undefined,
          reverses: input.reverses ?? undefined,
          reverseDate: input.reverseDate ?? undefined,
          reversedFromId: input.reversedFromId ?? undefined,
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
      await tx.adjustmentJournal.update({
        where: { id: journalId },
        data: {
          number: input.number ?? undefined,
          date: input.date ?? undefined,
          narration: input.narration ?? undefined,
          reference: input.reference ?? undefined,
          adjustmentType: input.adjustmentType ?? undefined,
          reverses: input.reverses ?? undefined,
          reverseDate: input.reverseDate ?? undefined,
          reversedFromId: input.reversedFromId ?? undefined,
        },
      });
    }
    return tx.adjustmentJournal.findUnique({
      where: { id: journalId },
      include: { lines: { include: { account: true } } },
    });
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "AdjustmentJournal",
      entityId: journalId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function approveAdjustmentJournal(
  workspaceId: string,
  bookId: string,
  journalId: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.adjustmentJournal.findFirst({ where: { id: journalId, bookId } });
  if (!existing) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  if (existing.status !== "draft")
    throw new AdjustmentJournalStoreError(400, "INVALID_STATE", "Only draft journals can be approved.");

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.adjustmentJournal.updateMany({
      where: { id: journalId, bookId, status: "draft" },
      data: { status: "approved", approvedById: actorId, approvedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new AdjustmentJournalStoreError(409, "INVALID_STATE", "This journal is no longer a draft.");
    }

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "AdjustmentJournal",
        entityId: journalId,
        action: "approve",
        fieldChanges: stringifyJson({ status: { old: "draft", new: "approved" } }),
        actorId,
      },
    });

    return tx.adjustmentJournal.findUniqueOrThrow({ where: { id: journalId } });
  });
}

export async function postAdjustmentJournal(workspaceId: string, bookId: string, journalId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.adjustmentJournal.findFirst({
    where: { id: journalId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!existing) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  if (existing.status !== "approved")
    throw new AdjustmentJournalStoreError(400, "INVALID_STATE", "Only approved journals can be posted.");

  // Atomic post: claim the journal via compare-and-swap, create the voucher,
  // flip status and audit in one transaction. Concurrent posts cannot both win.
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.adjustmentJournal.updateMany({
      where: { id: journalId, bookId, status: "approved" },
      data: { status: "posting" },
    });
    if (claimed.count !== 1) {
      throw new AdjustmentJournalStoreError(409, "ALREADY_POSTED", "This journal was already posted.");
    }

    const voucher = await tx.bookVoucher.create({
      data: {
        bookId,
        number: existing.number,
        date: existing.date,
        narration: `[ADJ] ${existing.narration}`,
        reference: existing.reference ?? `ADJ:${existing.number}`,
        voucherType: "journal",
        lines: {
          create: existing.lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount,
            narration: l.narration ?? null,
          })),
        },
      },
    });

    const journal = await tx.adjustmentJournal.update({
      where: { id: journalId },
      data: { status: "posted", postedById: actorId, postedAt: new Date() },
    });

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "AdjustmentJournal",
        entityId: journalId,
        action: "post",
        fieldChanges: stringifyJson({ status: { old: "approved", new: "posted" }, voucherId: voucher.id }),
        actorId,
      },
    });

    return { journal, voucher };
  });
}

export async function reverseAdjustmentJournal(
  workspaceId: string,
  bookId: string,
  journalId: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.adjustmentJournal.findFirst({
    where: { id: journalId, bookId },
    include: { lines: true },
  });
  if (!existing) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  if (existing.status !== "posted")
    throw new AdjustmentJournalStoreError(400, "INVALID_STATE", "Only posted journals can be reversed.");

  const alreadyReversed = await prisma.adjustmentJournal.findFirst({ where: { reversedFromId: existing.id } });
  if (alreadyReversed) {
    throw new AdjustmentJournalStoreError(
      409,
      "ALREADY_REVERSED",
      `Journal ${existing.number} has already been reversed.`,
    );
  }

  const reverseDate = existing.reverseDate ?? new Date().toISOString().slice(0, 10);
  const reverseNumber = `${existing.number}-REV`;

  // Reversal creates a journal, a voucher and an audit row; keep them atomic so
  // a failed write cannot leave a reversal voucher without its journal.
  return prisma.$transaction(async (tx) => {
    const reverseJournal = await tx.adjustmentJournal.create({
      data: {
        bookId,
        number: reverseNumber,
        date: reverseDate,
        narration: `Reversal of ${existing.number}: ${existing.narration}`,
        reference: existing.reference ?? null,
        adjustmentType: existing.adjustmentType,
        reverses: true,
        reverseDate: null,
        reversedFromId: existing.id,
        lines: {
          create: existing.lines.map((l) => ({
            accountId: l.accountId,
            amount: -l.amount, // flip sign
            narration: `Reversal: ${l.narration ?? ""}`,
          })),
        },
        status: "posted",
        postedById: actorId,
        postedAt: new Date(),
        createdById: actorId,
      },
    });

    await tx.bookVoucher.create({
      data: {
        bookId,
        number: reverseNumber,
        date: reverseDate,
        narration: `[REV] ${existing.narration}`,
        reference: `REV:${existing.number}`,
        voucherType: "journal",
        lines: {
          create: existing.lines.map((l) => ({
            accountId: l.accountId,
            amount: -l.amount,
            narration: `Reversal: ${l.narration ?? ""}`,
          })),
        },
      },
    });

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "AdjustmentJournal",
        entityId: journalId,
        action: "reverse",
        fieldChanges: stringifyJson({ reversedJournalId: reverseJournal.id, reverseNumber }),
        actorId,
      },
    });

    return reverseJournal;
  });
}

export async function deleteAdjustmentJournal(workspaceId: string, bookId: string, journalId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.adjustmentJournal.findFirst({ where: { id: journalId, bookId } });
  if (!existing) throw new AdjustmentJournalStoreError(404, "NOT_FOUND", "Adjustment journal not found.");
  if (existing.status === "posted")
    throw new AdjustmentJournalStoreError(400, "INVALID_STATE", "Cannot delete a posted journal; reverse it instead.");

  await prisma.adjustmentJournal.delete({ where: { id: journalId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "AdjustmentJournal",
      entityId: journalId,
      action: "delete",
      actorId,
    },
  });
}

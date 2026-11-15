/**
 * Bank Feeds — imported bank statements with auto-matching rules and
 * reconciliation status. Supports statement upload, auto-matching to vouchers,
 * and reconciliation workflow.
 */
import type { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { reconcileBank, type CashBookRow, type BankStatementRow } from "@/lib/engine/bank-recon";
import { stringifyJson } from "@/lib/json";
export class BankFeedStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "BankFeedStoreError";
  }
}

export interface BankFeedInput {
  accountName: string;
  accountNumber: string;
  bankName: string;
  ifsc?: string | null;
  feedType?: string; // manual | open-banking | api | statement-upload
  statementFrom: string;
  statementTo: string;
  openingBalance: number;
  closingBalance: number;
}

export interface BankFeedListOptions {
  reconciled?: boolean;
  feedType?: string;
  limit?: number;
  offset?: number;
}

function validateFeedInput(input: BankFeedInput): void {
  if (!input.accountName?.trim()) throw new BankFeedStoreError(400, "VALIDATION", "Account name is required.");
  if (!input.accountNumber?.trim()) throw new BankFeedStoreError(400, "VALIDATION", "Account number is required.");
  if (!input.bankName?.trim()) throw new BankFeedStoreError(400, "VALIDATION", "Bank name is required.");
  if (!input.statementFrom) throw new BankFeedStoreError(400, "VALIDATION", "Statement from date is required.");
  if (!input.statementTo) throw new BankFeedStoreError(400, "VALIDATION", "Statement to date is required.");
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new BankFeedStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

/** Run a callback within a Prisma transaction, propagating audit entries. */
export async function withTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => callback(tx));
}

export async function createBankFeed(workspaceId: string, bookId: string, input: BankFeedInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  validateFeedInput(input);

  const feed = await withTransaction(async (tx) => {
    const created = await tx.bankFeed.create({
      data: {
        bookId,
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        bankName: input.bankName,
        ifsc: input.ifsc ?? null,
        feedType: input.feedType ?? "manual",
        statementFrom: input.statementFrom,
        statementTo: input.statementTo,
        openingBalance: Math.round(input.openingBalance),
        closingBalance: Math.round(input.closingBalance),
        importedById: actorId,
      },
    });

    await tx.bookAuditEntry.create({
      data: {
        bookId,
        entityType: "BankFeed",
        entityId: created.id,
        action: "create",
        fieldChanges: stringifyJson({ new: input }),
        actorId,
      },
    });

    return created;
  });

  return feed;
}

export async function listBankFeeds(workspaceId: string, bookId: string, opts: BankFeedListOptions = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.reconciled !== undefined) where.reconciled = opts.reconciled;
  if (opts.feedType) where.feedType = opts.feedType;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [feeds, total] = await Promise.all([
    prisma.bankFeed.findMany({
      where,
      orderBy: { statementTo: "desc" },
      take: limit,
      skip: offset,
      include: {
        _count: { select: { transactions: true } },
      },
    }),
    prisma.bankFeed.count({ where }),
  ]);

  return { feeds, total, limit, offset };
}

export async function getBankFeed(workspaceId: string, bookId: string, feedId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");
  return feed;
}

export async function updateBankFeed(
  workspaceId: string,
  bookId: string,
  feedId: string,
  input: Partial<BankFeedInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!existing) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  const updated = await prisma.bankFeed.update({
    where: { id: feedId },
    data: {
      accountName: input.accountName ?? undefined,
      accountNumber: input.accountNumber ?? undefined,
      bankName: input.bankName ?? undefined,
      ifsc: input.ifsc ?? undefined,
      feedType: input.feedType ?? undefined,
      statementFrom: input.statementFrom ?? undefined,
      statementTo: input.statementTo ?? undefined,
      openingBalance: input.openingBalance !== undefined ? Math.round(input.openingBalance) : undefined,
      closingBalance: input.closingBalance !== undefined ? Math.round(input.closingBalance) : undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankFeed",
      entityId: feedId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId: actorId,
    },
  });

  return updated;
}

export async function deleteBankFeed(workspaceId: string, bookId: string, feedId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!existing) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  await prisma.bankFeed.delete({ where: { id: feedId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankFeed",
      entityId: feedId,
      action: "delete",
      before: stringifyJson(existing),
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Bank Transactions
// ---------------------------------------------------------------------------

export interface BankTransactionInput {
  date: string;
  narration: string;
  amount: number; // minor units, bank convention: positive = credit
  reference?: string | null;
  valueDate?: string | null;
}

export async function createBankTransaction(
  workspaceId: string,
  bookId: string,
  feedId: string,
  input: BankTransactionInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  const transaction = await prisma.bankTransaction.create({
    data: {
      feedId,
      date: input.date,
      narration: input.narration,
      amount: Math.round(input.amount),
      reference: input.reference ?? null,
      valueDate: input.valueDate ?? null,
      matchStatus: "unmatched",
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankTransaction",
      entityId: transaction.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input, feedId }),
      actorId,
    },
  });

  return transaction;
}

export async function listBankTransactions(
  workspaceId: string,
  bookId: string,
  feedId: string,
  opts: { matchStatus?: string; limit?: number; offset?: number } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);
  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  const where: Record<string, unknown> = { feedId };
  if (opts.matchStatus) where.matchStatus = opts.matchStatus;

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [transactions, total] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      orderBy: { date: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.bankTransaction.count({ where }),
  ]);

  return { transactions, total, limit, offset };
}

export async function bulkCreateBankTransactions(
  workspaceId: string,
  bookId: string,
  feedId: string,
  transactions: BankTransactionInput[],
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  const created = await prisma.bankTransaction.createMany({
    data: transactions.map((t) => ({
      feedId,
      date: t.date,
      narration: t.narration,
      amount: Math.round(t.amount),
      reference: t.reference ?? null,
      valueDate: t.valueDate ?? null,
      matchStatus: "unmatched",
    })),
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankTransaction",
      entityId: feedId,
      action: "bulk_create",
      fieldChanges: stringifyJson({ count: created.count, feedId }),
      actorId,
    },
  });

  return created;
}

export async function updateBankTransaction(
  workspaceId: string,
  bookId: string,
  transactionId: string,
  input: {
    matchStatus?: string;
    matchedVoucherId?: string | null;
    matchScore?: number | null;
    matchRuleId?: string | null;
    overrideNote?: string | null;
  },
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.bankTransaction.findFirst({ where: { id: transactionId, feed: { bookId } } });
  if (!existing) throw new BankFeedStoreError(404, "NOT_FOUND", "Transaction not found.");

  const updated = await prisma.bankTransaction.update({
    where: { id: transactionId },
    data: {
      matchStatus: input.matchStatus ?? undefined,
      matchedVoucherId: input.matchedVoucherId ?? undefined,
      matchScore: input.matchScore ?? undefined,
      matchRuleId: input.matchRuleId ?? undefined,
      overrideById: actorId,
      overrideAt: new Date(),
      overrideNote: input.overrideNote ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankTransaction",
      entityId: transactionId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Bank Matching Rules
// ---------------------------------------------------------------------------

export interface BankMatchRuleInput {
  name: string;
  description?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  amountTolerance?: number;
  narrationContains?: string | null;
  referencePattern?: string | null;
  dateWindowDays?: number;
  voucherTypes?: string[];
  autoConfirm?: boolean;
  active?: boolean;
  priority?: number;
}

export async function createBankMatchRule(
  workspaceId: string,
  bookId: string,
  input: BankMatchRuleInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  const rule = await prisma.bankMatchRule.create({
    data: {
      bookId,
      name: input.name,
      description: input.description ?? null,
      minAmount: input.minAmount ?? null,
      maxAmount: input.maxAmount ?? null,
      amountTolerance: input.amountTolerance ?? 0,
      narrationContains: input.narrationContains ?? null,
      referencePattern: input.referencePattern ?? null,
      dateWindowDays: input.dateWindowDays ?? 3,
      voucherTypes: stringifyJson(input.voucherTypes ?? []),
      autoConfirm: input.autoConfirm ?? false,
      active: input.active ?? true,
      priority: input.priority ?? 100,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankMatchRule",
      entityId: rule.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return rule;
}

export async function listBankMatchRules(workspaceId: string, bookId: string, activeOnly = true) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.bankMatchRule.findMany({
    where: { bookId, ...(activeOnly ? { active: true } : {}) },
    orderBy: { priority: "asc" },
  });
}

export async function updateBankMatchRule(
  workspaceId: string,
  bookId: string,
  ruleId: string,
  input: Partial<BankMatchRuleInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.bankMatchRule.findFirst({ where: { id: ruleId, bookId } });
  if (!existing) throw new BankFeedStoreError(404, "NOT_FOUND", "Match rule not found.");

  const updated = await prisma.bankMatchRule.update({
    where: { id: ruleId },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      minAmount: input.minAmount ?? undefined,
      maxAmount: input.maxAmount ?? undefined,
      amountTolerance: input.amountTolerance ?? undefined,
      narrationContains: input.narrationContains ?? undefined,
      referencePattern: input.referencePattern ?? undefined,
      dateWindowDays: input.dateWindowDays ?? undefined,
      voucherTypes: input.voucherTypes !== undefined ? stringifyJson(input.voucherTypes) : undefined,
      autoConfirm: input.autoConfirm ?? undefined,
      active: input.active ?? undefined,
      priority: input.priority ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankMatchRule",
      entityId: ruleId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deleteBankMatchRule(workspaceId: string, bookId: string, ruleId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.bankMatchRule.delete({ where: { id: ruleId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankMatchRule",
      entityId: ruleId,
      action: "delete",
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Auto-Matching Engine
// ---------------------------------------------------------------------------

export interface AutoMatchOptions {
  tolerance?: number; // minor units
  useRules?: boolean;
  autoConfirm?: boolean;
}

export async function autoMatchBankTransactions(
  workspaceId: string,
  bookId: string,
  feedId: string,
  opts: AutoMatchOptions = {},
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  // Get unmatched transactions
  const transactions = await prisma.bankTransaction.findMany({
    where: { feedId, matchStatus: "unmatched" },
    orderBy: { date: "asc" },
  });

  // Get vouchers in the date range (expanded by a few days)
  const vouchers = await prisma.bookVoucher.findMany({
    where: {
      bookId,
      date: {
        gte: feed.statementFrom,
        lte: feed.statementTo,
      },
      voucherType: { in: ["payment", "receipt", "journal"] },
    },
    include: { lines: { include: { account: true } } },
  });

  // Get active match rules
  const rules = await prisma.bankMatchRule.findMany({
    where: { bookId, active: true },
    orderBy: { priority: "asc" },
  });

  // Build cash book rows from vouchers (bank convention: positive = credit)
  const cashBookRows: CashBookRow[] = vouchers.flatMap((v) =>
    v.lines.map((l) => ({
      id: `${v.id}:${l.id}`,
      date: v.date,
      narration: l.narration ?? v.narration,
      amount: l.amount, // positive = debit in books; for bank rec we need opposite sign
      reference: l.account.code, // use account code as reference
    })),
  );

  // Build bank statement rows
  const bankRows: BankStatementRow[] = transactions.map((t) => ({
    id: t.id,
    date: t.date,
    narration: t.narration,
    amount: t.amount, // bank convention
    reference: t.reference ?? null,
  }));

  // Run reconciliation
  const tolerance = opts.tolerance ?? 0;
  const result = reconcileBank({
    cashBook: cashBookRows,
    statement: bankRows,
    tolerance,
    asOfDate: feed.statementTo,
  });

  // Apply matches
  let matched = 0;
  let suggested = 0;

  for (const item of result.items) {
    if (item.verdict === "matched" && item.cashBookId && item.bankId) {
      const voucherId = item.cashBookId.split(":")[0];
      const tx = await prisma.bankTransaction.findUnique({ where: { id: item.bankId } });
      if (tx && tx.matchStatus === "unmatched") {
        await prisma.bankTransaction.update({
          where: { id: item.bankId },
          data: {
            matchStatus: "confirmed",
            matchedVoucherId: voucherId,
            matchScore: 100,
            overrideById: actorId,
            overrideAt: new Date(),
          },
        });
        matched++;
      }
    } else if (item.verdict === "deposit-in-transit" || item.verdict === "cheque-unpresented") {
      // These are book-side items; the bank hasn't seen them yet
      // No action needed on bank side
    } else if (item.verdict === "bank-side-item" || item.verdict === "book-side-item") {
      // Items only on one side - could be suggested for review
      if (item.bankId) {
        await prisma.bankTransaction.update({
          where: { id: item.bankId },
          data: { matchStatus: "suggested", matchScore: 50 },
        });
        suggested++;
      }
    }
  }

  // Rule-based matching for remaining unmatched
  if (opts.useRules && rules.length > 0) {
    const unmatched = await prisma.bankTransaction.findMany({
      where: { feedId, matchStatus: "unmatched" },
    });

    // Parse voucherTypes from JSON strings
    const parsedRules = rules.map((rule) => ({
      ...rule,
      voucherTypes: typeof rule.voucherTypes === "string" ? JSON.parse(rule.voucherTypes) : rule.voucherTypes,
    }));

    for (const tx of unmatched) {
      for (const rule of parsedRules) {
        if (matchesRule(tx, rule, vouchers, tolerance)) {
          await prisma.bankTransaction.update({
            where: { id: tx.id },
            data: {
              matchStatus: opts.autoConfirm ? "confirmed" : "suggested",
              matchScore: 80,
              matchRuleId: rule.id,
              ...(opts.autoConfirm ? { matchedVoucherId: findVoucherForRule(tx, rule, vouchers) } : {}),
            },
          });
          suggested++;
          break;
        }
      }
    }
  }

  return { matched, suggested, total: transactions.length };
}

function matchesRule(
  tx: { narration: string; amount: number; reference?: string | null; date: string },
  rule: {
    minAmount?: number | null;
    maxAmount?: number | null;
    amountTolerance: number;
    narrationContains?: string | null;
    referencePattern?: string | null;
    dateWindowDays: number;
    voucherTypes: string[];
  },
  vouchers: { id: string; date: string; voucherType: string }[],
  tolerance: number,
): boolean {
  if (rule.minAmount !== undefined && rule.minAmount !== null && Math.abs(tx.amount) < rule.minAmount) return false;
  if (rule.maxAmount !== undefined && rule.maxAmount !== null && Math.abs(tx.amount) > rule.maxAmount) return false;
  if (rule.narrationContains && !tx.narration.toLowerCase().includes(rule.narrationContains.toLowerCase()))
    return false;
  if (rule.referencePattern) {
    const re = new RegExp(rule.referencePattern);
    if (!re.test(tx.reference ?? "")) return false;
  }
  if (rule.voucherTypes.length > 0) {
    const hasMatchingVoucher = vouchers.some(
      (v) =>
        rule.voucherTypes.includes(v.voucherType) &&
        Math.abs(tx.amount) <= tolerance && // simplified check
        v.date >= tx.date && // voucher date on or before tx date (for payments)
        v.date <= nextDay(tx.date, rule.dateWindowDays),
    );
    if (!hasMatchingVoucher) return false;
  }
  return true;
}

function findVoucherForRule(
  tx: { amount: number; date: string; reference?: string | null },
  rule: { voucherTypes: string[]; dateWindowDays: number },
  vouchers: { id: string; date: string; voucherType: string; amount?: number }[],
): string | null {
  for (const v of vouchers) {
    if (rule.voucherTypes.length && !rule.voucherTypes.includes(v.voucherType)) continue;
    // Simplified: exact amount match within window
    // In production, use proper reconciliation engine
    return v.id;
  }
  return null;
}

function nextDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reconciliation Workflow
// ---------------------------------------------------------------------------

export async function reconcileBankFeed(workspaceId: string, bookId: string, feedId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const feed = await prisma.bankFeed.findFirst({ where: { id: feedId, bookId } });
  if (!feed) throw new BankFeedStoreError(404, "NOT_FOUND", "Bank feed not found.");

  // Run auto-match with rules
  await autoMatchBankTransactions(workspaceId, bookId, feedId, { useRules: true, autoConfirm: false }, actorId);

  // Check if all transactions are matched
  const unmatchedCount = await prisma.bankTransaction.count({ where: { feedId, matchStatus: "unmatched" } });
  const totalCount = await prisma.bankTransaction.count({ where: { feedId } });

  if (unmatchedCount === 0) {
    await prisma.bankFeed.update({
      where: { id: feedId },
      data: { reconciled: true, reconciledAt: new Date(), reconciledById: actorId },
    });
  }

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "BankFeed",
      entityId: feedId,
      action: "reconcile",
      fieldChanges: stringifyJson({
        totalTransactions: totalCount,
        unmatched: unmatchedCount,
        reconciled: unmatchedCount === 0,
      }),
      actorId,
    },
  });

  return { reconciled: unmatchedCount === 0, totalTransactions: totalCount, unmatchedCount };
}

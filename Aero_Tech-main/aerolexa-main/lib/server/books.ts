/**
 * Books repository — persistence for the CA books workspace (Phase B).
 *
 * The arithmetic lives in `lib/engine/accounting.ts` and the row→ledger seam in
 * `lib/engine/books.ts`; this module owns the database: create a set of books,
 * seed the Schedule III chart of accounts, post vouchers (after the engine has
 * proved they balance) and assemble the statements from stored rows.
 *
 * Every query is workspace-scoped. A book id is never trusted on its own — it
 * must belong to the caller's workspace — because a CA firm's whole reason for
 * using this is that one client's ledger is not visible to another.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { AccountingError } from "@/lib/engine/accounting";
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  balanceSheet,
  cashFlow,
  incomeStatement,
  trialBalance,
  validateEntry,
  type Account,
  type AccountType,
  type JournalEntry,
} from "@/lib/engine/accounting";
import {
  OPENING_ENTRY_ID,
  accountLedger,
  assembleLedger,
  dayBook,
  type BookAccountRow,
  type BookVoucherRow,
} from "@/lib/engine/books";
import { appendAuditEntry } from "@/lib/server/audit-chain";
import { assertIsoDate, assertJournalLines, assertMinorUnits } from "@/lib/server/finance-validation";
import { assertPeriodOpen } from "@/lib/server/period-locks";
import { voucherTotals } from "@/lib/server/voucher-fields";

/** An `ApiError` so route handlers render the right status and code. */
export class BooksStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "BooksStoreError";
  }
}

export interface BookInput {
  name: string;
  /** Active organization that will own the book (null = personal book). */
  organizationId?: string | null;
  legalName?: string | null;
  gstin?: string | null;
  pan?: string | null;
  entityType?: string;
  booksFrom?: string | null;
  fiscalYearEnd?: string;
}

/** Create a set of books and seed it with the default Schedule III chart. */
export async function createBook(workspaceId: string, input: BookInput) {
  const name = input.name?.trim();
  if (!name) throw new BooksStoreError(400, "VALIDATION", "Book name is required.");
  return prisma.book.create({
    data: {
      workspaceId,
      organizationId: input.organizationId ?? null,
      name,
      legalName: input.legalName ?? null,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      entityType: input.entityType ?? "company",
      booksFrom: input.booksFrom ?? null,
      fiscalYearEnd: input.fiscalYearEnd ?? "03-31",
      accounts: {
        create: DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({
          code: a.code,
          name: a.name,
          type: a.type,
          category: a.category,
          description: a.description ?? null,
        })),
      },
    },
    include: { accounts: true },
  });
}

export async function listBooks(workspaceId: string, organizationId?: string | null) {
  return prisma.book.findMany({
    where: {
      workspaceId,
      ...(organizationId ? { OR: [{ organizationId: null }, { organizationId }] } : { organizationId: null }),
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Load a book, asserting workspace and (when supplied) organization scope. */
export async function requireBook(workspaceId: string, bookId: string, organizationId?: string | null) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId } });
  if (!book) throw new BooksStoreError(404, "NOT_FOUND", "Book not found.");
  if (organizationId && book.organizationId && book.organizationId !== organizationId) {
    throw new BooksStoreError(403, "FORBIDDEN", "This book belongs to a different organization.");
  }
  return book;
}

export async function addAccount(
  workspaceId: string,
  bookId: string,
  input: {
    code: string;
    name: string;
    type: AccountType;
    category: string;
    description?: string | null;
    openingBalance?: number;
  },
) {
  await requireBook(workspaceId, bookId);
  const code = input.code?.trim();
  const name = input.name?.trim();
  if (!code || !name) throw new BooksStoreError(400, "VALIDATION", "Account code and name are required.");
  const existing = await prisma.bookAccount.findFirst({ where: { bookId, code } });
  if (existing) throw new BooksStoreError(409, "DUPLICATE", `Account code ${code} already exists in this book.`);
  const openingBalance = input.openingBalance ?? 0;
  assertMinorUnits(openingBalance, "openingBalance");
  return prisma.bookAccount.create({
    data: {
      bookId,
      code,
      name,
      type: input.type,
      category: input.category,
      description: input.description ?? null,
      openingBalance,
    },
  });
}

export interface VoucherInput {
  number: string;
  date: string;
  narration: string;
  reference?: string | null;
  voucherType?: string;
  lines: { accountCode: string; amount: number; narration?: string | null }[];
}

/**
 * Post a voucher. The entry is validated by `accounting.ts` FIRST — an
 * unbalanced or unknown-account entry is rejected before anything is written,
 * so the database can never hold a voucher the engine would refuse.
 */
export interface VoucherPostOptions {
  /** Register row this voucher recognises. The unique key makes posting idempotent. */
  sourceType?: "gst-invoice" | "inventory-movement" | "fixed-asset" | "tds-entry" | "payroll-run";
  sourceId?: string;
  postedById?: string;
}

export async function postVoucher(
  workspaceId: string,
  bookId: string,
  input: VoucherInput,
  options: VoucherPostOptions = {},
) {
  await requireBook(workspaceId, bookId);
  if (!input || typeof input !== "object") throw new BooksStoreError(400, "VALIDATION", "A voucher body is required.");
  if (typeof input.number !== "string" || !input.number.trim()) {
    throw new BooksStoreError(400, "VALIDATION", "Voucher number is required.");
  }
  if (typeof input.narration !== "string" || !input.narration.trim()) {
    throw new BooksStoreError(400, "VALIDATION", "Voucher narration is required.");
  }
  assertIsoDate(input.date, "Voucher date");
  assertJournalLines(input.lines);

  const accounts = await prisma.bookAccount.findMany({ where: { bookId } });
  if (accounts.length === 0) throw new BooksStoreError(400, "NO_ACCOUNTS", "This book has no chart of accounts.");
  const byCode = new Map(accounts.map((a) => [a.code, a] as const));

  const engineAccounts: Account[] = accounts.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    category: a.category,
    description: a.description ?? undefined,
  }));
  const entry: JournalEntry = {
    id: input.number,
    date: input.date,
    narration: input.narration,
    reference: input.reference ?? undefined,
    lines: input.lines.map((l) => {
      if (!byCode.has(l.accountCode))
        throw new BooksStoreError(400, "UNKNOWN_ACCOUNT", `Account ${l.accountCode} does not exist in this book.`);
      return { accountCode: l.accountCode, amount: l.amount, narration: l.narration ?? undefined };
    }),
  };
  try {
    validateEntry(entry, engineAccounts);
  } catch (err) {
    if (err instanceof AccountingError) throw new BooksStoreError(400, "UNBALANCED_ENTRY", err.message);
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    await assertPeriodOpen(bookId, input.date, tx);

    // A register row posts exactly once. A retried HTTP request returns the
    // original voucher instead of failing on the voucher-number unique index.
    if (options.sourceType && options.sourceId) {
      const existing = await tx.subledgerPosting.findUnique({
        where: {
          bookId_sourceType_sourceId: {
            bookId,
            sourceType: options.sourceType,
            sourceId: options.sourceId,
          },
        },
        include: { voucher: { include: { lines: true } } },
      });
      if (existing) return existing.voucher;
    }

    const duplicate = await tx.bookVoucher.findFirst({ where: { bookId, number: input.number } });
    if (duplicate) throw new BooksStoreError(409, "DUPLICATE", `Voucher ${input.number} already exists.`);

    const totals = voucherTotals(entry.lines);
    // Enforce balance: totalDebit must equal totalCredit
    if (totals.totalDebit !== totals.totalCredit) {
      throw new BooksStoreError(
        400,
        "UNBALANCED",
        "Voucher lines must balance: totalDebit (= " +
          totals.totalDebit +
          ") must equal totalCredit (= " +
          totals.totalCredit +
          ").",
      );
    }
    const created = await tx.bookVoucher.create({
      data: {
        bookId,
        number: input.number,
        date: input.date,
        narration: input.narration,
        reference: input.reference ?? null,
        voucherType: input.voucherType ?? "journal",
        status: "posted",
        postedAt: new Date(),
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: {
          create: entry.lines.map((l) => ({
            accountId: byCode.get(l.accountCode)!.id,
            amount: l.amount,
            narration: l.narration ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    if (options.sourceType && options.sourceId) {
      await tx.subledgerPosting.create({
        data: {
          bookId,
          sourceType: options.sourceType,
          sourceId: options.sourceId,
          voucherId: created.id,
          postedById: options.postedById ?? null,
        },
      });
    }

    await appendAuditEntry(tx, {
      bookId,
      entityType: "BookVoucher",
      entityId: created.id,
      action: "post",
      actorId: options.postedById ?? "system",
      after: JSON.stringify({ number: created.number, date: created.date, totals }),
    });

    return created;
  });
}

/** Load all rows for a book and assemble the engine ledger. */
async function loadLedger(workspaceId: string, bookId: string, range: { from?: string; to?: string } = {}) {
  const book = await requireBook(workspaceId, bookId);
  const dateFilter =
    range.from || range.to
      ? { date: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
      : {};
  const [accounts, vouchers] = await Promise.all([
    prisma.bookAccount.findMany({ where: { bookId } }),
    prisma.bookVoucher.findMany({
      where: { bookId, ...dateFilter },
      include: { lines: true },
      orderBy: { date: "asc" },
    }),
  ]);
  const accountRows: BookAccountRow[] = accounts.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    category: a.category,
    description: a.description,
    openingBalance: a.openingBalance,
  }));
  const byId = new Map(accounts.map((a) => [a.id, a.code] as const));
  const voucherRows: BookVoucherRow[] = vouchers.map((v) => ({
    id: v.number,
    date: v.date,
    narration: v.narration,
    reference: v.reference,
    lines: v.lines.map((l) => ({ accountCode: byId.get(l.accountId) ?? "", amount: l.amount, narration: l.narration })),
  }));
  return { book, accounts, ledger: assembleLedger(accountRows, voucherRows), voucherRows };
}

/** The financial statements for a range, all derived from the stored journal. */
export async function getStatements(workspaceId: string, bookId: string, range: { from?: string; to?: string } = {}) {
  const { ledger } = await loadLedger(workspaceId, bookId);
  return {
    trialBalance: trialBalance(ledger, range),
    incomeStatement: incomeStatement(ledger, range),
    balanceSheet: balanceSheet(ledger, range),
    cashFlow: cashFlow(ledger, range),
  };
}

export async function getDayBook(workspaceId: string, bookId: string, range: { from?: string; to?: string } = {}) {
  // Push the range into the query: a day-book request must not materialise
  // every voucher a client has ever posted.
  const { voucherRows } = await loadLedger(workspaceId, bookId, range);
  return dayBook(voucherRows, range);
}

export async function getAccountLedger(
  workspaceId: string,
  bookId: string,
  accountCode: string,
  range: { from?: string; to?: string } = {},
) {
  const { ledger } = await loadLedger(workspaceId, bookId);
  return accountLedger(ledger, accountCode, range);
}

export async function getBookSnapshot(workspaceId: string, bookId: string) {
  // The snapshot only needs accounts; loading the entire voucher journal here
  // made opening a book O(all postings).
  const book = await requireBook(workspaceId, bookId);
  const accounts = await prisma.bookAccount.findMany({ where: { bookId }, orderBy: { code: "asc" } });
  return {
    book,
    accounts: accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      category: a.category,
      openingBalance: a.openingBalance,
    })),
    openingEntryId: OPENING_ENTRY_ID,
  };
}

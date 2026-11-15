/**
 * Books READ tools.
 *
 * These wrap the existing books store and engines. No ledger arithmetic is
 * re-implemented here: `getStatements`, `getDayBook` and `getAccountLedger`
 * already own it. This layer only scopes, caps, formats and redacts.
 */

import { z } from "zod";

import { assertFy, assertIsoDate, clip, decodeCursor, encodeCursor, money, resolveWindow } from "@/lib/ai/format";
import { scrubText } from "@/lib/ai/redact";
import { objectSchema } from "@/lib/ai/tools/schema";
import type { AssistantContext, ToolData, ToolDefinition } from "@/lib/ai/tools/types";
import { prisma } from "@/lib/db";
import { getAccountLedger, getBookSnapshot, getDayBook, getStatements } from "@/lib/server/books";

function requireBookId(ctx: AssistantContext): string {
  if (!ctx.bookId) throw new Error("No book is attached to this run.");
  return ctx.bookId;
}

const dateString = (label: string) =>
  z
    .string()
    .min(10)
    .max(10)
    .refine((v) => {
      try {
        assertIsoDate(v, label);
        return true;
      } catch {
        return false;
      }
    }, `${label} must be a real YYYY-MM-DD date`);

const fyString = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((v) => {
    try {
      assertFy(v);
      return true;
    } catch {
      return false;
    }
  }, 'fy must look like "2025-26"');

/* -------------------------------------------------------------------------- */
/* 1. Financial statements                                                     */
/* -------------------------------------------------------------------------- */

const statementsSchema = objectSchema({
  statement: z
    .enum(["trial_balance", "profit_and_loss", "balance_sheet", "cash_flow", "all"])
    .describe("Which statement(s) to return. Use 'all' only when the user asks for an overall summary."),
  fy: fyString.optional().describe('Indian financial year "2025-26" (April–March). Omit to use the current FY.'),
  from: dateString("from").optional().describe("Period start, YYYY-MM-DD. Overrides the FY start when supplied."),
  to: dateString("to").optional().describe("Period end / balance-sheet as-of date, YYYY-MM-DD."),
});

export const financialStatements: ToolDefinition<z.infer<typeof statementsSchema>> = {
  name: "financial_statements",
  module: "books",
  tier: "READ",
  requiresBook: true,
  description:
    "Trial balance, profit & loss, balance sheet or cash flow for ONE book, in integer paise with Indian-formatted display strings. " +
    "Use for questions about totals, profit, assets/liabilities or whether the books balance. " +
    "Do NOT use for individual vouchers (use search_vouchers/voucher_detail) or for GST/TDS registers. " +
    "Calling it once with statement='all' is cheaper than several calls.",
  schema: statementsSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    const window = resolveWindow({ fy: input.fy, from: input.from, to: input.to, now: ctx.now?.() });
    const statements = await getStatements(ctx.auth.workspace.id, bookId, { from: window.from, to: window.to });
    const tb = statements.trialBalance;
    const pl = statements.incomeStatement;
    const bs = statements.balanceSheet;
    const cf = statements.cashFlow;

    const line = (l: {
      key: string;
      label: string;
      amount: number;
      children?: { key: string; label: string; amount: number }[];
    }) => ({
      key: l.key,
      label: l.label,
      amount: money(l.amount),
      children: (l.children ?? []).slice(0, 40).map((c) => ({ code: c.key, label: c.label, amount: money(c.amount) })),
    });

    const trialBalance = {
      rows: tb.rows.slice(0, 100).map((r) => ({
        code: r.code,
        name: r.name,
        type: r.type,
        debit: money(r.debit),
        credit: money(r.credit),
      })),
      rowCount: tb.rows.length,
      truncated: tb.rows.length > 100,
      totalDebit: money(tb.totalDebit),
      totalCredit: money(tb.totalCredit),
      balanced: tb.balanced,
      difference: money(tb.difference),
    };

    const profitAndLoss = {
      income: pl.income.slice(0, 40).map(line),
      expenses: pl.expenses.slice(0, 40).map(line),
      totalIncome: money(pl.totalIncome),
      totalExpenses: money(pl.totalExpenses),
      netProfit: money(pl.netProfit),
    };

    const balanceSheet = {
      assets: bs.assets.slice(0, 40).map(line),
      liabilities: bs.liabilities.slice(0, 40).map(line),
      equity: bs.equity.slice(0, 40).map(line),
      totalAssets: money(bs.totalAssets),
      totalLiabilities: money(bs.totalLiabilities),
      totalEquity: money(bs.totalEquity),
      imbalance: money(bs.imbalance),
    };

    const cashFlow = {
      operating: money(cf.operating),
      investing: money(cf.investing),
      financing: money(cf.financing),
      netChange: money(cf.netChange),
      openingCash: money(cf.openingCash),
      closingCash: money(cf.closingCash),
      reconciled: cf.reconciled,
    };

    const want = input.statement;
    const data: ToolData = {
      bookId,
      period: { from: window.from, to: window.to, source: window.source },
      ...(want === "all" || want === "trial_balance" ? { trialBalance } : {}),
      ...(want === "all" || want === "profit_and_loss" ? { profitAndLoss } : {}),
      ...(want === "all" || want === "balance_sheet" ? { balanceSheet } : {}),
      ...(want === "all" || want === "cash_flow" ? { cashFlow } : {}),
      note:
        window.source === "current_fy_default"
          ? "No period was supplied; the current Indian financial year was used. State this assumption to the user."
          : undefined,
    };
    return data;
  },
};

/* -------------------------------------------------------------------------- */
/* 2. Day book                                                                 */
/* -------------------------------------------------------------------------- */

const dayBookSchema = objectSchema({
  from: dateString("from").describe("First date in the range, YYYY-MM-DD."),
  to: dateString("to").describe("Last date in the range, YYYY-MM-DD."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows to return (max 50, default 25)."),
  cursor: z.string().max(200).optional().describe("Opaque nextCursor from a previous page."),
});

export const dayBook: ToolDefinition<z.infer<typeof dayBookSchema>> = {
  name: "day_book",
  module: "books",
  tier: "READ",
  requiresBook: true,
  description:
    "Voucher totals (debit/credit) for a date range, newest first, capped. " +
    "Use to see what was posted on a day or across a short period. " +
    "It returns voucher headers only — use voucher_detail for the lines of one voucher. " +
    "Do NOT use for a whole year; choose a narrow range instead.",
  schema: dayBookSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    if (input.from > input.to) throw new Error("from must be on or before to");
    const rows = await getDayBook(ctx.auth.workspace.id, bookId, { from: input.from, to: input.to });
    const offset = decodeCursor(input.cursor);
    const limit = input.limit ?? 25;
    const page = rows.slice(offset, offset + limit);
    const numbers = page.map((r) => r.id);
    const dbRows = numbers.length
      ? await prisma.bookVoucher.findMany({
          where: { bookId, number: { in: numbers } },
          select: { id: true, number: true, voucherType: true, status: true },
        })
      : [];
    const byNumber = new Map(dbRows.map((v) => [v.number, v] as const));
    const data = page.map((r) => ({
      voucherId: byNumber.get(r.id)?.id ?? null,
      voucherNumber: r.id,
      date: r.date,
      narration: scrubText(clip(r.narration, 160)),
      reference: scrubbed(r.reference),
      voucherType: byNumber.get(r.id)?.voucherType ?? null,
      status: byNumber.get(r.id)?.status ?? null,
      debit: money(r.debit),
      credit: money(r.credit),
    }));
    const nextCursor = offset + limit < rows.length ? encodeCursor(offset + limit) : undefined;
    return {
      bookId,
      rows: data,
      rowCount: data.length,
      total: rows.length,
      truncated: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

function scrubbed(value: string | null | undefined): string | null {
  return scrubText(clip(value, 120));
}

/* -------------------------------------------------------------------------- */
/* 3. Voucher search                                                           */
/* -------------------------------------------------------------------------- */

const voucherSearchSchema = objectSchema({
  query: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe("Text to match against narration, voucher number or reference."),
  from: dateString("from").optional().describe("Earliest voucher date, YYYY-MM-DD."),
  to: dateString("to").optional().describe("Latest voucher date, YYYY-MM-DD."),
  voucherType: z
    .enum(["journal", "payment", "receipt", "sales", "purchase", "contra", "credit-note", "debit-note"])
    .optional()
    .describe("Restrict to one voucher type."),
  status: z.enum(["posted", "unposted", "draft"]).optional().describe("Restrict to one posting status."),
  minAmountPaise: z.number().int().nonnegative().optional().describe("Minimum voucher total, integer paise."),
  maxAmountPaise: z.number().int().nonnegative().optional().describe("Maximum voucher total, integer paise."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows to return (max 50, default 20)."),
  cursor: z.string().max(200).optional().describe("Opaque nextCursor from a previous page."),
});

export const searchVouchers: ToolDefinition<z.infer<typeof voucherSearchSchema>> = {
  name: "search_vouchers",
  module: "books",
  tier: "READ",
  requiresBook: true,
  description:
    "Search voucher headers in ONE book by text, date range, type, status or amount. " +
    "Use to locate a voucher before calling voucher_detail. " +
    "At least one filter is required; this is not a full-ledger export. " +
    "Do NOT use for account balances (use financial_statements or ledger_account_statement).",
  schema: voucherSearchSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    if (
      !input.query &&
      !input.from &&
      !input.to &&
      !input.voucherType &&
      !input.status &&
      input.minAmountPaise === undefined &&
      input.maxAmountPaise === undefined
    ) {
      throw new Error("Supply at least one filter (query, date range, type, status or amount).");
    }
    if (input.from && input.to && input.from > input.to) throw new Error("from must be on or before to");
    if (
      input.minAmountPaise !== undefined &&
      input.maxAmountPaise !== undefined &&
      input.minAmountPaise > input.maxAmountPaise
    ) {
      throw new Error("minAmountPaise cannot exceed maxAmountPaise.");
    }
    const where: Record<string, unknown> = { bookId };
    if (input.from || input.to) {
      where.date = { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) };
    }
    if (input.voucherType) where.voucherType = input.voucherType;
    if (input.status) where.status = input.status;
    if (input.minAmountPaise !== undefined)
      where.totalDebit = { ...(where.totalDebit as object), gte: input.minAmountPaise };
    if (input.maxAmountPaise !== undefined)
      where.totalDebit = { ...(where.totalDebit as object), lte: input.maxAmountPaise };
    if (input.query) {
      where.OR = [
        { narration: { contains: input.query } },
        { number: { contains: input.query } },
        { reference: { contains: input.query } },
      ];
    }

    const offset = decodeCursor(input.cursor);
    const limit = input.limit ?? 20;
    const [rows, total] = await Promise.all([
      prisma.bookVoucher.findMany({
        where,
        orderBy: [{ date: "desc" }, { number: "desc" }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          number: true,
          date: true,
          narration: true,
          reference: true,
          voucherType: true,
          status: true,
          totalDebit: true,
          totalCredit: true,
        },
      }),
      prisma.bookVoucher.count({ where }),
    ]);
    const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : undefined;
    return {
      bookId,
      rows: rows.map((v) => ({
        voucherId: v.id,
        number: v.number,
        date: v.date,
        narration: scrubText(clip(v.narration, 160)),
        reference: scrubbed(v.reference),
        voucherType: v.voucherType,
        status: v.status,
        totalDebit: money(v.totalDebit ?? 0),
        totalCredit: money(v.totalCredit ?? 0),
      })),
      rowCount: rows.length,
      total,
      truncated: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 4. Voucher detail                                                           */
/* -------------------------------------------------------------------------- */

const voucherDetailSchema = objectSchema({
  voucherId: z.string().min(1).max(64).describe("Stable voucher id returned by search_vouchers or day_book."),
});

export const voucherDetail: ToolDefinition<z.infer<typeof voucherDetailSchema>> = {
  name: "voucher_detail",
  module: "books",
  tier: "READ",
  requiresBook: true,
  description:
    "Full header and journal lines for ONE voucher id, including account codes and signed paise amounts. " +
    "Use only after search_vouchers/day_book has returned a voucherId. " +
    "It cannot fetch a voucher from another book and will not accept a voucher number in place of the id.",
  schema: voucherDetailSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    const voucher = await prisma.bookVoucher.findFirst({
      where: { id: input.voucherId, bookId },
      include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
    });
    if (!voucher) {
      throw new Error("Voucher not found in the selected book. Re-run search_vouchers to get a valid voucherId.");
    }
    const lines = voucher.lines.slice(0, 100).map((l) => ({
      accountCode: l.account.code,
      accountName: l.account.name,
      accountType: l.account.type,
      // Signed paise, positive = debit. The engine owns this convention.
      amountPaise: l.amount,
      amountInr: money(l.amount).inr,
      narration: scrubText(clip(l.narration, 120)),
    }));
    return {
      bookId,
      voucher: {
        voucherId: voucher.id,
        number: voucher.number,
        date: voucher.date,
        narration: scrubText(clip(voucher.narration, 300)),
        reference: scrubbed(voucher.reference),
        voucherType: voucher.voucherType,
        status: voucher.status,
        postedAt: voucher.postedAt?.toISOString() ?? null,
        totalDebit: money(voucher.totalDebit ?? 0),
        totalCredit: money(voucher.totalCredit ?? 0),
      },
      lines,
      lineCount: voucher.lines.length,
      truncated: voucher.lines.length > 100,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 5. Ledger account statement                                                 */
/* -------------------------------------------------------------------------- */

const ledgerSchema = objectSchema({
  accountCode: z.string().min(1).max(24).describe("Chart-of-accounts code, e.g. '1000'."),
  from: dateString("from").optional().describe("Statement start, YYYY-MM-DD. Omit to start at the opening balance."),
  to: dateString("to").optional().describe("Statement end, YYYY-MM-DD."),
  limit: z.number().int().min(1).max(100).optional().describe("Postings to return (max 100, default 50)."),
  cursor: z.string().max(200).optional().describe("Opaque nextCursor from a previous page."),
});

export const ledgerAccountStatement: ToolDefinition<z.infer<typeof ledgerSchema>> = {
  name: "ledger_account_statement",
  module: "books",
  tier: "READ",
  requiresBook: true,
  description:
    "Postings and running balance for ONE ledger account, with the opening balance carried forward. " +
    "Use for 'what is in account X', party balances, or explaining a movement. " +
    "Do NOT use to list many accounts; trial_balance is the right tool for that.",
  schema: ledgerSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    if (input.from && input.to && input.from > input.to) throw new Error("from must be on or before to");
    const snapshot = await getBookSnapshot(ctx.auth.workspace.id, bookId);
    const account = snapshot.accounts.find((a) => a.code === input.accountCode);
    if (!account) {
      throw new Error(
        `Account code "${input.accountCode}" does not exist in this book. Use trial_balance to list valid codes.`,
      );
    }
    const all = await getAccountLedger(ctx.auth.workspace.id, bookId, input.accountCode, {
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    });
    const offset = decodeCursor(input.cursor);
    const limit = input.limit ?? 50;
    const page: typeof all = all.slice(offset, offset + limit);
    const nextCursor = offset + limit < all.length ? encodeCursor(offset + limit) : undefined;
    const totalDebit = all.reduce((s, r) => s + r.debit, 0);
    const totalCredit = all.reduce((s, r) => s + r.credit, 0);
    return {
      bookId,
      account: {
        code: account.code,
        name: account.name,
        type: account.type,
        openingBalance: money(account.openingBalance),
      },
      period: { from: input.from ?? null, to: input.to ?? null },
      rows: page.map((r) => ({
        voucherNumber: r.voucherId,
        date: r.date,
        narration: scrubText(clip(r.narration, 160)),
        debit: money(r.debit),
        credit: money(r.credit),
        balance: money(r.balance),
      })),
      rowCount: page.length,
      total: all.length,
      truncated: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
      totals: {
        debit: money(totalDebit),
        credit: money(totalCredit),
        closingBalance: all.length ? money(all[all.length - 1]!.balance) : money(account.openingBalance),
      },
    };
  },
};

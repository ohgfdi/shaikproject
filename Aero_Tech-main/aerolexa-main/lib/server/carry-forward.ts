/**
 * Carry Forward — opening balance transfer from prior financial year.
 * Transfers account balances from one FY to the next as the opening entry.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { accountBalances } from "@/lib/engine/accounting";
import { assembleLedger, type BookAccountRow, type BookVoucherRow } from "@/lib/engine/books";
import { stringifyJson } from "@/lib/json";

export class CarryForwardStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "CarryForwardStoreError";
  }
}

export interface CarryForwardInput {
  fromFy: string; // "2024-25"
  toFy: string; // "2025-26"
  transferDate: string; // ISO yyyy-mm-dd
}

export interface CarryForwardLineInput {
  accountId: string;
  balance: number; // minor units, signed (debit normal = positive)
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new CarryForwardStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

function fyEndDate(fy: string): string {
  // FY format: "2024-25" -> end date is March 31 of the second year
  const endYear = Number(fy.slice(5, 7)) + 2000;
  return `${endYear}-03-31`;
}

export async function createCarryForward(
  workspaceId: string,
  bookId: string,
  input: CarryForwardInput,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  // Check if carry forward already exists
  const existing = await prisma.carryForward.findUnique({
    where: { bookId_fromFy_toFy: { bookId, fromFy: input.fromFy, toFy: input.toFy } },
  });
  if (existing)
    throw new CarryForwardStoreError(
      409,
      "DUPLICATE",
      `Carry forward from ${input.fromFy} to ${input.toFy} already exists.`,
    );

  const carry = await prisma.carryForward.create({
    data: {
      bookId,
      fromFy: input.fromFy,
      toFy: input.toFy,
      transferDate: input.transferDate,
      status: "draft",
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CarryForward",
      entityId: carry.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return carry;
}

export async function listCarryForwards(workspaceId: string, bookId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.carryForward.findMany({
    where: { bookId },
    orderBy: { fromFy: "desc" },
  });
}

export async function getCarryForward(workspaceId: string, bookId: string, carryId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const carry = await prisma.carryForward.findFirst({
    where: { id: carryId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!carry) throw new CarryForwardStoreError(404, "NOT_FOUND", "Carry forward not found.");
  return carry;
}

export async function computeCarryForwardBalances(workspaceId: string, bookId: string, fromFy: string, toFy: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId } });
  if (!book) throw new CarryForwardStoreError(404, "NOT_FOUND", "Book not found.");

  const fyEnd = fyEndDate(fromFy);

  // Get all accounts with opening balances
  const accounts = await prisma.bookAccount.findMany({ where: { bookId } });

  // Get all vouchers up to FY end
  const vouchers = await prisma.bookVoucher.findMany({
    where: { bookId, date: { lte: fyEnd } },
    include: { lines: true },
    orderBy: { date: "asc" },
  });

  // Build ledger
  const accountRows: BookAccountRow[] = accounts.map((a) => ({
    code: a.code,
    name: a.name,
    type: a.type as BookAccountRow["type"],
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

  const ledger = assembleLedger(accountRows, voucherRows);

  // Compute closing balances using the accounting engine
  const accountBalancesResult = accountBalances(ledger, { to: fyEnd });

  const balances: { accountId: string; accountCode: string; balance: number }[] = [];

  for (const acc of accounts) {
    const balanceInfo = accountBalancesResult.find((b) => b.account.code === acc.code);
    let balance = acc.openingBalance;
    if (balanceInfo) {
      balance += balanceInfo.balance;
    }
    balances.push({ accountId: acc.id, accountCode: acc.code, balance });
  }

  return {
    fromFy,
    toFy,
    fyEndDate: fyEnd,
    balances,
    totalDebits: balances.filter((b) => b.balance > 0).reduce((s, b) => s + b.balance, 0),
    totalCredits: Math.abs(balances.filter((b) => b.balance < 0).reduce((s, b) => s + b.balance, 0)),
    balanced: balances.reduce((s, b) => s + b.balance, 0) === 0,
  };
}

export async function validateCarryForward(workspaceId: string, bookId: string, carryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const carry = await prisma.carryForward.findFirst({
    where: { id: carryId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!carry) throw new CarryForwardStoreError(404, "NOT_FOUND", "Carry forward not found.");

  // Compute expected balances
  const computed = await computeCarryForwardBalances(workspaceId, bookId, carry.fromFy, carry.toFy);

  // Compare with stored lines
  const mismatches: string[] = [];
  for (const line of carry.lines) {
    const computedBalance = computed.balances.find((b) => b.accountId === line.accountId)?.balance ?? 0;
    if (line.balance !== computedBalance) {
      mismatches.push(
        `Account ${line.account.code}: stored ${line.balance}, computed ${computedBalance}, diff ${computedBalance - line.balance}`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new CarryForwardStoreError(400, "VALIDATION", `Carry forward validation failed: ${mismatches.join("; ")}`);
  }

  // Update lines with verified flag
  await prisma.carryForward.update({
    where: { id: carryId },
    data: {
      lines: {
        updateMany: { where: { carryId: carryId }, data: { verified: true } },
      },
      validatedById: actorId,
      validatedAt: new Date(),
      status: "validated",
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CarryForward",
      entityId: carry.id,
      action: "validate",
      fieldChanges: stringifyJson({ validated: true, balanced: true }),
      actorId,
    },
  });

  return { validated: true, balanced: true };
}

export async function postCarryForward(workspaceId: string, bookId: string, carryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const carry = await prisma.carryForward.findFirst({
    where: { id: carryId, bookId },
    include: { lines: { include: { account: true } } },
  });
  if (!carry) throw new CarryForwardStoreError(404, "NOT_FOUND", "Carry forward not found.");
  if (carry.status !== "validated")
    throw new CarryForwardStoreError(400, "INVALID_STATE", "Carry forward must be validated before posting.");

  // Create opening entry voucher for the new FY
  const voucherNumber = `OP-${carry.toFy}-001`;
  const existingVoucher = await prisma.bookVoucher.findUnique({
    where: { bookId_number: { bookId, number: voucherNumber } },
  });
  if (existingVoucher)
    throw new CarryForwardStoreError(409, "DUPLICATE", `Opening voucher ${voucherNumber} already exists.`);

  // Create opening voucher with carry forward lines
  await prisma.bookVoucher.create({
    data: {
      bookId,
      number: voucherNumber,
      date: carry.transferDate,
      narration: `Opening balances brought forward from ${carry.fromFy}`,
      reference: `CF:${carry.fromFy}->${carry.toFy}`,
      voucherType: "journal",
      lines: {
        create: carry.lines.map((l) => ({
          accountId: l.accountId,
          amount: l.balance,
          narration: `B/F from ${carry.fromFy}`,
        })),
      },
    },
  });

  await prisma.carryForward.update({
    where: { id: carryId },
    data: { status: "posted", postedById: actorId, postedAt: new Date() },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CarryForward",
      entityId: carry.id,
      action: "post",
      fieldChanges: stringifyJson({ status: { old: "validated", new: "posted" }, voucherNumber }),
      actorId,
    },
  });

  return { posted: true, voucherNumber };
}

export async function deleteCarryForward(workspaceId: string, bookId: string, carryId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const carry = await prisma.carryForward.findFirst({ where: { id: carryId, bookId } });
  if (!carry) throw new CarryForwardStoreError(404, "NOT_FOUND", "Carry forward not found.");
  if (carry.status === "posted")
    throw new CarryForwardStoreError(
      400,
      "INVALID_STATE",
      "Cannot delete a posted carry forward; create a new one instead.",
    );

  await prisma.carryForward.delete({ where: { id: carryId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CarryForward",
      entityId: carryId,
      action: "delete",
      actorId,
    },
  });
}

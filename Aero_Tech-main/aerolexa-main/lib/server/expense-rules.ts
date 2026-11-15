/**
 * Expense Classification Rules — maps narration/party/account to expense heads
 * with tax treatment and ITC eligibility.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export class ExpenseRuleStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "ExpenseRuleStoreError";
  }
}

export interface ExpenseRuleInput {
  name: string;
  description?: string | null;
  accountCodePattern?: string | null;
  narrationPattern?: string | null;
  partyGstinPattern?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  voucherTypes?: string[];
  expenseHead: string;
  taxTreatment?: string | null;
  gstRate?: number | null;
  itcEligibility?: string | null;
  active?: boolean;
  priority?: number;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new ExpenseRuleStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createExpenseRule(workspaceId: string, bookId: string, input: ExpenseRuleInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  if (!input.name?.trim()) throw new ExpenseRuleStoreError(400, "VALIDATION", "Rule name is required.");
  if (!input.expenseHead?.trim())
    throw new ExpenseRuleStoreError(400, "VALIDATION", "Expense head (target account) is required.");

  const rule = await prisma.expenseRule.create({
    data: {
      bookId,
      name: input.name,
      description: input.description ?? null,
      accountCodePattern: input.accountCodePattern ?? null,
      narrationPattern: input.narrationPattern ?? null,
      partyGstinPattern: input.partyGstinPattern ?? null,
      amountMin: input.amountMin ?? null,
      amountMax: input.amountMax ?? null,
      voucherTypes: stringifyJson(input.voucherTypes ?? []),
      expenseHead: input.expenseHead,
      taxTreatment: input.taxTreatment ?? null,
      gstRate: input.gstRate ?? null,
      itcEligibility: input.itcEligibility ?? null,
      active: input.active ?? true,
      priority: input.priority ?? 100,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ExpenseRule",
      entityId: rule.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return rule;
}

export async function listExpenseRules(workspaceId: string, bookId: string, activeOnly = true) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.expenseRule.findMany({
    where: { bookId, ...(activeOnly ? { active: true } : {}) },
    orderBy: { priority: "asc" },
  });
}

export async function getExpenseRule(workspaceId: string, bookId: string, ruleId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const rule = await prisma.expenseRule.findFirst({ where: { id: ruleId, bookId } });
  if (!rule) throw new ExpenseRuleStoreError(404, "NOT_FOUND", "Expense rule not found.");
  return rule;
}

export async function updateExpenseRule(
  workspaceId: string,
  bookId: string,
  ruleId: string,
  input: Partial<ExpenseRuleInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.expenseRule.findFirst({ where: { id: ruleId, bookId } });
  if (!existing) throw new ExpenseRuleStoreError(404, "NOT_FOUND", "Expense rule not found.");

  const updated = await prisma.expenseRule.update({
    where: { id: ruleId },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      accountCodePattern: input.accountCodePattern ?? undefined,
      narrationPattern: input.narrationPattern ?? undefined,
      partyGstinPattern: input.partyGstinPattern ?? undefined,
      amountMin: input.amountMin ?? undefined,
      amountMax: input.amountMax ?? undefined,
      voucherTypes: input.voucherTypes !== undefined ? stringifyJson(input.voucherTypes) : undefined,
      expenseHead: input.expenseHead ?? undefined,
      taxTreatment: input.taxTreatment ?? undefined,
      gstRate: input.gstRate ?? undefined,
      itcEligibility: input.itcEligibility ?? undefined,
      active: input.active ?? undefined,
      priority: input.priority ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ExpenseRule",
      entityId: ruleId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deleteExpenseRule(workspaceId: string, bookId: string, ruleId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.expenseRule.delete({ where: { id: ruleId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "ExpenseRule",
      entityId: ruleId,
      action: "delete",
      actorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Classification Engine
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  expenseHead: string;
  taxTreatment: string | null;
  gstRate: number | null;
  itcEligibility: string | null;
  matchedRuleId: string | null;
  confidence: number; // 0-100
}

/**
 * Classify a voucher line against active expense rules.
 * Returns the highest-priority matching rule, or null if no match.
 */
export async function classifyVoucherLine(
  workspaceId: string,
  bookId: string,
  line: {
    accountCode: string;
    narration?: string | null;
    amount: number;
    partyGstin?: string | null;
    voucherType?: string | null;
  },
): Promise<ClassificationResult | null> {
  await requireBookAccess({ workspaceId }, bookId);

  const rules = await prisma.expenseRule.findMany({
    where: { bookId, active: true },
    orderBy: { priority: "asc" },
  });

  for (const rule of rules) {
    // Parse voucherTypes from JSON string
    const voucherTypes =
      typeof rule.voucherTypes === "string" ? JSON.parse(rule.voucherTypes) : (rule.voucherTypes ?? []);
    let score = 0;
    let matches = true;

    // Account code pattern
    if (rule.accountCodePattern) {
      const re = new RegExp(rule.accountCodePattern);
      if (!re.test(line.accountCode)) {
        matches = false;
      } else {
        score += 30;
      }
    }

    // Narration pattern
    if (rule.narrationPattern && line.narration) {
      if (!line.narration.toLowerCase().includes(rule.narrationPattern.toLowerCase())) {
        matches = false;
      } else {
        score += 25;
      }
    }

    // Party GSTIN pattern
    if (rule.partyGstinPattern && line.partyGstin) {
      const re = new RegExp(rule.partyGstinPattern);
      if (!re.test(line.partyGstin)) {
        matches = false;
      } else {
        score += 20;
      }
    }

    // Amount range
    if (rule.amountMin !== undefined && rule.amountMin !== null && Math.abs(line.amount) < rule.amountMin) {
      matches = false;
    }
    if (rule.amountMax !== undefined && rule.amountMax !== null && Math.abs(line.amount) > rule.amountMax) {
      matches = false;
    }
    if (matches && (rule.amountMin !== null || rule.amountMax !== null)) score += 15;

    // Voucher type
    if (voucherTypes.length > 0 && line.voucherType) {
      if (!voucherTypes.includes(line.voucherType)) {
        matches = false;
      } else {
        score += 10;
      }
    }

    if (matches) {
      return {
        expenseHead: rule.expenseHead,
        taxTreatment: rule.taxTreatment,
        gstRate: rule.gstRate,
        itcEligibility: rule.itcEligibility,
        matchedRuleId: rule.id,
        confidence: Math.min(score, 100),
      };
    }
  }

  return null;
}

/**
 * Bulk classify all lines of a voucher.
 */
export async function classifyVoucher(
  workspaceId: string,
  bookId: string,
  lines: Array<{
    accountCode: string;
    narration?: string | null;
    amount: number;
    partyGstin?: string | null;
    voucherType?: string | null;
    lineId: string;
  }>,
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();
  for (const line of lines) {
    const result = await classifyVoucherLine(workspaceId, bookId, line);
    if (result) results.set(line.lineId, result);
  }
  return results;
}

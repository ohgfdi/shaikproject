/**
 * Chart of Accounts Mapping — maps external software codes (Tally, Zoho,
 * QuickBooks, Busy, Marginal, etc.) to internal account codes.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export class CoaMappingStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "CoaMappingStoreError";
  }
}

export interface CoaMappingInput {
  externalSoftware: string; // tally | zoho | quickbooks | busy | marginal | custom
  externalCode: string;
  externalName?: string | null;
  internalCode: string;
  internalName?: string | null;
  accountType?: string | null; // asset | liability | equity | income | expense
  category?: string | null;
  gstTreatment?: string | null; // taxable | exempt | nil | export
  active?: boolean;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new CoaMappingStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createCoaMapping(workspaceId: string, bookId: string, input: CoaMappingInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  // Verify internal account exists
  const internalAccount = await prisma.bookAccount.findFirst({ where: { bookId, code: input.internalCode } });
  if (!internalAccount)
    throw new CoaMappingStoreError(400, "VALIDATION", `Internal account ${input.internalCode} does not exist.`);

  const existing = await prisma.coaMapping.findUnique({
    where: {
      bookId_externalSoftware_externalCode: {
        bookId,
        externalSoftware: input.externalSoftware,
        externalCode: input.externalCode,
      },
    },
  });
  if (existing)
    throw new CoaMappingStoreError(
      409,
      "DUPLICATE",
      `Mapping for ${input.externalSoftware}:${input.externalCode} already exists.`,
    );

  const mapping = await prisma.coaMapping.create({
    data: {
      bookId,
      externalSoftware: input.externalSoftware,
      externalCode: input.externalCode,
      externalName: input.externalName ?? null,
      internalCode: input.internalCode,
      internalName: input.internalName ?? null,
      accountType: input.accountType ?? null,
      category: input.category ?? null,
      gstTreatment: input.gstTreatment ?? null,
      active: true,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CoaMapping",
      entityId: mapping.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return mapping;
}

export async function listCoaMappings(
  workspaceId: string,
  bookId: string,
  opts: { externalSoftware?: string; active?: boolean } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  return prisma.coaMapping.findMany({
    where: {
      bookId,
      ...(opts.externalSoftware ? { externalSoftware: opts.externalSoftware } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
    },
    orderBy: { externalSoftware: "asc" },
  });
}

export async function getCoaMapping(workspaceId: string, bookId: string, mappingId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const mapping = await prisma.coaMapping.findFirst({ where: { id: mappingId, bookId } });
  if (!mapping) throw new CoaMappingStoreError(404, "NOT_FOUND", "COA mapping not found.");
  return mapping;
}

export async function updateCoaMapping(
  workspaceId: string,
  bookId: string,
  mappingId: string,
  input: Partial<CoaMappingInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.coaMapping.findFirst({ where: { id: mappingId, bookId } });
  if (!existing) throw new CoaMappingStoreError(404, "NOT_FOUND", "COA mapping not found.");

  // Verify internal account if changed
  if (input.internalCode) {
    const internalAccount = await prisma.bookAccount.findFirst({ where: { bookId, code: input.internalCode } });
    if (!internalAccount)
      throw new CoaMappingStoreError(400, "VALIDATION", `Internal account ${input.internalCode} does not exist.`);
  }

  const updated = await prisma.coaMapping.update({
    where: { id: mappingId },
    data: {
      externalSoftware: input.externalSoftware ?? undefined,
      externalCode: input.externalCode ?? undefined,
      externalName: input.externalName ?? undefined,
      internalCode: input.internalCode ?? undefined,
      internalName: input.internalName ?? undefined,
      accountType: input.accountType ?? undefined,
      category: input.category ?? undefined,
      gstTreatment: input.gstTreatment ?? undefined,
      active: input.active ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CoaMapping",
      entityId: mappingId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function deleteCoaMapping(workspaceId: string, bookId: string, mappingId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  await prisma.coaMapping.delete({ where: { id: mappingId, bookId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CoaMapping",
      entityId: mappingId,
      action: "delete",
      actorId,
    },
  });
}

export async function bulkCreateCoaMappings(
  workspaceId: string,
  bookId: string,
  mappings: CoaMappingInput[],
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);

  // Verify all internal accounts exist
  const internalCodes = [...new Set(mappings.map((m) => m.internalCode))];
  const accounts = await prisma.bookAccount.findMany({
    where: { bookId, code: { in: internalCodes } },
  });
  const foundCodes = new Set(accounts.map((a) => a.code));
  const missingCodes = internalCodes.filter((c) => !foundCodes.has(c));
  if (missingCodes.length > 0) {
    throw new CoaMappingStoreError(400, "VALIDATION", `Internal accounts not found: ${missingCodes.join(", ")}`);
  }

  // Check for duplicates in input
  const seen = new Set<string>();
  for (const m of mappings) {
    const key = `${m.externalSoftware}:${m.externalCode}`;
    if (seen.has(key)) {
      throw new CoaMappingStoreError(400, "VALIDATION", `Duplicate mapping in input: ${key}`);
    }
    seen.add(key);
  }

  // Check for existing duplicates in DB
  for (const m of mappings) {
    const existing = await prisma.coaMapping.findUnique({
      where: {
        bookId_externalSoftware_externalCode: {
          bookId,
          externalSoftware: m.externalSoftware,
          externalCode: m.externalCode,
        },
      },
    });
    if (existing) {
      throw new CoaMappingStoreError(
        409,
        "DUPLICATE",
        `Mapping ${m.externalSoftware}:${m.externalCode} already exists.`,
      );
    }
  }

  const created = await prisma.coaMapping.createMany({
    data: mappings.map((m) => ({
      bookId,
      externalSoftware: m.externalSoftware,
      externalCode: m.externalCode,
      externalName: m.externalName ?? null,
      internalCode: m.internalCode,
      internalName: m.internalName ?? null,
      accountType: m.accountType ?? null,
      category: m.category ?? null,
      gstTreatment: m.gstTreatment ?? null,
      active: true,
      createdById: actorId,
    })),
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "CoaMapping",
      entityId: "bulk",
      action: "bulk_create",
      fieldChanges: stringifyJson({ count: created.count }),
      actorId,
    },
  });

  return created;
}

/**
 * Transform a voucher from external software format to internal format using COA mappings.
 */
export async function transformVoucherFromExternal(
  workspaceId: string,
  bookId: string,
  externalSoftware: string,
  voucher: {
    number: string;
    date: string;
    narration: string;
    reference?: string | null;
    voucherType?: string;
    lines: { externalCode: string; amount: number; narration?: string | null }[];
  },
) {
  await requireBookAccess({ workspaceId }, bookId);

  const mappings = await prisma.coaMapping.findMany({
    where: { bookId, externalSoftware, active: true },
  });

  const mappingMap = new Map(mappings.map((m) => [m.externalCode, m.internalCode]));

  const transformedLines = voucher.lines.map((l) => {
    const internalCode = mappingMap.get(l.externalCode);
    if (!internalCode) {
      throw new CoaMappingStoreError(
        400,
        "UNMAPPED_ACCOUNT",
        `External account ${l.externalCode} not mapped to internal code.`,
      );
    }
    return { accountCode: internalCode, amount: l.amount, narration: l.narration ?? null };
  });

  return {
    ...voucher,
    lines: transformedLines,
    voucherType: voucher.voucherType ?? "journal",
  };
}

/**
 * Export internal chart of accounts in external software format.
 */
export async function exportChartOfAccountsToExternal(workspaceId: string, bookId: string, externalSoftware: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const mappings = await prisma.coaMapping.findMany({
    where: { bookId, externalSoftware, active: true },
    include: { book: { include: { accounts: true } } },
  });

  // Build export rows
  const accounts = await prisma.bookAccount.findMany({ where: { bookId } });

  const rows = accounts.map((a) => {
    const mapping = mappings.find((m) => m.internalCode === a.code);
    return {
      internalCode: a.code,
      internalName: a.name,
      externalCode: mapping?.externalCode ?? "",
      externalName: mapping?.externalName ?? a.name,
      accountType: a.type,
      category: a.category,
      openingBalance: a.openingBalance,
    };
  });

  return { externalSoftware, rows };
}

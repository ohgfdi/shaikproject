/**
 * TDS Entries — tax deducted at source with challan tracking and quarterly filing.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";

export class TdsStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "TdsStoreError";
  }
}

export interface TdsEntryInput {
  challanNumber: string;
  bsrCode: string;
  challanDate: string;
  challanAmount: number;
  deductorTan: string;
  deductorName: string;
  deductorGstin?: string | null;
  deducteePan: string;
  deducteeName: string;
  deducteeGstin?: string | null;
  deducteeType: string; // company | firm | individual | huf | other
  section: string; // 192 | 194A | 194C | 194H | 194I | 194J | 194Q | etc.
  natureOfPayment: string;
  grossAmount: number;
  tdsAmount: number;
  surcharge?: number;
  cess?: number;
  quarter: string; // Q1 | Q2 | Q3 | Q4
  fy: string; // "2025-26"
  voucherId?: string | null;
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new TdsStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createTdsEntry(workspaceId: string, bookId: string, input: TdsEntryInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const totalTax = (input.tdsAmount ?? 0) + (input.surcharge ?? 0) + (input.cess ?? 0);

  const entry = await prisma.tdsEntry.create({
    data: {
      bookId,
      challanNumber: input.challanNumber,
      bsrCode: input.bsrCode,
      challanDate: input.challanDate,
      challanAmount: Math.round(input.challanAmount),
      deductorTan: input.deductorTan,
      deductorName: input.deductorName,
      deductorGstin: input.deductorGstin ?? null,
      deducteePan: input.deducteePan,
      deducteeName: input.deducteeName,
      deducteeGstin: input.deducteeGstin ?? null,
      deducteeType: input.deducteeType,
      section: input.section,
      natureOfPayment: input.natureOfPayment,
      grossAmount: Math.round(input.grossAmount),
      tdsAmount: Math.round(input.tdsAmount),
      surcharge: Math.round(input.surcharge ?? 0),
      cess: Math.round(input.cess ?? 0),
      totalTax: Math.round(totalTax),
      quarter: input.quarter,
      fy: input.fy,
      status: "deducted",
      voucherId: input.voucherId ?? null,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "TdsEntry",
      entityId: entry.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    },
  });

  return entry;
}

export async function listTdsEntries(
  workspaceId: string,
  bookId: string,
  opts: {
    fy?: string;
    quarter?: string;
    section?: string;
    status?: string;
    deducteePan?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.fy) where.fy = opts.fy;
  if (opts.quarter) where.quarter = opts.quarter;
  if (opts.section) where.section = opts.section;
  if (opts.status) where.status = opts.status;
  if (opts.deducteePan) where.deducteePan = { contains: opts.deducteePan, mode: "insensitive" };

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [entries, total] = await Promise.all([
    prisma.tdsEntry.findMany({
      where,
      orderBy: [{ fy: "desc" }, { quarter: "desc" }, { createdAt: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.tdsEntry.count({ where }),
  ]);

  return { entries, total, limit, offset };
}

export async function getTdsEntry(workspaceId: string, bookId: string, entryId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const entry = await prisma.tdsEntry.findFirst({ where: { id: entryId, bookId } });
  if (!entry) throw new TdsStoreError(404, "NOT_FOUND", "TDS entry not found.");
  return entry;
}

export async function updateTdsEntry(
  workspaceId: string,
  bookId: string,
  entryId: string,
  input: Partial<TdsEntryInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.tdsEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new TdsStoreError(404, "NOT_FOUND", "TDS entry not found.");
  if (existing.status === "filed")
    throw new TdsStoreError(400, "INVALID_STATE", "Cannot update a filed TDS entry; create a correction instead.");

  const totalTax =
    (input.tdsAmount ?? existing.tdsAmount) + (input.surcharge ?? existing.surcharge) + (input.cess ?? existing.cess);

  const updated = await prisma.tdsEntry.update({
    where: { id: entryId },
    data: {
      challanNumber: input.challanNumber ?? undefined,
      bsrCode: input.bsrCode ?? undefined,
      challanDate: input.challanDate ?? undefined,
      challanAmount: input.challanAmount !== undefined ? Math.round(input.challanAmount) : undefined,
      deductorTan: input.deductorTan ?? undefined,
      deductorName: input.deductorName ?? undefined,
      deductorGstin: input.deductorGstin ?? undefined,
      deducteePan: input.deducteePan ?? undefined,
      deducteeName: input.deducteeName ?? undefined,
      deducteeGstin: input.deducteeGstin ?? undefined,
      deducteeType: input.deducteeType ?? undefined,
      section: input.section ?? undefined,
      natureOfPayment: input.natureOfPayment ?? undefined,
      grossAmount: input.grossAmount !== undefined ? Math.round(input.grossAmount) : undefined,
      tdsAmount: input.tdsAmount !== undefined ? Math.round(input.tdsAmount) : undefined,
      surcharge: input.surcharge !== undefined ? Math.round(input.surcharge) : undefined,
      cess: input.cess !== undefined ? Math.round(input.cess) : undefined,
      totalTax: Math.round(totalTax),
      quarter: input.quarter ?? undefined,
      fy: input.fy ?? undefined,
      voucherId: input.voucherId ?? undefined,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "TdsEntry",
      entityId: entryId,
      action: "update",
      fieldChanges: stringifyJson(input),
      actorId,
    },
  });

  return updated;
}

export async function markTdsDeposited(
  workspaceId: string,
  bookId: string,
  entryId: string,
  depositedAt: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.tdsEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new TdsStoreError(404, "NOT_FOUND", "TDS entry not found.");

  const updated = await prisma.tdsEntry.update({
    where: { id: entryId },
    data: { status: "deposited", depositedAt: new Date(depositedAt) },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "TdsEntry",
      entityId: entryId,
      action: "deposit",
      fieldChanges: stringifyJson({ depositedAt }),
      actorId,
    },
  });

  return updated;
}

export async function markTdsFiled(
  workspaceId: string,
  bookId: string,
  entryId: string,
  form26Q_27Q: string,
  filedAt: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.tdsEntry.findFirst({ where: { id: entryId, bookId } });
  if (!existing) throw new TdsStoreError(404, "NOT_FOUND", "TDS entry not found.");

  const updated = await prisma.tdsEntry.update({
    where: { id: entryId },
    data: { status: "filed", filedAt: new Date(filedAt), form26Q_27Q },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "TdsEntry",
      entityId: entryId,
      action: "file",
      fieldChanges: stringifyJson({ form26Q_27Q, filedAt }),
      actorId,
    },
  });

  return updated;
}

export async function createTdsCorrection(
  workspaceId: string,
  bookId: string,
  originalEntryId: string,
  input: Partial<TdsEntryInput>,
  correctionReason: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const original = await prisma.tdsEntry.findFirst({ where: { id: originalEntryId, bookId } });
  if (!original) throw new TdsStoreError(404, "NOT_FOUND", "Original TDS entry not found.");

  const correction = await prisma.tdsEntry.create({
    data: {
      bookId,
      challanNumber: input.challanNumber ?? original.challanNumber,
      bsrCode: input.bsrCode ?? original.bsrCode,
      challanDate: input.challanDate ?? original.challanDate,
      challanAmount: input.challanAmount !== undefined ? Math.round(input.challanAmount) : original.challanAmount,
      deductorTan: input.deductorTan ?? original.deductorTan,
      deductorName: input.deductorName ?? original.deductorName,
      deductorGstin: input.deductorGstin ?? original.deductorGstin,
      deducteePan: input.deducteePan ?? original.deducteePan,
      deducteeName: input.deducteeName ?? original.deducteeName,
      deducteeGstin: input.deducteeGstin ?? original.deducteeGstin,
      deducteeType: input.deducteeType ?? original.deducteeType,
      section: input.section ?? original.section,
      natureOfPayment: input.natureOfPayment ?? original.natureOfPayment,
      grossAmount: input.grossAmount !== undefined ? Math.round(input.grossAmount) : original.grossAmount,
      tdsAmount: input.tdsAmount !== undefined ? Math.round(input.tdsAmount) : original.tdsAmount,
      surcharge: input.surcharge !== undefined ? Math.round(input.surcharge) : original.surcharge,
      cess: input.cess !== undefined ? Math.round(input.cess) : original.cess,
      totalTax:
        (input.tdsAmount ?? original.tdsAmount) +
        (input.surcharge ?? original.surcharge) +
        (input.cess ?? original.cess),
      quarter: input.quarter ?? original.quarter,
      fy: input.fy ?? original.fy,
      status: "corrected",
      originalEntryId,
      correctionReason,
      createdById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "TdsEntry",
      entityId: correction.id,
      action: "correct",
      fieldChanges: stringifyJson({ originalEntryId, correctionReason, changes: input }),
      actorId,
    },
  });

  return correction;
}

export async function getTdsQuarterlySummary(workspaceId: string, bookId: string, fy: string, quarter: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const entries = await prisma.tdsEntry.findMany({
    where: { bookId, fy, quarter },
    orderBy: { section: "asc" },
  });

  const bySection = new Map<
    string,
    {
      entries: typeof entries;
      totalGross: number;
      totalTds: number;
      totalSurcharge: number;
      totalCess: number;
      totalTax: number;
    }
  >();

  for (const e of entries) {
    const sec = e.section;
    const agg = bySection.get(sec) ?? {
      entries: [],
      totalGross: 0,
      totalTds: 0,
      totalSurcharge: 0,
      totalCess: 0,
      totalTax: 0,
    };
    agg.entries.push(e);
    agg.totalGross += e.grossAmount;
    agg.totalTds += e.tdsAmount;
    agg.totalSurcharge += e.surcharge;
    agg.totalCess += e.cess;
    agg.totalTax += e.totalTax;
    bySection.set(sec, agg);
  }

  return {
    fy,
    quarter,
    sections: Array.from(bySection.entries()).map(([section, agg]) => ({
      section,
      count: agg.entries.length,
      totalGross: agg.totalGross,
      totalTds: agg.totalTds,
      totalSurcharge: agg.totalSurcharge,
      totalCess: agg.totalCess,
      totalTax: agg.totalTax,
      entries: agg.entries,
    })),
    grandTotal: {
      totalGross: entries.reduce((s, e) => s + e.grossAmount, 0),
      totalTds: entries.reduce((s, e) => s + e.tdsAmount, 0),
      totalSurcharge: entries.reduce((s, e) => s + e.surcharge, 0),
      totalCess: entries.reduce((s, e) => s + e.cess, 0),
      totalTax: entries.reduce((s, e) => s + e.totalTax, 0),
    },
  };
}

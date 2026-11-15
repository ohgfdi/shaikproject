/**
 * GST Invoice Register — persistent outward/inward supply ledger with ITC
 * matching against 2A/2B over time. Supports GSTR-1/3B computation and reconciliation.
 */

import { ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { appendAuditEntry } from "@/lib/server/audit-chain";
import { assertIsoDate, assertMinorUnits } from "@/lib/server/finance-validation";

export class GstInvoiceStoreError extends ApiError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "GstInvoiceStoreError";
  }
}

export interface GstInvoiceInput {
  invoiceNumber: string;
  invoiceDate: string;
  invoiceType: string; // b2b | b2c | export | sezwop | deemed | credit-note | debit-note
  supplyType: string; // intra | inter
  placeOfSupply: string;
  supplierGstin?: string | null;
  supplierName?: string | null;
  recipientGstin?: string | null;
  recipientName?: string | null;
  recipientState?: string | null;
  taxableValue: number; // minor units
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  itcEligibility?: string; // eligible | ineligible | blocked | reversed | partial
  itcHeading?: string | null;
  rcm?: boolean;
  irn?: string | null;
  irnDate?: string | null;
  ackNumber?: string | null;
  ackDate?: string | null;
  source?: string; // manual | tally | gst-portal | gsp | api
  status?: string; // draft | validated | posted | cancelled | amended
  period: string; // yyyy-mm
  reference?: string | null;
}

export interface GstInvoiceListOptions {
  from?: string;
  to?: string;
  period?: string;
  invoiceType?: string;
  status?: string;
  matched2a2b?: boolean;
  supplierGstin?: string;
  recipientGstin?: string;
  itcEligibility?: string;
  limit?: number;
  offset?: number;
}

function validateInvoice(input: GstInvoiceInput): void {
  if (!input.invoiceNumber?.trim()) throw new GstInvoiceStoreError(400, "VALIDATION", "Invoice number is required.");
  if (!input.invoiceDate) throw new GstInvoiceStoreError(400, "VALIDATION", "Invoice date is required.");
  if (!input.invoiceType) throw new GstInvoiceStoreError(400, "VALIDATION", "Invoice type is required.");
  if (!input.supplyType) throw new GstInvoiceStoreError(400, "VALIDATION", "Supply type is required.");
  if (!input.placeOfSupply) throw new GstInvoiceStoreError(400, "VALIDATION", "Place of supply is required.");
  if (!input.period) throw new GstInvoiceStoreError(400, "VALIDATION", "Period (yyyy-mm) is required.");
  if (!Number.isFinite(input.taxableValue))
    throw new GstInvoiceStoreError(400, "VALIDATION", "Taxable value must be a number.");
}

export async function requireBookAccess(ctx: { workspaceId: string }, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, workspaceId: ctx.workspaceId } });
  if (!book) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Book not found in this workspace.");
  return book;
}

export async function createGstInvoice(workspaceId: string, bookId: string, input: GstInvoiceInput, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  validateInvoice(input);
  assertIsoDate(input.invoiceDate, "Invoice date");
  assertMinorUnits(input.taxableValue, "taxableValue");
  assertMinorUnits(input.cgstAmount, "cgstAmount");
  assertMinorUnits(input.sgstAmount, "sgstAmount");
  assertMinorUnits(input.igstAmount, "igstAmount");
  assertMinorUnits(input.cessAmount, "cessAmount");

  return prisma.$transaction(async (tx) => {
    // The unique index is the real guard; checking + creating in one
    // transaction turns a race into an honest 409.
    const existing = await tx.gstInvoice.findUnique({
      where: { bookId_invoiceNumber: { bookId, invoiceNumber: input.invoiceNumber } },
    });
    if (existing) {
      throw new GstInvoiceStoreError(409, "DUPLICATE", `Invoice ${input.invoiceNumber} already exists.`);
    }

    const invoice = await tx.gstInvoice.create({
      data: {
        bookId,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        invoiceType: input.invoiceType,
        supplyType: input.supplyType,
        placeOfSupply: input.placeOfSupply,
        supplierGstin: input.supplierGstin ?? null,
        supplierName: input.supplierName ?? null,
        recipientGstin: input.recipientGstin ?? null,
        recipientName: input.recipientName ?? null,
        recipientState: input.recipientState ?? null,
        taxableValue: input.taxableValue,
        cgstAmount: input.cgstAmount,
        sgstAmount: input.sgstAmount,
        igstAmount: input.igstAmount,
        cessAmount: input.cessAmount,
        itcEligibility: input.itcEligibility ?? "eligible",
        itcHeading: input.itcHeading ?? null,
        rcm: input.rcm ?? false,
        irn: input.irn ?? null,
        irnDate: input.irnDate ?? null,
        ackNumber: input.ackNumber ?? null,
        ackDate: input.ackDate ?? null,
        source: input.source ?? "manual",
        status: input.status ?? "draft",
        period: input.period,
        reference: input.reference ?? null,
        createdById: actorId,
      },
    });

    await appendAuditEntry(tx, {
      bookId,
      entityType: "GstInvoice",
      entityId: invoice.id,
      action: "create",
      fieldChanges: stringifyJson({ new: input }),
      actorId,
    });

    return invoice;
  });
}

export async function listGstInvoices(workspaceId: string, bookId: string, opts: GstInvoiceListOptions = {}) {
  await requireBookAccess({ workspaceId }, bookId);

  const where: Record<string, unknown> = { bookId };
  if (opts.from) where.invoiceDate = { ...(where.invoiceDate as object), gte: opts.from };
  if (opts.to) where.invoiceDate = { ...(where.invoiceDate as object), lte: opts.to };
  if (opts.period) where.period = opts.period;
  if (opts.invoiceType) where.invoiceType = opts.invoiceType;
  if (opts.status) where.status = opts.status;
  if (opts.matched2a2b !== undefined) where.matched2a2b = opts.matched2a2b;
  if (opts.supplierGstin) where.supplierGstin = { contains: opts.supplierGstin, mode: "insensitive" };
  if (opts.recipientGstin) where.recipientGstin = { contains: opts.recipientGstin, mode: "insensitive" };
  if (opts.itcEligibility) where.itcEligibility = opts.itcEligibility;

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [invoices, total] = await Promise.all([
    prisma.gstInvoice.findMany({
      where,
      orderBy: [{ invoiceDate: "desc" }, { invoiceNumber: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.gstInvoice.count({ where }),
  ]);

  return { invoices, total, limit, offset };
}

export async function getGstInvoice(workspaceId: string, bookId: string, invoiceId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const invoice = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!invoice) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Invoice not found.");
  return invoice;
}

export async function updateGstInvoice(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  input: Partial<GstInvoiceInput>,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!existing) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Invoice not found.");

  // Validate if key fields changed
  if (input.invoiceNumber && input.invoiceNumber !== existing.invoiceNumber) {
    const dup = await prisma.gstInvoice.findUnique({
      where: { bookId_invoiceNumber: { bookId, invoiceNumber: input.invoiceNumber } },
    });
    if (dup && dup.id !== invoiceId) {
      throw new GstInvoiceStoreError(409, "DUPLICATE", `Invoice ${input.invoiceNumber} already exists.`);
    }
  }

  if (input.invoiceDate !== undefined) assertIsoDate(input.invoiceDate, "Invoice date");
  for (const field of ["taxableValue", "cgstAmount", "sgstAmount", "igstAmount", "cessAmount"] as const) {
    const value = input[field];
    if (value !== undefined) assertMinorUnits(value, field);
  }

  return prisma.$transaction(async (tx) => {
    const before = { ...existing };
    const updated = await tx.gstInvoice.update({
      where: { id: invoiceId },
      data: {
        invoiceNumber: input.invoiceNumber ?? undefined,
        invoiceDate: input.invoiceDate ?? undefined,
        invoiceType: input.invoiceType ?? undefined,
        supplyType: input.supplyType ?? undefined,
        placeOfSupply: input.placeOfSupply ?? undefined,
        supplierGstin: input.supplierGstin ?? undefined,
        supplierName: input.supplierName ?? undefined,
        recipientGstin: input.recipientGstin ?? undefined,
        recipientName: input.recipientName ?? undefined,
        recipientState: input.recipientState ?? undefined,
        taxableValue: input.taxableValue ?? undefined,
        cgstAmount: input.cgstAmount ?? undefined,
        sgstAmount: input.sgstAmount ?? undefined,
        igstAmount: input.igstAmount ?? undefined,
        cessAmount: input.cessAmount ?? undefined,
        itcEligibility: input.itcEligibility ?? undefined,
        itcHeading: input.itcHeading ?? undefined,
        rcm: input.rcm ?? undefined,
        irn: input.irn ?? undefined,
        irnDate: input.irnDate ?? undefined,
        ackNumber: input.ackNumber ?? undefined,
        ackDate: input.ackDate ?? undefined,
        source: input.source ?? undefined,
        status: input.status ?? undefined,
        period: input.period ?? undefined,
        reference: input.reference ?? undefined,
        updatedById: actorId,
      },
    });

    // Audit trail
    const fieldChanges: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of Object.keys(input)) {
      const k = key as keyof typeof input;
      if ((before as Record<string, unknown>)[k] !== (input as Record<string, unknown>)[k]) {
        fieldChanges[k] = { old: (before as Record<string, unknown>)[k], new: (input as Record<string, unknown>)[k] };
      }
    }
    await appendAuditEntry(tx, {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "update",
      fieldChanges: stringifyJson(fieldChanges),
      before: stringifyJson(before),
      after: stringifyJson(updated),
      actorId,
    });

    return updated;
  });
}

export async function deleteGstInvoice(workspaceId: string, bookId: string, invoiceId: string, actorId: string) {
  await requireBookAccess({ workspaceId }, bookId);
  const existing = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!existing) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Invoice not found.");

  await prisma.gstInvoice.delete({ where: { id: invoiceId } });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "delete",
      before: stringifyJson(existing),
      actorId,
    },
  });
}

export async function matchGstInvoiceTo2a2b(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  gstr2aRef: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const invoice = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!invoice) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Invoice not found.");

  const updated = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      matched2a2b: true,
      matchedAt: new Date(),
      matchedById: actorId,
      gstr2aRef,
      mismatchReason: null,
      status: "validated",
      updatedById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "match",
      fieldChanges: stringifyJson({ matched2a2b: { old: false, new: true }, gstr2aRef: { old: null, new: gstr2aRef } }),
      actorId,
    },
  });

  return updated;
}

export async function unmatchGstInvoice(
  workspaceId: string,
  bookId: string,
  invoiceId: string,
  reason: string,
  actorId: string,
) {
  await requireBookAccess({ workspaceId }, bookId);
  const invoice = await prisma.gstInvoice.findFirst({ where: { id: invoiceId, bookId } });
  if (!invoice) throw new GstInvoiceStoreError(404, "NOT_FOUND", "Invoice not found.");

  const updated = await prisma.gstInvoice.update({
    where: { id: invoiceId },
    data: {
      matched2a2b: false,
      matchedAt: null,
      matchedById: null,
      gstr2aRef: null,
      mismatchReason: reason,
      status: "draft",
      updatedById: actorId,
    },
  });

  await prisma.bookAuditEntry.create({
    data: {
      bookId,
      entityType: "GstInvoice",
      entityId: invoiceId,
      action: "unmatch",
      fieldChanges: stringifyJson({
        matched2a2b: { old: true, new: false },
        mismatchReason: { old: null, new: reason },
      }),
      actorId,
    },
  });

  return updated;
}

export interface Gstr1SummaryInput {
  bookId: string;
  period: string; // yyyy-mm
}

export interface Gstr1SummaryResult {
  b2b: { inv: string; taxable: number; taxRate: number; place: string; eway: boolean }[];
  b2c: { inv: string; taxable: number; taxRate: number; place: string }[];
  export: { inv: string; taxable: number; taxRate: number }[];
  creditNotes: { inv: string; taxable: number; taxRate: number }[];
  debitNotes: { inv: string; taxable: number; taxRate: number }[];
  totalTaxable: number;
  totalTax: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalCess: number;
}

const _formatJson = stringifyJson;

export async function computeGstr1Summary(workspaceId: string, input: Gstr1SummaryInput): Promise<Gstr1SummaryResult> {
  await requireBookAccess({ workspaceId }, input.bookId);

  const invoices = await prisma.gstInvoice.findMany({
    where: { bookId: input.bookId, period: input.period, status: { in: ["validated", "posted"] } },
    orderBy: { invoiceDate: "asc" },
  });

  const b2b: Gstr1SummaryResult["b2b"] = [];
  const b2c: Gstr1SummaryResult["b2c"] = [];
  const exportInv: Gstr1SummaryResult["export"] = [];
  const creditNotes: Gstr1SummaryResult["creditNotes"] = [];
  const debitNotes: Gstr1SummaryResult["debitNotes"] = [];

  let totalTaxable = 0;
  let totalTax = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalCess = 0;

  for (const inv of invoices) {
    const taxable = inv.taxableValue;
    const rate =
      inv.taxableValue > 0
        ? Math.round(((inv.cgstAmount + inv.sgstAmount + inv.igstAmount) * 100) / inv.taxableValue)
        : 0;

    totalTaxable += taxable;
    totalCgst += inv.cgstAmount;
    totalSgst += inv.sgstAmount;
    totalIgst += inv.igstAmount;
    totalCess += inv.cessAmount;
    totalTax += inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.cessAmount;

    const baseRow = {
      inv: inv.invoiceNumber,
      taxable,
      taxRate: rate,
      place: inv.placeOfSupply,
    };

    switch (inv.invoiceType) {
      case "b2b":
        b2b.push({ ...baseRow, eway: false });
        break;
      case "b2c":
        b2c.push({ ...baseRow });
        break;
      case "export":
        exportInv.push({ inv: inv.invoiceNumber, taxable, taxRate: rate });
        break;
      case "credit-note":
        creditNotes.push({ inv: inv.invoiceNumber, taxable, taxRate: rate });
        break;
      case "debit-note":
        debitNotes.push({ inv: inv.invoiceNumber, taxable, taxRate: rate });
        break;
    }
  }

  return {
    b2b,
    b2c,
    export: exportInv,
    creditNotes,
    debitNotes,
    totalTaxable,
    totalTax,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
  };
}

export interface IctReconciliationInput {
  bookId: string;
  period: string; // yyyy-mm
  openingIct: number;
  availableIct2A2B: number;
  reverseCharge: number;
}

export interface IctReconciliationResult {
  openingIct: number;
  available2A2B: number;
  claimedIn3B: number;
  matched: number;
  unmatchedClaimed: number;
  unmatchedAvailable: number;
  capApplied: boolean;
  capNote: string;
  mismatches: string[];
  invoices: {
    total: number;
    matched: number;
    unmatched: number;
    byEligibility: Record<string, number>;
  };
}

export async function computeIctReconciliation(
  workspaceId: string,
  input: IctReconciliationInput,
): Promise<IctReconciliationResult> {
  await requireBookAccess({ workspaceId }, input.bookId);

  const invoices = await prisma.gstInvoice.findMany({
    where: { bookId: input.bookId, period: input.period, status: { in: ["validated", "posted"] } },
  });

  const iclInward = invoices.filter((i) => i.rcm).reduce((s, i) => s + i.cgstAmount + i.sgstAmount + i.igstAmount, 0);

  const icgInward = invoices
    .filter((i) => !i.rcm && i.itcEligibility === "eligible")
    .reduce((s, i) => s + i.cgstAmount + i.sgstAmount + i.igstAmount, 0);

  const totalIctAvailable = input.openingIct + iclInward + icgInward;
  const claimedIn3B = totalIctAvailable; // placeholder; in real impl, caller supplies claimed figure

  // Commonly referenced ITC caps
  const cap105 = input.availableIct2A2B * 1.05;
  const cap20 = totalIctAvailable * 0.2;
  const cap5 = totalIctAvailable * 0.05;

  const matched = Math.min(claimedIn3B, input.availableIct2A2B);
  const unmatchedClaimed = Math.max(0, claimedIn3B - input.availableIct2A2B);
  const unmatchedAvailable = Math.max(0, input.availableIct2A2B - claimedIn3B);

  const mismatches: string[] = [];
  if (unmatchedClaimed > 0)
    mismatches.push(
      `Claimed ITC ${claimedIn3B} exceeds 2A/2B available ${input.availableIct2A2B} by ${unmatchedClaimed}; review the unmatched claim.`,
    );
  if (unmatchedAvailable > 0)
    mismatches.push(
      `2A/2B available ITC ${input.availableIct2A2B} exceeds the claimed ITC ${claimedIn3B} by ${unmatchedAvailable}; review whether the available ITC can be claimed.`,
    );
  if (totalIctAvailable !== input.availableIct2A2B)
    mismatches.push(
      `Computed available ITC ${totalIctAvailable} and 2A/2B available ${input.availableIct2A2B} differ; reconcile opening balance, inward supplies, imports, and reversals.`,
    );

  const byEligibility: Record<string, number> = {};
  for (const inv of invoices) {
    byEligibility[inv.itcEligibility] = (byEligibility[inv.itcEligibility] ?? 0) + 1;
  }

  return {
    openingIct: input.openingIct,
    available2A2B: input.availableIct2A2B,
    claimedIn3B,
    matched,
    unmatchedClaimed,
    unmatchedAvailable,
    capApplied: false,
    capNote: `Commonly referenced ITC caps: 105% of 2A/2B = ${cap105}; 20% of computed available ITC = ${cap20}; 5% of computed available ITC = ${cap5}. These are surfaced so the reviewer can verify them against the current rule for the period.`,
    mismatches,
    invoices: {
      total: invoices.length,
      matched: invoices.filter((i) => i.matched2a2b).length,
      unmatched: invoices.filter((i) => !i.matched2a2b).length,
      byEligibility,
    },
  };
}
/**
 * GST register ↔ ledger reconciliation.
 *
 * The invoice register is deliberately a *register*: it is not automatically
 * journalised into `BookVoucher`, because an invoice does not by itself say
 * which revenue/expense and receivable/payable accounts the firm uses. That
 * decision has to be explicit rather than guessed, so `postingMode` is always
 * `"register-only"` and this report surfaces exactly what is missing.
 *
 * A register invoice is considered posted to the ledger only when a voucher
 * carries the reserved reference `GST:<invoiceId>` (the convention manual or
 * future automatic posting must use). The difference is returned by invoice
 * number so a CA can clear it, instead of the two books silently diverging.
 */
export async function reconcileGstRegisterWithLedger(workspaceId: string, bookId: string, period: string) {
  await requireBookAccess({ workspaceId }, bookId);

  const [invoices, vouchers] = await Promise.all([
    prisma.gstInvoice.findMany({
      where: { bookId, period },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        taxableValue: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        cessAmount: true,
      },
      orderBy: { invoiceDate: "asc" },
    }),
    prisma.bookVoucher.findMany({
      where: { bookId, date: { startsWith: period } },
      select: { reference: true },
    }),
  ]);

  const register = summarizeGstRegister(invoices);
  const totalTax = register.cgst + register.sgst + register.igst + register.cess;

  const postedReferences = new Set(
    vouchers.map((v) => v.reference).filter((ref): ref is string => typeof ref === "string" && ref.startsWith("GST:")),
  );
  const { postedInvoiceCount, missing } = missingGstVouchers(invoices, postedReferences);

  return {
    period,
    postingMode: "register-only" as const,
    postingNote:
      "GST invoices are not journalised automatically. Post a voucher with reference GST:<invoiceId> to move an invoice into the ledger.",
    register: { ...register, totalTax, invoiceValue: register.taxableValue + totalTax },
    ledger: {
      gstVoucherCount: postedReferences.size,
      postedInvoiceCount,
      postedWithoutVoucher: missing.length,
      missingInvoiceNumbers: missing.map((i) => i.invoiceNumber),
    },
    reconciled: missing.length === 0,
  };
}

/** Sum the register totals used by the GST↔ledger reconciliation. */
export function summarizeGstRegister(
  invoices: readonly {
    taxableValue: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
  }[],
) {
  return invoices.reduce(
    (acc, inv) => {
      acc.invoiceCount += 1;
      acc.taxableValue += inv.taxableValue;
      acc.cgst += inv.cgstAmount;
      acc.sgst += inv.sgstAmount;
      acc.igst += inv.igstAmount;
      acc.cess += inv.cessAmount;
      return acc;
    },
    { invoiceCount: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 },
  );
}

/**
 * Posted register invoices that have no `GST:<invoiceId>` voucher reference.
 * Pure so the definition of "reconciled" is testable.
 */
export function missingGstVouchers(
  invoices: readonly { id: string; invoiceNumber: string; status: string }[],
  postedReferences: ReadonlySet<string>,
) {
  const postedInvoices = invoices.filter((i) => i.status === "posted");
  return {
    postedInvoiceCount: postedInvoices.length,
    missing: postedInvoices.filter((i) => !postedReferences.has(`GST:${i.id}`)),
  };
}

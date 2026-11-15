/**
 * GST READ tools — register listing/status and the existing
 * GST-register-vs-ledger reconciliation. Tax computation stays in
 * `lib/server/gst-invoices.ts`.
 */

import { z } from "zod";

import { assertIsoDate, clip, decodeCursor, encodeCursor, money, monthRange } from "@/lib/ai/format";
import { maskGstin } from "@/lib/ai/redact";
import { objectSchema } from "@/lib/ai/tools/schema";
import type { AssistantContext, ToolData, ToolDefinition } from "@/lib/ai/tools/types";
import { prisma } from "@/lib/db";
import { computeGstr1Summary, listGstInvoices, reconcileGstRegisterWithLedger } from "@/lib/server/gst-invoices";

function requireBookId(ctx: AssistantContext): string {
  if (!ctx.bookId) throw new Error("No book is attached to this run.");
  return ctx.bookId;
}

const dateString = (label: string) =>
  z
    .string()
    .length(10)
    .refine((v) => {
      try {
        assertIsoDate(v, label);
        return true;
      } catch {
        return false;
      }
    }, `${label} must be a real YYYY-MM-DD date`);

const periodString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must be YYYY-MM");

/* -------------------------------------------------------------------------- */
/* 6. GST invoices + status                                                    */
/* -------------------------------------------------------------------------- */

const gstSchema = objectSchema({
  period: periodString
    .optional()
    .describe("GST return period YYYY-MM. Prefer this over a date range for GST questions."),
  from: dateString("from").optional().describe("Invoice date start, YYYY-MM-DD."),
  to: dateString("to").optional().describe("Invoice date end, YYYY-MM-DD."),
  status: z
    .enum(["draft", "validated", "posted", "cancelled", "amended"])
    .optional()
    .describe("Register status filter."),
  invoiceType: z
    .enum(["b2b", "b2c", "export", "sezwop", "deemed", "credit-note", "debit-note"])
    .optional()
    .describe("Invoice type filter."),
  gstin: z
    .string()
    .min(4)
    .max(15)
    .optional()
    .describe("Last 4+ characters of a supplier/recipient GSTIN. The full GSTIN is masked in the result."),
  limit: z.number().int().min(1).max(50).optional().describe("Invoices to return (max 50, default 25)."),
  cursor: z.string().max(200).optional().describe("Opaque nextCursor from a previous page."),
});

export const gstInvoices: ToolDefinition<z.infer<typeof gstSchema>> = {
  name: "gst_invoices",
  module: "gst",
  tier: "READ",
  requiresBook: true,
  description:
    "List inward/outward GST invoices for ONE book with per-status counts and totals, and optionally the GSTR-1 summary for a period. " +
    "Use for 'how many invoices are unposted', 'what is my GSTR-1 taxable value for August', or finding an invoice. " +
    "GSTINs are masked to the last four characters. " +
    "Do NOT use this to claim a return was filed: this tool has NO filing status — use period_lock_status for locks and state plainly that filing status is not available.",
  schema: gstSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    if (input.from && input.to && input.from > input.to) throw new Error("from must be on or before to");
    const offset = decodeCursor(input.cursor);
    const limit = input.limit ?? 25;
    const gstinLike = input.gstin ? { contains: input.gstin } : undefined;

    // List tool delegates filtering/pagination to the store.
    const page = await listGstInvoices(ctx.auth.workspace.id, bookId, {
      ...(input.period ? { period: input.period } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.invoiceType ? { invoiceType: input.invoiceType } : {}),
      ...(gstinLike ? { supplierGstin: input.gstin } : {}),
      limit,
      offset,
    });

    // Per-status totals use the same filters but aggregate in the database;
    // we never materialise the whole register just to count it.
    const where: Record<string, unknown> = {
      bookId,
      ...(input.period ? { period: input.period } : {}),
      ...(input.invoiceType ? { invoiceType: input.invoiceType } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    if (input.from || input.to) {
      where.invoiceDate = { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) };
    }
    if (gstinLike) {
      where.OR = [{ supplierGstin: gstinLike }, { recipientGstin: gstinLike }];
    }
    const groups = await prisma.gstInvoice.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
      _sum: { taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, cessAmount: true },
    });
    const byStatus = groups
      .map((g) => {
        const tax =
          (g._sum.cgstAmount ?? 0) + (g._sum.sgstAmount ?? 0) + (g._sum.igstAmount ?? 0) + (g._sum.cessAmount ?? 0);
        return {
          status: g.status,
          invoiceCount: g._count._all,
          taxableValue: money(g._sum.taxableValue ?? 0),
          tax: money(tax),
        };
      })
      .sort((a, b) => a.status.localeCompare(b.status));

    const gstr1 = input.period
      ? await computeGstr1Summary(ctx.auth.workspace.id, { bookId, period: input.period })
      : null;
    const nextCursor = offset + limit < page.total ? encodeCursor(offset + limit) : undefined;

    return {
      bookId,
      filters: {
        period: input.period ?? null,
        from: input.from ?? null,
        to: input.to ?? null,
        status: input.status ?? null,
        invoiceType: input.invoiceType ?? null,
        gstinSuffixOrPart: input.gstin ?? null,
      },
      byStatus,
      invoices: page.invoices.map((inv) => ({
        invoiceId: inv.id,
        number: inv.invoiceNumber,
        date: inv.invoiceDate,
        period: inv.period,
        type: inv.invoiceType,
        status: inv.status,
        supplyType: inv.supplyType,
        placeOfSupply: inv.placeOfSupply,
        supplierGstin: maskGstin(inv.supplierGstin),
        supplierName: clip(inv.supplierName, 80),
        recipientGstin: maskGstin(inv.recipientGstin),
        recipientName: clip(inv.recipientName, 80),
        taxableValue: money(inv.taxableValue),
        cgst: money(inv.cgstAmount),
        sgst: money(inv.sgstAmount),
        igst: money(inv.igstAmount),
        cess: money(inv.cessAmount),
        totalTax: money(inv.cgstAmount + inv.sgstAmount + inv.igstAmount + inv.cessAmount),
        matched2a2b: inv.matched2a2b,
        itcEligibility: inv.itcEligibility,
        rcm: inv.rcm,
      })),
      rowCount: page.invoices.length,
      total: page.total,
      truncated: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
      ...(gstr1
        ? {
            gstr1: {
              period: input.period,
              invoiceCounts: {
                b2b: gstr1.b2b.length,
                b2c: gstr1.b2c.length,
                export: gstr1.export.length,
                creditNotes: gstr1.creditNotes.length,
                debitNotes: gstr1.debitNotes.length,
              },
              totalTaxable: money(gstr1.totalTaxable),
              totalCgst: money(gstr1.totalCgst),
              totalSgst: money(gstr1.totalSgst),
              totalIgst: money(gstr1.totalIgst),
              totalCess: money(gstr1.totalCess),
              totalTax: money(gstr1.totalTax),
              scope: "Only invoices in status 'validated' or 'posted' are included by the GSTR-1 engine.",
            },
          }
        : {}),
      note: input.period
        ? undefined
        : "No GST period supplied. Status counts cover the whole register (or the date range given), not a return period.",
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 7. GST register vs ledger reconciliation                                    */
/* -------------------------------------------------------------------------- */

const gstReconSchema = objectSchema({
  period: periodString.describe("GST period YYYY-MM (also the ledger month used for voucher matching)."),
});

export const gstReconciliation: ToolDefinition<z.infer<typeof gstReconSchema>> = {
  name: "gst_register_ledger_reconciliation",
  module: "gst",
  tier: "READ",
  requiresBook: true,
  description:
    "Compare the GST invoice register with the journal for ONE period: register totals, posted-invoice count, and invoices with no ledger voucher. " +
    "Use for 'is my GST register posted to the books' or 'what is missing from the ledger'. " +
    "It does NOT compare GSTR-2A/2B, does NOT compute ITC eligibility, and does NOT file anything.",
  schema: gstReconSchema,
  execute: async (input, ctx): Promise<ToolData> => {
    const bookId = requireBookId(ctx);
    const recon = await reconcileGstRegisterWithLedger(ctx.auth.workspace.id, bookId, input.period);
    return {
      bookId,
      period: recon.period,
      postingMode: recon.postingMode,
      postingNote: recon.postingNote,
      register: {
        invoiceCount: recon.register.invoiceCount,
        taxableValue: money(recon.register.taxableValue),
        cgst: money(recon.register.cgst),
        sgst: money(recon.register.sgst),
        igst: money(recon.register.igst),
        cess: money(recon.register.cess),
        totalTax: money(recon.register.totalTax),
        invoiceValue: money(recon.register.invoiceValue),
      },
      ledger: {
        gstVoucherCount: recon.ledger.gstVoucherCount,
        postedInvoiceCount: recon.ledger.postedInvoiceCount,
        postedWithoutVoucher: recon.ledger.postedWithoutVoucher,
        missingInvoiceNumbers: recon.ledger.missingInvoiceNumbers.slice(0, 50),
      },
      reconciled: recon.reconciled,
      scopeNote:
        "A register invoice counts as posted only when a voucher carries reference GST:<invoiceId>. Other vouchers are not inferred.",
      ...(input.period ? { month: monthRange(input.period) } : {}),
    };
  },
};

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { validateEwayBillInvoiceLink } from "@/lib/engine/gst-eway-bill";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/eway-bill/validate-link — validate E-Way Bill to Invoice linkage
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const ewayBillSchema = z.object({
      docNo: z.string().trim().min(1),
      docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      docValue: z.number().int().positive(),
      fromGstin: z.string().trim().min(15).max(15),
      toGstin: z.string().trim().min(15).max(15),
      items: z.array(
        z.object({
          hsnCode: z.string().trim().min(4).max(8),
        }),
      ),
    });
    const invoiceSchema = z.object({
      invoiceNumber: z.string().trim().min(1),
      invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      taxableValue: z.number().int().nonnegative(),
      cgstAmount: z.number().int().nonnegative(),
      sgstAmount: z.number().int().nonnegative(),
      igstAmount: z.number().int().nonnegative(),
      cessAmount: z.number().int().nonnegative(),
      supplierGstin: z.string().trim().min(15).max(15),
      recipientGstin: z.string().trim().min(15).max(15),
      items: z.array(
        z.object({
          hsn: z.string().trim().min(4).max(8),
          taxableValue: z.number().int().nonnegative(),
        }),
      ),
    });
    const body = z
      .object({
        ewayBill: ewayBillSchema,
        invoice: invoiceSchema,
      })
      .parse(await readJsonBody(request));
    const result = validateEwayBillInvoiceLink(body.ewayBill, body.invoice);
    return ok(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

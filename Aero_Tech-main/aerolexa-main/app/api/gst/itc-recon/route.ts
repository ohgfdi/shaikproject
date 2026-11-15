import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import {
  BLOCKED_ITC_LABELS,
  reconcileItc,
  type BlockedItcCategory,
  type Gstr2bRow,
  type PurchaseRow,
} from "@/lib/engine/gstr-2b-itc";
import { summarizeItcConfidence } from "@/lib/engine/itc-confidence";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/gst/itc-recon — reconcile a purchase register against GSTR-2B and
 * produce the GSTR-3B Table 4 figures for the period.
 *
 * The caller supplies BOTH sides as row data: the purchase register (from the
 * books, Tally export or a dataset) and the 2B lines (mapped from the portal
 * JSON — this endpoint never talks to the portal). Amounts are RUPEES as
 * decimals in the API and are converted to minor units here, matching the
 * engine's integer-paise contract.
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const blockedKeys = Object.keys(BLOCKED_ITC_LABELS) as [BlockedItcCategory, ...BlockedItcCategory[]];
    const rupees = z.number().finite().multipleOf(0.01).safe();

    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");

    const twoBRow = z.object({
      gstin: z.string().trim().min(15).max(15),
      supplierName: z.string().trim().optional(),
      invoiceNumber: z.string().trim().min(1),
      invoiceDate: date,
      docType: z.enum(["INV", "CRN", "DBN"]).optional(),
      taxableValue: rupees,
      igst: rupees,
      cgst: rupees,
      sgst: rupees,
      cess: rupees.optional().default(0),
      placeOfSupply: z.string().trim().min(1).max(3),
      reverseCharge: z.boolean().optional(),
      supplierFiledGstr1: z.boolean().optional(),
      itcAvailable: z.boolean().optional(),
    });

    const purchaseRow = z.object({
      gstin: z.string().trim().min(15).max(15),
      invoiceNumber: z.string().trim().min(1),
      invoiceDate: date,
      docType: z.enum(["INV", "CRN", "DBN"]).optional(),
      taxableValue: rupees,
      igst: rupees,
      cgst: rupees,
      sgst: rupees,
      cess: rupees.optional().default(0),
      placeOfSupply: z.string().trim().min(1).max(3),
      reverseCharge: z.boolean().optional(),
      blockedCategory: z.enum(blockedKeys).nullable().optional(),
    });

    const body = z
      .object({
        asOfDate: date,
        /** Rupee tolerance for amount comparison (default ₹1). */
        tolerance: rupees.optional(),
        twoB: z.array(twoBRow).max(50_000),
        purchases: z.array(purchaseRow).max(50_000),
      })
      .parse(await readJsonBody(request));

    const toPaise = (n: number) => Math.round(n * 100);

    const reconciliation = reconcileItc({
      asOfDate: body.asOfDate,
      tolerance: body.tolerance !== undefined ? toPaise(body.tolerance) : undefined,
      twoB: body.twoB.map<Gstr2bRow>((r) => ({
        gstin: r.gstin,
        supplierName: r.supplierName,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        docType: r.docType,
        taxableValue: toPaise(r.taxableValue),
        igst: toPaise(r.igst),
        cgst: toPaise(r.cgst),
        sgst: toPaise(r.sgst),
        cess: toPaise(r.cess),
        placeOfSupply: r.placeOfSupply,
        reverseCharge: r.reverseCharge,
        supplierFiledGstr1: r.supplierFiledGstr1,
        itcAvailable: r.itcAvailable,
      })),
      purchases: body.purchases.map<PurchaseRow>((r) => ({
        gstin: r.gstin,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        docType: r.docType,
        taxableValue: toPaise(r.taxableValue),
        igst: toPaise(r.igst),
        cgst: toPaise(r.cgst),
        sgst: toPaise(r.sgst),
        cess: toPaise(r.cess),
        placeOfSupply: r.placeOfSupply,
        reverseCharge: r.reverseCharge,
        blockedCategory: r.blockedCategory ?? null,
      })),
    });

    // Confidence is derived, not a second verdict: the reconciliation and its
    // Table 4 figures are unchanged. It only orders the reviewer's worklist.
    return ok({ reconciliation, confidence: summarizeItcConfidence(reconciliation) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

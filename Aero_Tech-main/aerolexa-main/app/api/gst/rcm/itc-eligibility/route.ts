import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { calculateRcmTax, determineRcmItcEligibility, type RcmCategory, RCM_CATEGORIES } from "@/lib/engine/gst-rcm";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/rcm/itc-eligibility — determine ITC eligibility for RCM supply
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const rupees = z.number().finite().multipleOf(0.01).safe();
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");
    const supplySchema = z.object({
      category: z.enum(Object.keys(RCM_CATEGORIES) as [RcmCategory, ...RcmCategory[]]),
      supplierGstin: z.string().trim().max(15).nullable().optional(),
      supplierName: z.string().trim().min(1),
      recipientGstin: z.string().trim().min(15).max(15),
      recipientName: z.string().trim().min(1),
      placeOfSupply: z.string().trim().min(2).max(2),
      taxableValue: rupees,
      invoiceNumber: z.string().trim().min(1),
      invoiceDate: date,
      hsnSac: z.string().trim().min(4).max(8),
      isImportOfService: z.boolean().optional(),
      isEcom: z.boolean().optional(),
      ecomGstin: z.string().trim().max(15).nullable().optional(),
    });
    const body = z
      .object({
        supply: supplySchema,
        recipientStateCode: z.string().trim().min(2).max(2),
        isBusinessPurpose: z.boolean(),
        isCapitalGoods: z.boolean().optional(),
        blockedCategory: z
          .enum(["motor-vehicle", "food-beverages", "club-membership", "personal", "csr", "works-contract-immovable"])
          .nullable()
          .optional(),
        taxPaid: z.boolean().optional(),
      })
      .parse(await readJsonBody(request));
    const taxAmounts = calculateRcmTax(body.supply, body.recipientStateCode);
    const eligibility = determineRcmItcEligibility(body.supply, taxAmounts, {
      isBusinessPurpose: body.isBusinessPurpose,
      isCapitalGoods: body.isCapitalGoods,
      blockedCategory: body.blockedCategory ?? null,
      taxPaid: body.taxPaid ?? false,
    });
    return ok({ eligibility });
  } catch (err) {
    return toErrorResponse(err);
  }
}

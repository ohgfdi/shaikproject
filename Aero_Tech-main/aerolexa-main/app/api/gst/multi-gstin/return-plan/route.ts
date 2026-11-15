import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { generateMultiGstinReturnPlan, type MultiGstinEntity, type SupplyContext } from "@/lib/engine/gst-multi-gstin";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/multi-gstin/return-plan — generate state-wise return filing plan
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const rupees = z.number().finite().multipleOf(0.01).safe();
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");
    const period = z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm");
    const contextSchema = z.object({
      supplierGstin: z.string().trim().min(15).max(15),
      supplierStateCode: z.string().trim().min(2).max(2),
      recipientGstin: z.string().trim().max(15).nullable().optional(),
      recipientStateCode: z.string().trim().max(2).nullable().optional(),
      placeOfSupply: z.string().trim().min(2).max(2),
      supplyType: z.enum(["intra", "inter"]),
      invoiceType: z.enum(["b2b", "b2c", "export", "sezwop", "credit-note", "debit-note"]),
      invoiceNumber: z.string().trim().min(1),
      invoiceDate: date,
      taxableValue: rupees,
    });
    const registrationSchema = z.object({
      gstin: z.string().trim().min(15).max(15),
      legalName: z.string().trim().min(1),
      tradeName: z.string().trim().optional(),
      stateCode: z.string().trim().min(2).max(2),
      stateName: z.string().trim().min(1),
      registrationType: z.enum([
        "regular",
        "composition",
        "tcs-collector",
        "tds-deductor",
        "non-resident",
        "casual",
        "isd",
      ]),
      status: z.enum(["active", "suspended", "cancelled", "pending-verification"]),
      registrationDate: date,
      cancellationDate: date.nullable().optional(),
      address: z.object({
        buildingNo: z.string(),
        street: z.string(),
        city: z.string(),
        district: z.string(),
        pincode: z.number().int().min(100000).max(999999),
      }),
      constitution: z.enum(["proprietorship", "partnership", "company", "llp", "huf", "trust", "government", "other"]),
      authorizedSignatories: z.array(
        z.object({
          name: z.string(),
          designation: z.string(),
          pan: z.string().trim().min(10).max(10),
          mobile: z.string(),
          email: z.string().email(),
        }),
      ),
    });
    const entitySchema = z.object({
      id: z.string(),
      entityName: z.string(),
      pan: z.string().trim().min(10).max(10),
      entityType: z.enum(["company", "llp", "partnership", "proprietorship", "huf", "trust", "other"]),
      gstinRegistrations: z.array(registrationSchema),
      primaryGstin: z.string().trim().min(15).max(15),
      createdAt: z.string(),
      updatedAt: z.string(),
    });
    const body = z
      .object({
        entity: entitySchema,
        period: period,
        outwardInvoices: z.array(contextSchema),
        inwardInvoices: z.array(contextSchema),
        crossGstinAllocations: z
          .array(
            z.object({
              fromGstin: z.string().trim().min(15).max(15),
              toGstin: z.string().trim().min(15).max(15),
              itcAmount: z.number().finite().multipleOf(0.01).safe(),
              reason: z.enum(["isdd", "branch-transfer", "common-credit", "adjustment"]),
              documentRef: z.string(),
            }),
          )
          .optional(),
      })
      .parse(await readJsonBody(request));
    const plan = generateMultiGstinReturnPlan(body.entity as MultiGstinEntity, body.period, {
      outwardInvoices: body.outwardInvoices as SupplyContext[],
      inwardInvoices: body.inwardInvoices as SupplyContext[],
      crossGstinAllocations: body.crossGstinAllocations,
    });
    return ok({ plan });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { validateSupplyAgainstEntity, type SupplyContext, type MultiGstinEntity } from "@/lib/engine/gst-multi-gstin";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/multi-gstin/validate-supply — validate a supply against entity's GSTIN registrations
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const rupees = z.number().finite().multipleOf(0.01).safe();
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");
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
    const addressSchema = z.object({
      buildingNo: z.string(),
      street: z.string(),
      city: z.string(),
      district: z.string(),
      pincode: z.number().int().positive(),
    });
    const authorizedSignatorySchema = z.object({
      name: z.string(),
      designation: z.string(),
      pan: z.string(),
      mobile: z.string(),
      email: z.string(),
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
      address: addressSchema,
      constitution: z.enum(["proprietorship", "partnership", "company", "llp", "huf", "trust", "government", "other"]),
      authorizedSignatories: z.array(authorizedSignatorySchema),
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
        context: contextSchema,
        entity: entitySchema,
      })
      .parse(await readJsonBody(request));
    const mismatches = validateSupplyAgainstEntity(body.context as SupplyContext, body.entity as MultiGstinEntity);
    return ok({ mismatches });
  } catch (err) {
    return toErrorResponse(err);
  }
}

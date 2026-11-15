import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import {
  buildEwayBillPayload,
  calculateEwayBillValidity,
  type EwayBillGenerateInput,
} from "@/lib/engine/gst-eway-bill";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/eway-bill/generate-payload — generate E-Way Bill payload for NIC/GSP API
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const rupees = z.number().finite().multipleOf(0.01).safe();
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd");
    const partySchema = z.object({
      gstin: z.string().trim().min(15).max(15),
      name: z.string().trim().min(1),
      address: z.string().trim().min(1),
      place: z.string().trim().min(1),
      pincode: z.number().int().min(100000).max(999999),
      stateCode: z.string().trim().min(2).max(2),
    });
    const itemSchema = z.object({
      productName: z.string().trim().min(1),
      description: z.string().optional(),
      hsnCode: z.string().trim().min(4).max(8),
      quantity: z.number().positive(),
      unit: z.string().trim().min(1),
      taxableValue: rupees,
      taxRate: z.number().min(0).max(28),
      sgstRate: z.number().min(0).max(14).optional(),
      cgstRate: z.number().min(0).max(14).optional(),
      igstRate: z.number().min(0).max(28).optional(),
      cessRate: z.number().min(0).max(15).optional(),
    });
    const transportSchema = z.object({
      mode: z.enum(["road", "rail", "air", "ship"]),
      distance: z.number().positive(),
      vehicleNo: z.string().optional(),
      vehicleType: z.enum(["regular", "over-dimensional", "container", "tanker"]).optional(),
      transDocNo: z.string().optional(),
      transDocDate: date.optional(),
      transporterId: z.string().optional(),
      transporterName: z.string().optional(),
      fromPlace: z.string().trim().min(1),
      fromStateCode: z.string().trim().min(2).max(2),
      fromPincode: z.number().int().min(100000).max(999999),
      toPlace: z.string().trim().min(1),
      toStateCode: z.string().trim().min(2).max(2),
      toPincode: z.number().int().min(100000).max(999999),
    });
    const body = z
      .object({
        docType: z.enum(["INV", "BIL", "CHL", "CRN", "DBN", "OTH"]),
        docNo: z.string().trim().min(1),
        docDate: date,
        docValue: rupees,
        supplyType: z.enum(["B2B", "B2C", "EXP", "IMP", "SEZ", "JOB", "EXH", "OWN", "SKD", "OTH"]),
        transactionType: z.enum(["regular", "bill-to-ship-to", "bill-from-dispatch-from", "combination"]),
        subType: z.enum(["outward", "inward", "return", "job-work", "exhibition", "own-use", "skd-ckd"]).optional(),
        supplier: partySchema,
        recipient: partySchema,
        dispatchFrom: partySchema.optional(),
        shipTo: partySchema.optional(),
        items: z.array(itemSchema).min(1),
        transport: transportSchema,
        cewbNo: z.string().optional(),
        irn: z.string().optional(),
        irnDate: date.optional(),
      })
      .parse(await readJsonBody(request));
    const payload = buildEwayBillPayload(body as EwayBillGenerateInput);
    const validity = calculateEwayBillValidity(
      body.transport.distance,
      body.transport.vehicleType ?? "regular",
      new Date().toISOString(),
    );
    return ok({ payload, validity });
  } catch (err) {
    return toErrorResponse(err);
  }
}

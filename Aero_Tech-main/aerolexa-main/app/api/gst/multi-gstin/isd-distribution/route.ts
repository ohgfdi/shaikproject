import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { distributeIsdCredit } from "@/lib/engine/gst-multi-gstin";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/multi-gstin/isd-distribution — distribute common ITC (ISD)
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const rupees = z.number().finite().multipleOf(0.01).safe();
    const period = z.string().regex(/^\d{4}-\d{2}$/, "must be yyyy-mm");
    const body = z
      .object({
        isdGstin: z.string().trim().min(15).max(15),
        period: period,
        commonCredit: z.object({
          igst: rupees,
          cgst: rupees,
          sgst: rupees,
          cess: rupees.optional().default(0),
        }),
        recipients: z
          .array(
            z.object({
              gstin: z.string().trim().min(15).max(15),
              stateCode: z.string().trim().min(2).max(2),
              turnoverRatio: z.number().min(0).max(1),
            }),
          )
          .min(1),
      })
      .parse(await readJsonBody(request));
    const distribution = distributeIsdCredit(body.isdGstin, body.period, body.commonCredit, body.recipients);
    return ok({ distribution });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { calculateEwayBillPenalty } from "@/lib/engine/gst-eway-bill";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/eway-bill/penalty — calculate penalty for E-Way Bill violation
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = z
      .object({
        violation: z.enum([
          "not-generated",
          "value-mismatch",
          "invalid-transport",
          "expired-transit",
          "fake-bill",
          "goods-mismatch",
        ]),
        taxInvolved: z.number().finite().multipleOf(0.01).safe(),
        goodsValue: z.number().finite().multipleOf(0.01).safe(),
        isExempt: z.boolean().optional().default(false),
      })
      .parse(await readJsonBody(request));
    const penalty = calculateEwayBillPenalty(
      body.violation,
      Math.round(body.taxInvolved * 100),
      Math.round(body.goodsValue * 100),
      body.isExempt,
    );
    return ok({ penalty });
  } catch (err) {
    return toErrorResponse(err);
  }
}

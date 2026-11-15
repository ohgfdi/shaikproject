import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { validateGstinOffline } from "@/lib/engine/gst-supplier-onboarding";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/suppliers/validate-gstin — validate GSTIN format
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = z
      .object({
        gstin: z.string().trim().min(15).max(15),
      })
      .parse(await readJsonBody(request));
    const result = validateGstinOffline(body.gstin);
    return ok({ validation: result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

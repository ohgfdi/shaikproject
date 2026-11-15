import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { verifyLinkOtp } from "@/lib/auth/phone-otp";
import { logActivity } from "@/lib/server/activity";
import { readJsonBody, ok, toErrorResponse } from "@/lib/server/api";

const schema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

/**
 * POST /api/me/phone/verify — confirm the LINK_PHONE code and stamp
 * `phoneNumber` + `phoneVerifiedAt` on the signed-in account.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    await verifyLinkOtp({ userId: ctx.user.id, phone: body.phone, code: body.code });
    await logActivity(ctx, "PHONE_VERIFIED", `Phone number verified`, null, { kind: "PHONE_LINK" });
    return ok({ verified: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

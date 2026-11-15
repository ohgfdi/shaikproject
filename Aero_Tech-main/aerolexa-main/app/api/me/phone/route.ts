import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { sendLinkOtp } from "@/lib/auth/phone-otp";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

const schema = z.object({
  phone: z.string().min(8).max(20),
});

/**
 * POST /api/me/phone — send a LINK_PHONE OTP to attach (or change) the
 * signed-in user's phone number. The number is only stamped verified after
 * /api/me/phone/verify confirms a code delivered to it, so an attacker with
 * a stolen session cannot silently redirect the account.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    await sendLinkOtp({ userId: ctx.user.id, phone: body.phone });
    await logActivity(ctx, "PHONE_LINK_REQUESTED", `Phone link requested`, null, { kind: "PHONE_LINK" });
    return ok({ sent: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

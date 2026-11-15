import { z } from "zod";

import { phoneIpHash, sendLoginOtp } from "@/lib/auth/phone-otp";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { RATE_LIMITS, clientIp, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  phone: z.string().min(8).max(20),
});

/**
 * POST /api/auth/phone/request — send a login OTP to an existing account.
 *
 * Rate-limited by IP (auth bucket) AND by per-phone send budget inside
 * lib/auth/phone-otp.ts (1/min, 5/hour) to stop SMS pumping. The response is
 * identical whether or not the number belongs to an account (no enumeration).
 */
export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "login", RATE_LIMITS.login);
    const body = schema.parse(await readJsonBody(request));
    // SEC-7: single, trusted-proxy-aware IP resolution (TRUST_PROXY_HOPS);
    // the ad-hoc first-hop parse here previously trusted a spoofable header.
    const ip = clientIp(request) ?? null;
    await sendLoginOtp({ phone: body.phone, ipHash: phoneIpHash(ip) });
    return Response.json({ ok: true, data: { sent: true } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

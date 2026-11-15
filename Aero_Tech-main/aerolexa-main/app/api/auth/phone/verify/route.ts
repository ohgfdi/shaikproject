import { z } from "zod";

import { verifyLoginOtp } from "@/lib/auth/phone-otp";
import { createSessionCookie, createSessionToken } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

/**
 * POST /api/auth/phone/verify — exchange a valid OTP for a session cookie.
 *
 * The OTP row records the user id, so no credential lookup happens here; the
 * code itself is the single-use credential (5-minute TTL, ≤5 attempts,
 * bcrypt-hashed at rest — see lib/auth/phone-otp.ts).
 */
export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "verify", RATE_LIMITS.verify);
    const body = schema.parse(await readJsonBody(request));
    const { userId } = await verifyLoginOtp(body);

    const session = await createSessionToken(userId);
    const res = Response.json({ ok: true, data: { ok: true } });
    const cookie = createSessionCookie(session, serverSessionTtl());
    res.headers.append("Set-Cookie", serializeCookie(cookie));
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

function serverSessionTtl(): number {
  return serverEnv().SESSION_TTL_DAYS * 24 * 60 * 60;
}

function serializeCookie(cookie: { name: string; value: string; options: Record<string, unknown> }): string {
  const o = cookie.options;
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${o.path ?? "/"}`, `Max-Age=${String(o.maxAge ?? 0)}`];
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.sameSite) parts.push(`SameSite=${o.sameSite === "lax" ? "Lax" : o.sameSite === "strict" ? "Strict" : "None"}`);
  if (o.secure) parts.push("Secure");
  return parts.join("; ");
}

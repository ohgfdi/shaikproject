import { NextResponse } from "next/server";
import { z } from "zod";

import { toErrorResponse } from "@/lib/server/api";
import { registerUser, sessionCookieFor } from "@/lib/server/auth-service";
import { hashIp, recordSignupConsents } from "@/lib/server/dpdp";
import { RATE_LIMITS, clientIp, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  name: z.string().trim().min(2, "Please enter your full name (at least 2 characters).").max(120),
  email: z.string().trim().email("Please enter a valid email address."),
  password: z
    .string()
    .min(8, "Use at least 8 characters with a letter and a number.")
    .max(200)
    .refine((pw) => /[A-Za-z]/.test(pw) && /[0-9]/.test(pw), {
      message: "Your password needs at least one letter and one number.",
    }),
  // DPDP itemized consent — optional purposes are explicit opt-ins. Required
  // (service) consent is always recorded server-side; absent = refused for
  // optional purposes (no pre-ticked boxes).
  consents: z
    .object({
      "product-improvement": z.boolean().optional(),
      marketing: z.boolean().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "signup", RATE_LIMITS.signup);
    const body = schema.parse(await request.json());
    const { user, session } = await registerUser(body);

    // Record the itemized signup consents with a hashed IP for proof.
    // SEC-7: trusted-proxy-aware resolution, same rule as rate limiting.
    const ip = clientIp(request) ?? null;
    await recordSignupConsents(user.id, body.consents ?? {}, hashIp(ip));

    const res = NextResponse.json({ ok: true, data: { user } });
    if (session) {
      const cookie = sessionCookieFor(session);
      res.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

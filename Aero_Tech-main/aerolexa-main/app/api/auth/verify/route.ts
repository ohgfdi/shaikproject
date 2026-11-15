import { NextResponse } from "next/server";
import { z } from "zod";

import { toErrorResponse } from "@/lib/server/api";
import { verifyEmail, sessionCookieFor } from "@/lib/server/auth-service";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({ token: z.string().min(10) });

export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "verify", RATE_LIMITS.verify);
    const { token } = schema.parse(await request.json());
    const { user } = await verifyEmail(token);
    const res = NextResponse.json({ ok: true, data: { verified: true, userId: user.id } });
    const session = await import("@/lib/auth/session").then((m) => m.createSessionToken(user.id));
    const cookie = sessionCookieFor(session);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

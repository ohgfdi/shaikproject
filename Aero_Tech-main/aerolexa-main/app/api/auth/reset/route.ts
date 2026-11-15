import { NextResponse } from "next/server";
import { z } from "zod";

import { toErrorResponse } from "@/lib/server/api";
import { resetPassword, sessionCookieFor } from "@/lib/server/auth-service";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });

export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "reset", RATE_LIMITS.reset);
    const { token, password } = schema.parse(await request.json());
    const { session } = await resetPassword(token, password);
    const res = NextResponse.json({ ok: true, data: { reset: true } });
    const cookie = sessionCookieFor(session);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

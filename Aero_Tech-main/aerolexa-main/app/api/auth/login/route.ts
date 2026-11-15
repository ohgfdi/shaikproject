import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { loginUser, sessionCookieFor } from "@/lib/server/auth-service";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "login", RATE_LIMITS.login);
    const body = schema.parse(await request.json());
    const result = await loginUser(body);
    if (result.mfaRequired) {
      // No cookie yet — the challenge is not a session.
      return NextResponse.json({
        ok: true,
        data: { user: result.user, mfaRequired: true, challenge: result.challenge },
      });
    }
    const { user, session } = result;
    const withWorkspace = await prisma.user.findUnique({
      where: { id: user.id },
      select: { workspace: { select: { id: true } } },
    });
    if (withWorkspace?.workspace) {
      await logSecurityEvent(withWorkspace.workspace.id, user.id, "SECURITY_SIGN_IN", `${user.email} signed in`);
    }
    const res = NextResponse.json({ ok: true, data: { user } });
    const cookie = sessionCookieFor(session);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";

import { createSessionToken, verifyMfaChallengeToken } from "@/lib/auth/session";
import { logSecurityEvent } from "@/lib/server/activity";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { sessionCookieFor } from "@/lib/server/auth-service";
import { verifyMfaLogin } from "@/lib/server/mfa";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  challenge: z.string().min(20),
  code: z.string().min(6).max(20),
});

/**
 * POST /api/auth/mfa/verify — second factor for password sign-in.
 *
 * The password step already succeeded, so a wrong code costs one attempt in
 * the same login bucket. The challenge is audience-separated from a session:
 * it cannot be replayed as one, and it expires in five minutes.
 */
export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "login", RATE_LIMITS.login);
    const body = schema.parse(await readJsonBody(request));
    const userId = await verifyMfaChallengeToken(body.challenge);
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_MFA_CHALLENGE", message: "That sign-in attempt expired. Sign in again." } },
        { status: 401 },
      );
    }
    const user = await verifyMfaLogin(userId, body.code);
    if (user.workspaceId) {
      await logSecurityEvent(user.workspaceId, user.id, "SECURITY_SIGN_IN", `${user.email} signed in with MFA`);
    }
    const session = await createSessionToken(user.id);
    const res = NextResponse.json({
      ok: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, profileRole: user.profileRole },
        mfaVerified: true,
      },
    });
    const cookie = sessionCookieFor(session);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

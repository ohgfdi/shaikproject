import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { revokeUserSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";

const schema = z.object({ currentPassword: z.string().min(1) });

/**
 * POST /api/me/sessions/revoke — "sign out everywhere".
 *
 * Real session revocation (the honesty note on the settings page called the
 * old state "limited in the prototype"): bumping User.sessionVersion makes
 * EVERY outstanding Ledgerly session JWT invalid at the next readSession()
 * (SEC-7 version check) — no token denylist needed. Password re-confirmation
 * gates the call so a hijacked tab cannot lock the real user out.
 *
 * The current device is revokable too: the caller can mint a fresh session
 * for the same user immediately (sign-out → sign-in flow), which is exactly
 * what the settings UI does after this route answers.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));

    const user = await prisma.user.findUnique({ where: { id: ctx.user.id } });
    if (!user) return ok({ revoked: false, message: "Please sign in again." });

    // Anonymous accounts (SSO-only, no password set) skip the confirmation —
    // there is no password to check; possession of the session is the proof.
    if (user.passwordHash) {
      const okPw = await verifyPassword(body.currentPassword, user.passwordHash);
      if (!okPw) return ok({ revoked: false, message: "Your current password is incorrect." });
    }

    await revokeUserSessions(user.id);
    await logSecurityEvent(
      ctx.workspace.id,
      ctx.user.id,
      "SECURITY_SIGN_OUT",
      "Signed out everywhere (all sessions revoked)",
    );

    return ok({ revoked: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

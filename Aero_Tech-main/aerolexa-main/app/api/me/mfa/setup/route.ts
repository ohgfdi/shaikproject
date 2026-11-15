import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { startMfaSetup } from "@/lib/server/mfa";

/**
 * POST /api/me/mfa/setup — begin TOTP enrolment.
 *
 * Returns the seed and otpauth URI ONCE for the user to scan. The server keeps
 * only a sealed pending copy until a valid code promotes it.
 */
export async function POST() {
  try {
    const ctx = await requireAuth();
    return ok(await startMfaSetup(ctx.user.id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { mfaStatus } from "@/lib/server/mfa";

/** GET /api/me/mfa — whether MFA is on, and how many recovery codes remain. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    return ok(await mfaStatus(ctx.user.id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { logSecurityEvent } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { disableMfa } from "@/lib/server/mfa";

const schema = z.object({ code: z.string().min(6).max(20) });

/** POST /api/me/mfa/disable — requires a current TOTP or recovery code. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    await disableMfa(ctx.user.id, body.code);
    await logSecurityEvent(
      ctx.workspace.id,
      ctx.user.id,
      "SECURITY_MFA_DISABLED",
      "Two-factor authentication disabled",
    );
    return ok({ enabled: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}

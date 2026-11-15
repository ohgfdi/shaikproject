import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { logSecurityEvent } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { enableMfa } from "@/lib/server/mfa";

const schema = z.object({ code: z.string().min(6).max(20) });

/** POST /api/me/mfa/enable — promote the pending seed after a valid code. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const { recoveryCodes } = await enableMfa(ctx.user.id, body.code);
    await logSecurityEvent(
      ctx.workspace.id,
      ctx.user.id,
      "SECURITY_MFA_ENABLED",
      "Two-factor authentication enabled",
    );
    return ok({ enabled: true, recoveryCodes });
  } catch (err) {
    return toErrorResponse(err);
  }
}

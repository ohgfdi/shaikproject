import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { clearSessionCookieDescriptors } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { eraseUser, hashIp, recordConsent } from "@/lib/server/dpdp";

const schema = z.object({
  password: z.string().min(1),
  confirmation: z.literal("DELETE MY ACCOUNT"),
  reason: z.string().max(500).optional(),
});

/**
 * POST /api/me/erase — the DPDP right to erasure.
 *
 * Requires the current password (identity proof) and a typed confirmation.
 * Erases personal data (see lib/server/dpdp.ts), which also records the durable
 * DPDP proof-of-erasure event, then clears the session cookie. The response
 * reports what was removed.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));

    const user = await prisma.user.findUnique({ where: { id: ctx.user.id } });
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in again.");
    const okPw = await verifyPassword(body.password, user.passwordHash);
    if (!okPw) throw new ApiError(400, "WRONG_PASSWORD", "Your current password is incorrect.");

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null;

    // Best-effort operational trail in the workspace audit log. This row is
    // cascade-deleted with the workspace during erasure, so it is NOT the proof
    // of erasure — it only survives if the erasure fails midway. The durable,
    // retention-bound proof is the ComplianceEvent written inside eraseUser().
    const { logActivity } = await import("@/lib/server/activity");
    await logActivity(
      ctx,
      "DPDP_ERASURE",
      `DPDP erasure requested${body.reason ? ` — reason recorded (${body.reason.length} chars)` : ""}`,
      null,
      {
        kind: "DPDP_ERASURE",
        ipHash: hashIp(ip),
        confirmation: body.confirmation,
      },
    );

    const result = await eraseUser(ctx.user.id, {
      ipHash: hashIp(ip),
      reason: body.reason ?? null,
    });

    // Withdraw the service consent — the terminal consent state.
    await recordConsent({ userId: ctx.user.id, purpose: "service", granted: false, ipHash: hashIp(ip) });

    const response = ok({ erased: true, ...result });
    // Clear both cookie names — erasing must not leave a usable session, and
    // an un-upgraded browser may still be holding the legacy one.
    for (const cleared of clearSessionCookieDescriptors()) {
      response.headers.append(
        "Set-Cookie",
        `${cleared.name}=${cleared.value}; Path=${cleared.options.path ?? "/"}; Max-Age=0; HttpOnly; SameSite=Lax`,
      );
    }
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}

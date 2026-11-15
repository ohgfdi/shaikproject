import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { hashIp, recordConsent, currentConsents, CONSENT_PURPOSES, type ConsentPurposeId } from "@/lib/server/dpdp";

const schema = z.object({
  purpose: z.enum(["service", "product-improvement", "marketing"]),
  granted: z.boolean(),
});

/**
 * GET /api/me/consent — current consent state per purpose + the itemized
 * purpose catalogue (so the settings UI can render descriptions and which
 * purposes are required).
 */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const state = await currentConsents(ctx.user.id);
    return ok({
      state,
      purposes: CONSENT_PURPOSES,
      // Note: CONSENT_POLICY_VERSION lives in lib/server/dpdp.ts and is stamped
      // on every new record; expose it so the UI can flag stale consents.
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/me/consent — grant or withdraw one purpose. Every call appends an
 * immutable ConsentRecord (the DPDP audit trail).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null;
    await recordConsent({
      userId: ctx.user.id,
      purpose: body.purpose as ConsentPurposeId,
      granted: body.granted,
      ipHash: hashIp(ip),
    });
    const state = await currentConsents(ctx.user.id);
    return ok({ state });
  } catch (err) {
    return toErrorResponse(err);
  }
}

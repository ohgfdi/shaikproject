import { createHash } from "node:crypto";
import { z } from "zod";

import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requestPortalLogin } from "@/lib/server/portal-auth";
import { RATE_LIMITS, clientIp, enforceRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().max(320) });

/**
 * POST — ask for a sign-in link. The answer is always `{ sent: true }` when the
 * link is valid, so this endpoint cannot be used to discover which client
 * emails are invited.
 */
export async function POST(request: Request, props: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await props.params;
    enforceRateLimit(request, "portal_login", RATE_LIMITS.portal_login);
    const body = schema.parse(await readJsonBody<unknown>(request));
    const ip = clientIp(request) ?? "unknown";
    await requestPortalLogin(token, body.email, createHash("sha256").update(ip).digest("hex"));
    return ok({ sent: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

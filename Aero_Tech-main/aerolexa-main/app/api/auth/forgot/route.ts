import { z } from "zod";

import { ok, toErrorResponse } from "@/lib/server/api";
import { requestPasswordReset } from "@/lib/server/auth-service";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/server/rate-limit";

const schema = z.object({ email: z.string().email() });

export async function POST(request: Request) {
  try {
    enforceRateLimit(request, "forgot", RATE_LIMITS.forgot);
    const { email } = schema.parse(await request.json());
    await requestPasswordReset(email);
    return ok({ sent: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

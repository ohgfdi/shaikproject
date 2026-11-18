import { requireAuth } from "@/lib/auth/guard";
import { validateLLMOutput, type CodeValidationOptions } from "@/lib/engine/llm/validate";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { moduleEnabledForRequest } from "@/lib/server/modules";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!(await moduleEnabledForRequest("LLM_ENABLED"))) {
      return ok({ ok: false, message: "LLM features are disabled on this server." }, { status: 403 });
    }

    // This route had no auth guard at all — it was reachable by any anonymous
    // caller and ran a parser over attacker-supplied source. It parses and
    // executes the submitted code's shape server-side, so it now requires a
    // session and a per-user budget.
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "llm_validate", RATE_LIMITS.llm_validate);

    const body = await readJsonBody<{
      code: string;
      options: CodeValidationOptions;
    }>(request);

    if (!body.code || !body.options) {
      return ok({ ok: false, message: "Code and options are required." }, { status: 400 });
    }

    const result = validateLLMOutput(body.code, body.options);
    return ok({ ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

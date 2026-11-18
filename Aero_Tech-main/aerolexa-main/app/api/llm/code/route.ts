import { requireAuth } from "@/lib/auth/guard";
import { generateCode, type NLToCodeRequest } from "@/lib/engine/llm/nl-to-code";
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
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "llm_generate", RATE_LIMITS.llm_generate);

    const body = await readJsonBody<NLToCodeRequest>(request);

    if (!body.request || !body.columns || !body.datasetName || !body.target) {
      return ok(
        { ok: false, message: "Missing required fields: request, columns, datasetName, target" },
        { status: 400 },
      );
    }

    const result = await generateCode(body);
    return ok({ ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}

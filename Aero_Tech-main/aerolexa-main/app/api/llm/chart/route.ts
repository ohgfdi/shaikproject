import { requireAuth } from "@/lib/auth/guard";
import { recommendCharts, recommendChartsWithLLM, type RecommendationRequest } from "@/lib/engine/llm/chart-recommend";
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

    const body = await readJsonBody<RecommendationRequest>(request);

    if (!body.columns?.length) {
      return ok({ ok: false, message: "Columns array is required." }, { status: 400 });
    }

    const useLLM = body.intent !== "overview" && (body.max ?? 5) > 3;
    const recommendations = useLLM ? await recommendChartsWithLLM(body) : recommendCharts(body);

    return ok({ ok: true, recommendations });
  } catch (err) {
    return toErrorResponse(err);
  }
}

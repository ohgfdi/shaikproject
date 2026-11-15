import { requireAuth } from "@/lib/auth/guard";
import { getLiveLLMProvider, resetLLMAvailabilityCache, resolveLLMConfig } from "@/lib/llm/providers";
import { ok, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/llm/status
 *
 * Reports — factually — how the copilot's live model is configured on this
 * deployment, and whether it is reachable right now. Never throws for a
 * missing configuration and never leaks the API key: the response distinguishes
 * only "configured" from "not configured".
 *
 *   configured: false → the UI shows the setup banner.
 *   reachable:  false → answers come from the deterministic engine; the UI
 *                       says so instead of implying a model is answering.
 *
 * Body: { configured, reachable, provider, model, source, hint }
 */
export async function GET() {
  try {
    await requireAuth();

    const cfg = resolveLLMConfig();
    const provider = getLiveLLMProvider();
    resetLLMAvailabilityCache();
    const reachable = provider ? ((await provider.probe?.()) ?? false) : false;

    let hint: string | null = null;
    if (!cfg.apiKeyConfigured) {
      hint = "No Claude key is configured. Set ANTHROPIC_API_KEY in the server environment, then restart.";
    } else if (!reachable) {
      hint =
        "ANTHROPIC_API_KEY is set, but the Anthropic API did not answer. Check the key, AI_MODEL_MAIN, and the server's network, then restart.";
    }

    return ok({
      configured: cfg.apiKeyConfigured,
      reachable,
      provider: cfg.kind,
      model: cfg.model,
      source: cfg.apiKeyConfigured ? cfg.source : "none",
      hint,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { requireAuth } from "@/lib/auth/guard";
import { defaultChatModelId, listChatModels } from "@/lib/llm/providers";
import { ok, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/chat/config — the selectable copilot models and the current default.
 * Probing is short and non-fatal; offline endpoints just mark options as
 * unreachable, so the picker still shows what is configured.
 */
export async function GET() {
  try {
    await requireAuth();
    const models = await listChatModels();
    return ok({ models, default: defaultChatModelId() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

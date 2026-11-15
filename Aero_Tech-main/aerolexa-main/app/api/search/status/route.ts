import { requireAuth } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";
import { ok, toErrorResponse } from "@/lib/server/api";
import { webSearchUsesGoogle } from "@/lib/web/search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/search/status
 *
 * Reports — factually — which web-search backend the copilot chat uses, so
 * the UI can show an honest "Google connected" badge instead of implying a
 * backend that is not there. Never leaks the key: the response distinguishes
 * only "configured" from "not configured".
 *
 *   backend: "google"      → GOOGLE_CSE_API_KEY + GOOGLE_CSE_ENGINE_ID set
 *   backend: "duckduckgo"  → free key-less fallback is answering
 *
 * Body: { backend: "google" | "duckduckgo", hint: string | null }
 */
export async function GET() {
  try {
    await requireAuth();

    const env = serverEnv();
    const google = webSearchUsesGoogle();
    const backend: "google" | "duckduckgo" = google ? "google" : "duckduckgo";

    let hint: string | null = null;
    if (!google) {
      const missing = [
        !env.GOOGLE_CSE_API_KEY ? "GOOGLE_CSE_API_KEY" : null,
        !env.GOOGLE_CSE_ENGINE_ID ? "GOOGLE_CSE_ENGINE_ID" : null,
      ]
        .filter((v): v is string => v !== null)
        .join(" and ");
      hint = `Web search currently uses the free DuckDuckGo fallback. For Google results set ${missing} in .env (free at programmablesearchengine.google.com), then restart.`;
    }

    return ok({ backend, hint });
  } catch (err) {
    return toErrorResponse(err);
  }
}

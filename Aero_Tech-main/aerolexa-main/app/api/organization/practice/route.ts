import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getPracticeOverview } from "@/lib/server/practice-overview";

export const dynamic = "force-dynamic";

/** GET /api/organization/practice — the partner dashboard across the firm's clients. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    return ok({ overview: await getPracticeOverview(ctx) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

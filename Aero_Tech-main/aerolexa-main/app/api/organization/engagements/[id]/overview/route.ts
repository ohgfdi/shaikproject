import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getEngagementOverview } from "@/lib/server/practice-overview";

export const dynamic = "force-dynamic";

/** GET /api/organization/engagements/[id]/overview — one client's operating picture. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok({ overview: await getEngagementOverview(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

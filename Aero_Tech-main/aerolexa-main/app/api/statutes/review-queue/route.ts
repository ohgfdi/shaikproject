import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getStatuteReviewQueue } from "@/lib/server/statute-review";

export const dynamic = "force-dynamic";

/** GET — notifications still awaiting a review decision. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    if (!ctx.workspace) throw new ApiError(400, "NO_WORKSPACE", "This account has no workspace.");
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return ok(await getStatuteReviewQueue(ctx.workspace.id, Number.isFinite(limit) ? limit : 50));
  } catch (err) {
    return toErrorResponse(err);
  }
}

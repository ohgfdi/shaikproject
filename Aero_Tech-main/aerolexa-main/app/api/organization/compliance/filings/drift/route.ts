import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireOrgRole } from "@/lib/server/members";
import { detectFirmDueDateDrift } from "@/lib/server/statute-drift";

export const dynamic = "force-dynamic";

/**
 * GET — stored vs freshly generated deadlines for every open filing run.
 *
 * Read-only: the detector reports the disagreement and the firm decides whether
 * to move a run (PATCH `move-due-date`). A profile that cannot be parsed is
 * counted, never guessed.
 */
export async function GET() {
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) {
      throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
    }
    await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
    return ok(await detectFirmDueDateDrift(ctx));
  } catch (err) {
    return toErrorResponse(err);
  }
}

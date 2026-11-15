import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getFilingPilotLedger } from "@/lib/server/filing-pilot";

export const dynamic = "force-dynamic";

/** GET — the firm's live-filing pilot ledger. */
export async function GET() {
  try {
    const ctx = await requireAuth();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
    }
    return ok(await getFilingPilotLedger(ctx));
  } catch (err) {
    return toErrorResponse(err);
  }
}

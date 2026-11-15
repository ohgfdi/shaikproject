import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getMonthlyComplianceReport } from "@/lib/server/compliance-report";

export const dynamic = "force-dynamic";

/** GET — one client-month compliance report for the firm. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const engagementId = url.searchParams.get("engagementId");
    if (!engagementId) {
      throw new ApiError(400, "VALIDATION", "Pass engagementId (and optionally month=yyyy-mm).");
    }
    return ok(
      await getMonthlyComplianceReport(ctx, {
        engagementId,
        month: url.searchParams.get("month") ?? undefined,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

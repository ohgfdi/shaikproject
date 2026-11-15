import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getPartnerDashboard } from "@/lib/server/partner-dashboard";

export const dynamic = "force-dynamic";

/** GET — utilisation, realisation, WIP, deadline risk and workload. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    return ok(await getPartnerDashboard(ctx, { today }));
  } catch (err) {
    return toErrorResponse(err);
  }
}

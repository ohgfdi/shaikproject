import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { listFirmDeliverables } from "@/lib/server/deliverables-hub";

export const dynamic = "force-dynamic";

/** GET /api/organization/deliverables — the firm-wide deliverable register. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const params = new URL(request.url).searchParams;
    return ok(
      await listFirmDeliverables(ctx, {
        engagementId: params.get("engagementId") ?? undefined,
        status: params.get("status") ?? undefined,
        formatCode: params.get("formatCode") ?? undefined,
        limit: params.get("limit") ? Number(params.get("limit")) : undefined,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

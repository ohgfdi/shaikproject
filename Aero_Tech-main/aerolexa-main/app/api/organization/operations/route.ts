import { requireAuth } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getFirmOperations } from "@/lib/server/operations";

export const dynamic = "force-dynamic";

/** GET /api/organization/operations — SLA breaches, aging and real workload. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    return ok(await getFirmOperations(ctx, { today }));
  } catch (err) {
    return toErrorResponse(err);
  }
}

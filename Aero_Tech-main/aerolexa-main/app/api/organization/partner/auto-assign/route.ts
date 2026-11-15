import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { autoAssignPreparers } from "@/lib/server/partner-dashboard";

export const dynamic = "force-dynamic";

/** POST — assign unowned `computed` runs to the least-loaded eligible member. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ limit?: number }>(request).catch(() => ({}) as { limit?: number });
    const limit = typeof body.limit === "number" ? body.limit : undefined;
    return ok({ assignment: await autoAssignPreparers(ctx, { limit }) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

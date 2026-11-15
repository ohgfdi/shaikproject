import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { reactiveRerunPlan } from "@/lib/engine/notebook-handoff";
import { parseJsonArray } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { enforceUserRateLimit, RATE_LIMITS } from "@/lib/server/rate-limit";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Reactive re-run plan for a parameter cell (ROADMAP 4.3).
 *
 * Changing a widget used to make the client recompute the cascade itself
 * (`downstreamOf`) and fire every dependent concurrently. This endpoint makes
 * the *server* plan authoritative: one implementation of the graph walk
 * (`reactiveRerunPlan`), so interactive, scheduled and API-triggered runs
 * cannot disagree about what a parameter change invalidates.
 *
 * Deliberately a pure read:
 *  - no dataset load and no execution, so it works before the first run and
 *    costs nothing beyond the notebook row;
 *  - it does NOT consume the `notebook_run` budget, which is reserved for
 *    actual compute — otherwise dragging a slider would burn the same bucket
 *    the real re-runs need and throttle the user out of their own cascade;
 *    the `notebook_plan` bucket is sized for drag frequency instead.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "notebook_plan", RATE_LIMITS.notebook_plan);

    const body = await readJsonBody<{ cellId?: string }>(request);
    const cellId = body.cellId;
    if (!cellId) throw new ApiError(400, "VALIDATION", "cellId is required.");

    const notebook = await prisma.notebook.findUnique({
      where: { id: params.id },
      select: { id: true, workspaceId: true, cells: true },
    });
    if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");
    // A read: VIEWER is enough to learn the plan. Executing the plan still
    // requires EDITOR, enforced on /run.
    await requireRowRole(ctx, notebook, "VIEWER");

    const cells = parseJsonArray<NotebookCell>(notebook.cells, []);
    return ok({ rerunCellIds: reactiveRerunPlan(cells, cellId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

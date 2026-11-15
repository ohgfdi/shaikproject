import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  completeChangeReview,
  getChangeRequestTimeline,
  implementChangeRequest,
  startReviewChangeRequest,
  submitChangeRequest,
} from "@/lib/server/governance";

export const dynamic = "force-dynamic";

type Action = "submit" | "review" | "approve" | "request-changes" | "reject" | "implement";

/** Full history of one change request, reconstructed from the ledger. */
export async function GET(_request: Request, props: { params: Promise<{ id: string; changeId: string }> }) {
  const { id, changeId } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await getChangeRequestTimeline(ctx, id, changeId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Advance a change request through its lifecycle. */
export async function PATCH(request: Request, props: { params: Promise<{ id: string; changeId: string }> }) {
  const { id, changeId } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ action?: Action; note?: string | null }>(request);
    const action = body.action;
    if (!action) throw new ApiError(400, "VALIDATION", "action is required.");

    switch (action) {
      case "submit": {
        return ok({ changeRequest: await submitChangeRequest(ctx, id, changeId) });
      }
      case "review": {
        return ok({ changeRequest: await startReviewChangeRequest(ctx, id, changeId) });
      }
      case "approve": {
        return ok({ changeRequest: await completeChangeReview(ctx, id, changeId, "approve", body.note) });
      }
      case "request-changes": {
        return ok({ changeRequest: await completeChangeReview(ctx, id, changeId, "request-changes", body.note) });
      }
      case "reject": {
        return ok({ changeRequest: await completeChangeReview(ctx, id, changeId, "reject", body.note) });
      }
      case "implement": {
        return ok({ changeRequest: await implementChangeRequest(ctx, id, changeId) });
      }
      default:
        throw new ApiError(400, "VALIDATION", `Unknown action “${String(action)}”.`);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

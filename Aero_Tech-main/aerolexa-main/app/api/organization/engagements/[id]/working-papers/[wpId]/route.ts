import { ApiError, requireAuth } from "@/lib/auth/guard";
import { sendEngagementNotification } from "@/lib/engine/compliance-notifications";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  addWorkingPaperVersion,
  archiveWorkingPaper,
  getWorkingPaper,
  reviewWorkingPaper,
  signOffWorkingPaper,
  submitWorkingPaper,
} from "@/lib/server/governance";

export const dynamic = "force-dynamic";

type Action = "revise" | "submit" | "review" | "sign-off" | "archive";

/** Working paper with its immutable version chain and ledger timeline. */
export async function GET(_request: Request, props: { params: Promise<{ id: string; wpId: string }> }) {
  const { id, wpId } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await getWorkingPaper(ctx, id, wpId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Advance a working paper through its lifecycle. */
export async function PATCH(request: Request, props: { params: Promise<{ id: string; wpId: string }> }) {
  const { id, wpId } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      action?: Action;
      content?: unknown;
      changeSummary?: string;
      approved?: boolean;
      note?: string | null;
    }>(request);
    const action = body.action;
    if (!action) throw new ApiError(400, "VALIDATION", "action is required.");

    switch (action) {
      case "revise": {
        if (body.content === undefined) throw new ApiError(400, "VALIDATION", "content is required to revise.");
        return ok({
          workingPaper: await addWorkingPaperVersion(ctx, id, wpId, {
            content: body.content,
            changeSummary: body.changeSummary ?? "",
          }),
        });
      }
      case "submit": {
        return ok({ workingPaper: await submitWorkingPaper(ctx, id, wpId) });
      }
      case "review": {
        const result = await reviewWorkingPaper(ctx, id, wpId, {
          approved: body.approved !== false,
          note: body.note,
        });
        // Send notification about the review action
        await sendEngagementNotification({
          engagementId: id,
          purpose: "review-update",
          title: "Working Paper Review Updated",
          message: result.title ? `Working paper ${result.title} review ${body.approved !== false ? "approved" : "rejected"}.` : "Working paper review updated.",
        });
        return ok({ workingPaper: result });
      }
      case "sign-off": {
        const result = await signOffWorkingPaper(ctx, id, wpId, body.note);
        // Send notification about the sign-off action
        await sendEngagementNotification({
          engagementId: id,
          purpose: "sign-off",
          title: "Working Paper Signed Off",
          message: result.title ? `Working paper ${result.title} signed off.` : "Working paper signed off.",
        });
        return ok({ workingPaper: result });
      }
      case "archive": {
        return ok({ workingPaper: await archiveWorkingPaper(ctx, id, wpId) });
      }
      default:
        throw new ApiError(400, "VALIDATION", `Unknown action “${String(action)}”.`);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

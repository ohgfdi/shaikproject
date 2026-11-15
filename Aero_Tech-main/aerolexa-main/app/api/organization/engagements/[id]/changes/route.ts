import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createChangeRequest, listChangeRequests } from "@/lib/server/governance";
import type { PracticeRole } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Change requests for an engagement (newest first). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok({ changeRequests: await listChangeRequests(ctx, id) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Raise a change request against client data or a working paper. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      title?: string;
      description?: string;
      rationale?: string;
      targetType?: string;
      targetId?: string | null;
      assignedToPracticeRole?: PracticeRole;
      signOffRequiredFor?: PracticeRole;
    }>(request);
    if (!body.title) throw new ApiError(400, "VALIDATION", "title is required.");
    const changeRequest = await createChangeRequest(ctx, id, {
      title: body.title,
      description: body.description,
      rationale: body.rationale,
      targetType: body.targetType ?? "clientData",
      targetId: body.targetId ?? null,
      assignedToPracticeRole: body.assignedToPracticeRole,
      signOffRequiredFor: body.signOffRequiredFor,
    });
    return ok({ changeRequest }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

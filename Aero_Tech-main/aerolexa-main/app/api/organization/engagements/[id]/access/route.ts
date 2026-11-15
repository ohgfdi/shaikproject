import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { grantEngagementAccess, listEngagementAccess, revokeEngagementAccess } from "@/lib/server/engagement";
import type { PracticeRole } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Who can act on this client engagement (assigned roles + firm-role fallbacks). */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await listEngagementAccess(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Assign an explicit practice role on this engagement (partner/manager). */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ userId?: string; practiceRole?: PracticeRole }>(request);
    if (!body.userId) throw new ApiError(400, "VALIDATION", "userId is required.");
    if (!body.practiceRole) throw new ApiError(400, "VALIDATION", "practiceRole is required.");
    const entry = await grantEngagementAccess(ctx, id, { userId: body.userId, practiceRole: body.practiceRole });
    return ok({ entry }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Remove an explicit assignment (?userId=...). The firm role then applies. */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const userId = new URL(request.url).searchParams.get("userId");
    if (!userId) throw new ApiError(400, "VALIDATION", "userId query parameter is required.");
    return ok(await revokeEngagementAccess(ctx, id, userId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

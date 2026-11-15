import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { archiveEngagement, updateEngagement } from "@/lib/server/organization";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      code?: string | null;
      gstin?: string | null;
      description?: string | null;
      status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
    }>(request);
    if (Object.keys(body).length === 0) throw new ApiError(400, "VALIDATION", "Nothing to update.");
    const engagement = await updateEngagement(ctx, params.id, body);
    return ok({ engagement });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const engagement = await archiveEngagement(ctx, params.id);
    return ok({ engagement });
  } catch (err) {
    return toErrorResponse(err);
  }
}

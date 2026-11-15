import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { removeOrganizationMember, updateOrganizationMember } from "@/lib/server/organization";
import type { OrganizationRole } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ role?: OrganizationRole }>(request);
    if (!body.role) throw new ApiError(400, "VALIDATION", "Role is required.");
    const member = await updateOrganizationMember(ctx, params.userId, body.role);
    return ok({ member });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const result = await removeOrganizationMember(ctx, params.userId);
    return ok(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

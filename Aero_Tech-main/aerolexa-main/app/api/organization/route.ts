import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createOrganization, getOrganizationSnapshot, updateOrganization } from "@/lib/server/organization";
import type { OrganizationSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireAuth();
    const org = await getOrganizationSnapshot(ctx);
    return ok({ organization: org });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ name?: string; gstin?: string; settings?: OrganizationSettings }>(request);
    const name = body.name;
    if (!name) throw new ApiError(400, "VALIDATION", "Organization name is required.");
    const org = await createOrganization(ctx, { name, gstin: body.gstin, settings: body.settings });
    return ok({ organization: org }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      gstin?: string | null;
      settings?: OrganizationSettings;
    }>(request);
    const org = await updateOrganization(ctx, body);
    return ok({ organization: org });
  } catch (err) {
    return toErrorResponse(err);
  }
}

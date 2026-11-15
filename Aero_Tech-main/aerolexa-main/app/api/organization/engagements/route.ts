import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createEngagement, listOrganizationEngagements } from "@/lib/server/organization";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireAuth();
    const engagements = await listOrganizationEngagements(ctx);
    return ok({ engagements });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      name?: string;
      code?: string;
      gstin?: string;
      description?: string;
      createProject?: boolean;
    }>(request);
    const name = body.name;
    if (!name) throw new ApiError(400, "VALIDATION", "Engagement name is required.");
    const result = await createEngagement(ctx, {
      name,
      code: body.code,
      gstin: body.gstin,
      description: body.description,
      createProject: body.createProject,
    });
    return ok(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

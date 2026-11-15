import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { inviteOrganizationMember, listOrgMembers } from "@/lib/server/organization";
import type { OrganizationRole } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireAuth();
    const members = await listOrgMembers(ctx);
    return ok({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ email?: string; role?: OrganizationRole }>(request);
    const member = await inviteOrganizationMember(ctx, {
      email: body.email ?? "",
      role: (body.role ?? "MEMBER") as OrganizationRole,
    });
    return ok({ member }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

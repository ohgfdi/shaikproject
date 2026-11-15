import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { fail, ok, toErrorResponse } from "@/lib/server/api";
import { deleteMappingProfile, getMappingProfile } from "@/lib/server/ca-source";

export const dynamic = "force-dynamic";

/**
 * GET /api/ca/mapping-profiles/[id]
 *
 * Retrieve one saved mapping profile by id.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await requireAuth();
    const profile = await getMappingProfile(params.id);
    if (!profile) return fail(404, "NOT_FOUND", "Mapping profile not found.");
    return ok({ profile });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ca/mapping-profiles/[id]
 *
 * Delete a saved mapping profile.
 */
export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    await requireAuth();
    const deleted = await deleteMappingProfile(params.id);
    if (!deleted) return fail(404, "NOT_FOUND", "Mapping profile not found.");
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

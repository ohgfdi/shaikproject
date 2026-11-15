import { NextRequest } from "next/server";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { orgPrivacySettings, updateOrgPrivacy, type UpdateOrgPrivacyInput } from "@/lib/server/engagement";
import { requireOrgRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/** The firm's privacy / retention posture (any firm member may read it). */
export async function GET() {
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) return ok({ privacy: null });
    await requireOrgRole(ctx, ctx.organization.id, "MEMBER");
    return ok({ privacy: orgPrivacySettings(ctx.organization.settings).privacy });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Update the firm's privacy / retention posture (ADMIN+). */
export async function PATCH(request: NextRequest) {
  try {
    const ctx = await requireAuth();
    if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
    const body = await readJsonBody<{ privacy?: Record<string, unknown> }>(request);
    const privacyInput = body?.privacy;
    if (!privacyInput || typeof privacyInput !== "object") {
      throw new ApiError(400, "VALIDATION", "privacy object is required.");
    }
    const input: UpdateOrgPrivacyInput = {
      panRedactionDefault: privacyInput.panRedactionDefault as boolean | undefined,
      fullDiffLoggingDefault: privacyInput.fullDiffLoggingDefault as boolean | undefined,
      taxpayerExportConsentRequired: privacyInput.taxpayerExportConsentRequired as boolean | undefined,
      retentionDays: privacyInput.retentionDays as number | null | undefined,
      autoArchiveEngagementDays: privacyInput.autoArchiveEngagementDays as number | null | undefined,
      crossBorderTransferAllowed: privacyInput.crossBorderTransferAllowed as boolean | undefined,
      requireClientConsentForExport: privacyInput.requireClientConsentForExport as boolean | undefined,
    };
    const privacy = await updateOrgPrivacy(ctx, input);
    return ok({ privacy });
  } catch (err) {
    return toErrorResponse(err);
  }
}

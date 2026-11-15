import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRetentionPolicy, engagementDataPosture } from "@/lib/server/data-controls";
import type { DataClassification } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Jurisdiction, classification, retention and artifact counts for a client. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await engagementDataPosture(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Update the retention posture (partner only; changes are ledger-recorded). */
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      jurisdiction?: string;
      legalHold?: boolean;
      retentionUntil?: string | null;
      dataClassification?: DataClassification;
      reason?: string;
    }>(request);
    if (!body.reason) throw new ApiError(400, "VALIDATION", "reason is required for a retention change.");
    const posture = await applyRetentionPolicy(ctx, id, {
      jurisdiction: body.jurisdiction,
      legalHold: body.legalHold,
      retentionUntil: body.retentionUntil,
      dataClassification: body.dataClassification,
      reason: body.reason,
    });
    return ok(posture);
  } catch (err) {
    return toErrorResponse(err);
  }
}

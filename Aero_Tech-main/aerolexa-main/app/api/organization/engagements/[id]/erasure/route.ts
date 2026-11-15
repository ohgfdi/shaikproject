import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { executeEngagementErasure, planEngagementErasure, requestEngagementErasure } from "@/lib/server/data-controls";

export const dynamic = "force-dynamic";

/** Whether the engagement may be erased, and what would be removed. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    return ok(await planEngagementErasure(ctx, id));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Request erasure (partner only): records the intent in the ledger. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ reason?: string }>(request);
    if (!body.reason) throw new ApiError(400, "VALIDATION", "reason is required.");
    return ok(await requestEngagementErasure(ctx, id, body.reason));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Execute erasure (partner only). Refused under a legal hold or an active
 * retention floor unless `overrideRetention` is set with a reason. The ledger
 * and consent proof are retained; `confirm` must match the name or code.
 */
export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ reason?: string; confirm?: string; overrideRetention?: boolean }>(request);
    if (!body.reason) throw new ApiError(400, "VALIDATION", "reason is required.");
    if (!body.confirm) throw new ApiError(400, "VALIDATION", "confirm is required.");
    return ok(
      await executeEngagementErasure(ctx, id, {
        reason: body.reason,
        confirm: body.confirm,
        overrideRetention: body.overrideRetention,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

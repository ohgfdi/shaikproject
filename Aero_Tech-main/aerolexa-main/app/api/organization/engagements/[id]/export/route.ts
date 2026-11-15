import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { exportEngagementPackage } from "@/lib/server/data-controls";

export const dynamic = "force-dynamic";

/**
 * Controlled export of an engagement's governance record. Consent, cross-border
 * and role checks run first; taxpayer identifiers are redacted unless a
 * partner/manager explicitly requests full values. The export itself is
 * recorded in the immutable ledger.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      reason?: string;
      targetJurisdiction?: string;
      includeIdentifiers?: boolean;
    }>(request);
    if (!body.reason) throw new ApiError(400, "VALIDATION", "reason is required for an export.");
    const pkg = await exportEngagementPackage(ctx, id, {
      reason: body.reason,
      targetJurisdiction: body.targetJurisdiction,
      includeIdentifiers: body.includeIdentifiers,
    });
    return ok(pkg);
  } catch (err) {
    return toErrorResponse(err);
  }
}

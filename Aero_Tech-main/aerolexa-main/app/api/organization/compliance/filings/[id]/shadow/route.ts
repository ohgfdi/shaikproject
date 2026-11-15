import { ApiError, requireAuth } from "@/lib/auth/guard";
import { filingChannel, filingGatewayHealth } from "@/lib/engine/filing/gateway";
import { buildFilingShadowPlan } from "@/lib/engine/filing/shadow";
import { filingSigningReadiness } from "@/lib/engine/filing/signing-service";
import { ok, toErrorResponse } from "@/lib/server/api";
import { withTenantDb } from "@/lib/server/tenant-db";

export const dynamic = "force-dynamic";

/**
 * GET — what a live submission of this run would look like, without sending it.
 * No gateway call, no state change: this is a dry plan for the operator.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
    }

    const run = await withTenantDb(ctx, (db) =>
      db.complianceFilingRun.findFirst({
        where: { id, organizationId },
        select: {
          id: true,
          taskId: true,
          title: true,
          authority: true,
          dueDate: true,
          stage: true,
          engagement: { select: { name: true } },
        },
      }),
    );
    if (!run) throw new ApiError(404, "NOT_FOUND", "Filing run not found.");

    const health = filingGatewayHealth();
    const channel = filingChannel();
    const availability = health.channels[channel];
    const signing = filingSigningReadiness();

    return ok(
      buildFilingShadowPlan({
        channel,
        provider: health.provider,
        token: run.id,
        payload: {
          runId: run.id,
          taskId: run.taskId,
          title: run.title,
          authority: run.authority,
          dueDate: run.dueDate,
          engagement: run.engagement.name,
        },
        providerConfigured: Boolean(availability?.configured),
        missingCredentials: availability?.missing ?? [],
        signingRequired: channel === "efiling-audit",
        signingConfigured: signing.configured,
      }),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

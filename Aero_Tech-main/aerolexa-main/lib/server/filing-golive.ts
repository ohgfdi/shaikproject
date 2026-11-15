/**
 * Server half of go-live readiness: collect the facts, assess them, and make
 * promotion refuse a client that is not ready. An explicit override is allowed
 * but must carry a note, so the reason survives in the rollout row.
 *
 * Evidence reads run through withTenantDb() so filing tables can be protected
 * by PostgreSQL RLS once the whole query layer is wrapped.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import { assessGoLive, type GoLiveAssessment } from "@/lib/engine/filing/go-live";
import { filingSigningReadiness } from "@/lib/engine/filing/signing-service";
import { requireEngagementRole } from "@/lib/server/engagement";
import { getFilingRollout, setFilingRollout, type FilingRolloutView } from "@/lib/server/filing-rollout";
import { withTenantDb } from "@/lib/server/tenant-db";

export interface FilingGoLiveView {
  assessment: GoLiveAssessment;
  rollout: FilingRolloutView;
  provider: string;
  channel: string;
}

export async function getFilingGoLive(ctx: AuthContext, engagementId: string): Promise<FilingGoLiveView> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }

  const [rollout, runs] = await Promise.all([
    getFilingRollout(ctx, engagementId),
    withTenantDb(ctx, (db) =>
      db.complianceFilingRun.findMany({
        where: { organizationId, engagementId, filedAt: { not: null } },
        select: { verificationStatus: true },
        take: 500,
      }),
    ),
  ]);

  const health = filingGatewayHealth();
  const channel = health.activeChannel === "none" ? "irp-irn" : health.activeChannel;
  const availability = health.channels[channel];
  const signing = filingSigningReadiness();

  const assessment = assessGoLive({
    provider: health.provider,
    channel,
    channelConfigured: Boolean(availability?.configured),
    missingCredentials: availability?.missing ?? [],
    signingRequired: channel === "efiling-audit",
    signingConfigured: signing.configured,
    filedRuns: runs.length,
    verifiedRuns: runs.filter((run) => run.verificationStatus === "verified").length,
  });

  return { assessment, rollout, provider: health.provider, channel };
}

/**
 * Promote one client. Refuses when a blocking prerequisite is missing unless
 * `override` is set with a note; the assessment travels in the error details so
 * the UI can show exactly what is missing.
 */
export async function promoteFilingClient(
  ctx: AuthContext,
  engagementId: string,
  input: { note?: string | null; override?: boolean },
): Promise<FilingRolloutView> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!ctx.organization || ctx.organization.id !== engagement.organizationId) {
    throw new ApiError(403, "FORBIDDEN", "This client belongs to a different organization.");
  }

  const view = await getFilingGoLive(ctx, engagement.id);
  if (!view.assessment.eligible && !input.override) {
    throw new ApiError(409, "FILING_GO_LIVE_BLOCKED", view.assessment.summary, {
      assessment: view.assessment,
      howToFix:
        "Resolve the blocking items, run the conformance check, then promote. An override requires a written note.",
    });
  }
  if (!view.assessment.eligible && input.override && !input.note?.trim()) {
    throw new ApiError(
      400,
      "OVERRIDE_NOTE_REQUIRED",
      "Promoting with unresolved blockers requires a note explaining why.",
    );
  }

  return setFilingRollout(ctx, engagement.id, {
    mode: "live",
    note: input.override ? `OVERRIDE: ${input.note?.trim()}` : (input.note ?? null),
  });
}

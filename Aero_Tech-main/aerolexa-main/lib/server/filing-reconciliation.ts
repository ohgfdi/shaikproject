/**
 * Filing acknowledgement reconciliation — proving what actually happened after
 * a return left the building.
 *
 * `submitFilingRun` records whatever the portal said at submission time. That
 * is not the same as a verified filing: a return can be rejected later, an
 * acknowledgement can arrive after the initial response, and an offline
 * provider cannot be queried at all. This module closes that gap and is explicit
 * about the three outcomes:
 *
 *  - verified     — the live portal returned an acknowledgement for this run.
 *  - defective    — the portal rejected it after submission; the firm is alerted.
 *  - unverifiable — the active provider is reference/simulation (or the live
 *                   gateway exposes no status endpoint). This is recorded, never
 *                   silently treated as success.
 *
 * Dedupe is the append-only filing event log plus a conditional update on
 * `verificationStatus`, so restarts and multiple replicas cannot double-notify.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { withTenantDb } from "@/lib/server/tenant-db";
import { prisma } from "@/lib/db";
import { filingChannel, filingProviderKind, resolveFilingGateway } from "@/lib/engine/filing/gateway";
import type { FilingReceipt } from "@/lib/engine/filing/types";
import { notify } from "@/lib/server/activity";
import { requireEngagementRole } from "@/lib/server/engagement";
import { filingSubmissionPayload } from "@/lib/server/filing-runs";

export const RECONCILE_AFTER_MS = 10 * 60 * 1000;

export type VerificationStatus = "unverified" | "verified" | "unverifiable" | "defective";

export interface VerificationVerdict {
  status: VerificationStatus;
  note: string;
}

/**
 * Map the portal's post-submission receipt to our verification state. A receipt
 * without an acknowledgement is NOT success: live portals that accept but have
 * not acknowledged yet stay unverified and are retried.
 */
export function verdictFromReceipt(
  receipt: Pick<FilingReceipt, "status" | "ackNumber" | "portalMessage">,
  provider: string,
): VerificationVerdict {
  if (receipt.status === "rejected" || receipt.status === "error") {
    return {
      status: "defective",
      note:
        receipt.portalMessage?.trim() ||
        `The portal marked this submission ${receipt.status}. Correct the return and re-file.`,
    };
  }
  if (receipt.ackNumber) {
    return { status: "verified", note: `Portal acknowledgement ${receipt.ackNumber}.` };
  }
  if (receipt.status === "accepted-pending") {
    return { status: "unverified", note: "The portal accepted the submission; the acknowledgement is still pending." };
  }
  if (provider !== "live") {
    return {
      status: "unverifiable",
      note: `The ${provider} provider cannot be queried after submission; the acknowledgement is unverified.`,
    };
  }
  return { status: "unverified", note: "The portal returned no acknowledgement; this run will be checked again." };
}

/** Only a filed run that is old enough and not already settled is checked. */
export function shouldReconcile(
  run: { stage: string; filedAt: Date | null; verificationStatus: string },
  now: Date,
): boolean {
  if (run.stage !== "filed") return false;
  if (run.verificationStatus === "verified" || run.verificationStatus === "defective") return false;
  if (!run.filedAt) return false;
  return now.getTime() - run.filedAt.getTime() >= RECONCILE_AFTER_MS;
}

export function verificationMarker(status: VerificationStatus, note: string): string {
  return `verification:${status}:${note.slice(0, 120)}`;
}

export interface ReconciliationResult {
  checked: number;
  verified: number;
  defective: number;
  unverifiable: number;
}

async function owners(ctx: AuthContext, organizationId: string): Promise<string[]> {
  const members = await withTenantDb(ctx, (db) =>
    db.organizationMember.findMany({
      where: { organizationId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
      take: 25,
    }),
  );
  return members.map((member) => member.userId);

/**
 * Apply a verdict to one run. The update is conditional on the run still being
 * `unverified`, so two replicas reconciling the same run produce one event and
 * one notification.
 */
async function applyVerdict(
  run: {
    id: string;
    organizationId: string;
    engagementId: string;
    taskId: string;
    title: string;
    stage: string;
    acknowledgementReference: string | null;
    assigneeId: string | null;
    engagement: { name: string };
  },
  verdict: VerificationVerdict,
  provider: string,
): Promise<boolean> {
  const acknowledged = verdict.status === "verified";
  const reference = acknowledged ? extractAcknowledgement(verdict.note) : null;
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();

  const claimed = await withTenantDb(ctx, (db) => db.$transaction(async (tx) => {
    const update = await tx.complianceFilingRun.updateMany({
      where: { id: run.id, verificationStatus: "unverified" },
      data: {
        verificationStatus: verdict.status,
        verificationNote: verdict.note.slice(0, 1000),
        verifiedAt: now,
        ...(acknowledged && reference
          ? { stage: "acknowledged", acknowledgementReference: reference, acknowledgedAt: now }
          : {}),
        ...(verdict.status === "defective" ? { blockedReason: verdict.note.slice(0, 1000) } : {}),
      },
    });
    if (update.count !== 1) return false;

    await tx.complianceFilingEvent.create({
      data: {
        runId: run.id,
        organizationId: run.organizationId,
        fromStage: run.stage,
        toStage: acknowledged ? "acknowledged" : run.stage,
        note: verificationMarker(verdict.status, verdict.note),
        actorId: `system:verification:${provider}`,
      },
    });

    if (acknowledged && reference) {
      await tx.clientComplianceStatus.upsert({
        where: { engagementId_taskId: { engagementId: run.engagementId, taskId: run.taskId } },
        create: {
          organizationId: run.organizationId,
          engagementId: run.engagementId,
          taskId: run.taskId,
          status: "filed",
          filedOn: today,
          reference,
          updatedById: `system:verification:${provider}`,
        },
        update: { status: "filed", filedOn: today, reference, updatedById: `system:verification:${provider}` },
      });
    }
    return true;
  });

  if (!claimed) return false;

  if (verdict.status === "defective" || verdict.status === "verified") {
    const title =
      verdict.status === "defective" ? `Filing marked defective: ${run.title}` : `Filing acknowledged: ${run.title}`;
    const message = `${run.engagement.name} — ${verdict.note}`;
    const recipients = new Set<string>();
    if (run.assigneeId) recipients.add(run.assigneeId);
    for (const userId of await owners(run.organizationId)) recipients.add(userId);
    for (const userId of recipients) {
      await notify(userId, { type: "system", title, message }).catch(() => undefined);
    }
  }

  return true;
}

/** The acknowledgement token embedded in the human note (last word). */
function extractAcknowledgement(note: string): string | null {
  const match = /acknowledgement\s+(\S+?)\.?$/i.exec(note.trim());
  return match?.[1] ?? null;
}

/**
 * Reconcile every filed run that is old enough to check.
 *
 * Offline providers are marked unverifiable — once — rather than sending a
 * `status` call that does not exist or claiming the portal confirmed anything.
 */
export async function reconcileFilingAcknowledgements(now: Date = new Date()): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { checked: 0, verified: 0, defective: 0, unverifiable: 0 };
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);
  const provider = filingProviderKind();

  const runs = await withTenantDb(ctx, (db) =>
    db.complianceFilingRun.findMany({
      where: { stage: "filed", filedAt: { lte: cutoff }, verificationStatus: "unverified" },
      select: {
        id: true,
        organizationId: true,
        engagementId: true,
        taskId: true,
        title: true,
        authority: true,
        dueDate: true,
        stage: true,
        acknowledgementReference: true,
        assigneeId: true,
        filedAt: true,
        verificationStatus: true,
        engagement: { select: { name: true } },
      },
      orderBy: { filedAt: "asc" },
      take: 200,
    }),
  );
  if (runs.length === 0) return result;

  if (provider !== "live") {
    for (const run of runs) {
      result.checked += 1;
      const applied = await applyVerdict(
        run,
        {
          status: "unverifiable",
          note: `The ${provider} provider cannot be queried after submission; the acknowledgement is unverified.`,
        },
        provider,
      );
      if (applied) result.unverifiable += 1;
    }
    return result;
  }

  let gateway;
  try {
    gateway = resolveFilingGateway();
  } catch (err) {
    const note = err instanceof Error ? err.message : "The live filing gateway is not configured.";
    for (const run of runs) {
      result.checked += 1;
      if (await applyVerdict(run, { status: "unverifiable", note }, provider)) result.unverifiable += 1;
    }
    return result;
  }

  if (!gateway.status) {
    for (const run of runs) {
      result.checked += 1;
      const applied = await applyVerdict(
        run,
        { status: "unverifiable", note: "The live gateway does not expose a status endpoint for this channel." },
        provider,
      );
      if (applied) result.unverifiable += 1;
    }
    return result;
  }

  for (const run of runs) {
    if (!shouldReconcile(run, now)) continue;
    result.checked += 1;
    try {
      const receipt = await gateway.status({
        channel: filingChannel(),
        payload: filingSubmissionPayload(run),
        token: run.id,
      });
      const verdict = verdictFromReceipt(receipt, provider);
      if (await applyVerdict(run, verdict, provider)) {
        if (verdict.status === "verified") result.verified += 1;
        else if (verdict.status === "defective") result.defective += 1;
        else if (verdict.status === "unverifiable") result.unverifiable += 1;
      }
    } catch (err) {
      // Transport failure: leave the run unverified so the next pass retries.
      void err;
    }
  }

  return result;
}

/**
 * Manual verification for one run, from the filing board. Used when a partner
 * wants the answer now rather than waiting for the next scheduler pass.
 */
export async function verifyFilingRunNow(
  ctx: AuthContext,
  runId: string,
): Promise<{ runId: string; verificationStatus: VerificationStatus; note: string; provider: string }> {
  if (!ctx.organization) throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  const run = await withTenantDb(ctx, (db) =>
    db.complianceFilingRun.findFirst({
      where: { id: runId, organizationId: ctx.organization.id },
      include: { engagement: { select: { name: true } } },
    }),
  );
  if (!run) throw new ApiError(404, "NOT_FOUND", "Filing run not found.");
  await requireEngagementRole(ctx, run.engagementId, "MANAGER");
  if (run.stage !== "filed") {
    throw new ApiError(409, "INVALID_TRANSITION", "Only a filed run can be verified.");
  }

  const provider = filingProviderKind();
  const settle = async (verdict: VerificationVerdict) => {
    await applyVerdict(run, verdict, provider);
    return { runId: run.id, verificationStatus: verdict.status, note: verdict.note, provider };
  };

  if (provider !== "live") {
    return settle({
      status: "unverifiable",
      note: `The ${provider} provider cannot be queried after submission; the acknowledgement is unverified.`,
    });
  }

  let gateway;
  try {
    gateway = resolveFilingGateway();
  } catch (err) {
    return settle({
      status: "unverifiable",
      note: err instanceof Error ? err.message : "The live filing gateway is not configured.",
    });
  }
  if (!gateway.status) {
    return settle({
      status: "unverifiable",
      note: "The live gateway does not expose a status endpoint for this channel.",
    });
  }

  let receipt;
  try {
    receipt = await gateway.status({
      channel: filingChannel(),
      payload: filingSubmissionPayload(run),
      token: run.id,
    });
  } catch (err) {
    return settle({
      status: "unverified",
      note: `The portal could not be reached (${err instanceof Error ? err.message : "network fault"}). The run stays unverified.`,
    });
  }
  return settle(verdictFromReceipt(receipt, provider));
}

/**
 * Live-filing pilot ledger.
 *
 * `filing-certification.ts` answers "may this deployment claim certification?"
 * and `filing-certify.ts` proves one attempt. Neither shows the operator the
 * path between them: which channel is configured, what is missing, how many
 * live submissions exist, and whether any acknowledgement has been reconciled.
 *
 * This module assembles that view from the same facts (gateway health + stored
 * runs). It never invents a filing and never treats configuration as proof: a
 * channel with complete credentials but no reconciled submission is still a
 * pilot, and the ledger says so.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import type { FilingGatewayHealth } from "@/lib/engine/filing/types";
import { withTenantDb } from "@/lib/server/tenant-db";

export type PilotVerdict = "simulation" | "pilot" | "certified";

export interface PilotChannel {
  channel: string;
  active: boolean;
  configured: boolean;
  missing: string[];
  liveSubmissions: number;
  verifiedFilings: number;
}

export interface PilotRun {
  id: string;
  taskId: string;
  title: string;
  clientName: string;
  filedAt: string | null;
  provider: string | null;
  acknowledgementReference: string | null;
  verificationStatus: string;
}

export interface FilingPilotLedger {
  provider: string;
  activeChannel: string;
  verdict: PilotVerdict;
  channels: PilotChannel[];
  recent: PilotRun[];
  totals: { liveSubmissions: number; verifiedFilings: number; simulatedSubmissions: number };
  /** The exact next step, in order, with nothing to infer. */
  nextActions: string[];
  summary: string;
}

/** Evidence shape the pure builder needs; injected so it is testable. */
export interface PilotEvidence {
  runs: Array<{
    id: string;
    taskId: string;
    title: string;
    clientName: string;
    filedAt: Date | null;
    provider: string | null;
    acknowledgementReference: string | null;
    verificationStatus: string;
  }>;
}

/**
 * Pure ledger builder. `health.channels` is the source of truth for what the
 * environment claims; `runs` is the source of truth for what was actually
 * transmitted.
 */
export function buildPilotLedger(health: FilingGatewayHealth, evidence: PilotEvidence): FilingPilotLedger {
  const liveRuns = evidence.runs.filter((run) => run.provider === "live");
  const verifiedRuns = liveRuns.filter((run) => run.verificationStatus === "verified");
  const live = health.provider === "live";

  const channels: PilotChannel[] = Object.entries(health.channels).map(([channel, availability]) => ({
    channel,
    active: channel === health.activeChannel,
    configured: Boolean(availability?.configured),
    missing: [...(availability?.missing ?? [])],
    // A stored receipt names the provider, not which channel produced it, so
    // attributing every run to every channel would invent a per-channel count.
    // Only the active channel carries the totals.
    liveSubmissions: channel === health.activeChannel ? liveRuns.length : 0,
    verifiedFilings: channel === health.activeChannel ? verifiedRuns.length : 0,
  }));

  const active = channels.find((channel) => channel.active) ?? null;
  const verdict: PilotVerdict = !live
    ? "simulation"
    : active?.configured && liveRuns.length > 0 && verifiedRuns.length > 0
      ? "certified"
      : "pilot";

  const nextActions: string[] = [];
  if (!live) {
    nextActions.push(
      "Set FILING_GATEWAY=live (with the active channel's credentials) — nothing today leaves the building.",
    );
  }
  if (!active) {
    nextActions.push("Set FILING_CHANNEL to irp-irn, efiling-return or efiling-audit.");
  } else if (!active.configured) {
    nextActions.push(
      `Add the missing ${active.channel} credentials: ${active.missing.join(", ") || "see the go-live runbook"}.`,
    );
  }
  if (live && active?.configured && liveRuns.length === 0) {
    nextActions.push(
      "Run `npm run filing:conformance`, file one sandbox return, then one controlled production filing.",
    );
  }
  if (liveRuns.length > 0 && verifiedRuns.length === 0) {
    nextActions.push("Reconcile the latest acknowledgement against the portal; until then the filing is only a pilot.");
  }
  if (verdict === "certified") {
    nextActions.push("Keep reconciling every live filing; certification is evidence, not a one-time switch.");
  }

  const summary =
    verdict === "certified"
      ? `${verifiedRuns.length} reconciled live filing${verifiedRuns.length === 1 ? "" : "s"} on ${health.activeChannel}.`
      : verdict === "pilot"
        ? "Live credentials are configured but no reconciled live filing exists yet — the next filing is a controlled pilot."
        : "The gateway is offline; receipts are deterministic and explicitly not transmitted.";

  return {
    provider: health.provider,
    activeChannel: health.activeChannel,
    verdict,
    channels,
    recent: evidence.runs.slice(0, 25).map((run) => ({
      id: run.id,
      taskId: run.taskId,
      title: run.title,
      clientName: run.clientName,
      filedAt: run.filedAt ? run.filedAt.toISOString() : null,
      provider: run.provider,
      acknowledgementReference: run.acknowledgementReference,
      verificationStatus: run.verificationStatus,
    })),
    totals: {
      liveSubmissions: liveRuns.length,
      verifiedFilings: verifiedRuns.length,
      simulatedSubmissions: evidence.runs.length - liveRuns.length,
    },
    nextActions,
    summary,
  };
}

function providerOf(proof: unknown): string | null {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return null;
  const receipt = (proof as { receipt?: unknown }).receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  const provider = (receipt as { provider?: unknown }).provider;
  return typeof provider === "string" ? provider : null;
}

/** Read one firm's pilot evidence. The gateway checklist is deployment-wide. */
export async function getFilingPilotLedger(ctx: AuthContext): Promise<FilingPilotLedger> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }
  const rows = await withTenantDb(ctx, (db) =>
    db.complianceFilingRun.findMany({
      where: { organizationId, filedAt: { not: null } },
      select: {
        id: true,
        taskId: true,
        title: true,
        filedAt: true,
        acknowledgementReference: true,
        verificationStatus: true,
        proofBundle: true,
        engagement: { select: { name: true } },
      },
      orderBy: { filedAt: "desc" },
      take: 200,
    }),
  );

  return buildPilotLedger(filingGatewayHealth(), {
    runs: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      title: row.title,
      clientName: row.engagement.name,
      filedAt: row.filedAt,
      provider: providerOf(row.proofBundle),
      acknowledgementReference: row.acknowledgementReference,
      verificationStatus: row.verificationStatus,
    })),
  });
}

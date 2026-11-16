/**
 * Filing certification — the difference between "the gateway is implemented"
 * and "this deployment has actually filed a return and kept the proof".
 *
 * The go-live runbook is an operator procedure; this module turns the same
 * facts into a checklist the app can show. It never claims more than it can
 * prove:
 *
 *  - `simulation` / `reference` never transmit, so the verdict cannot rise
 *    above simulation no matter how many local receipts exist;
 *  - a live gateway with valid credentials is only a *pilot* until a real
 *    submission and a reconciled acknowledgement exist;
 *  - `certified` requires live submissions whose stored proof bundle names the
 *    live provider and whose acknowledgement reconciliation passed.
 *
 * The handshake step is deliberately `pending` from env alone: only the portal
 * can prove credentials work, and the app must not imply a preflight ran when
 * it did not. A successful live submission flips it to `done`.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - filing certification is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { filingGatewayHealth } from "@/lib/engine/filing/gateway";
import type { FilingGatewayHealth } from "@/lib/engine/filing/types";

export type CertificationState = "done" | "blocked" | "pending" | "not-applicable";

export interface CertificationStep {
  id: string;
  label: string;
  state: CertificationState;
  detail: string;
}

export type CertificationVerdict = "simulation" | "pilot" | "certified";

export interface FilingCertification {
  provider: string;
  activeChannel: string;
  verdict: CertificationVerdict;
  steps: CertificationStep[];
  /** Filed runs whose stored proof bundle names the live provider. */
  liveSubmissions: number;
  /** Live runs whose acknowledgement reconciliation passed. */
  verifiedFilings: number;
  lastLiveFilingAt: string | null;
  /** One sentence an operator can put in a handover note. */
  summary: string;
}

export interface CertificationEvidence {
  liveSubmissions: number;
  verifiedFilings: number;
  lastLiveFilingAt: string | null;
}

/** Pure checklist builder — no env reads, no I/O, oracle-testable. */
export function buildFilingCertification(
  health: FilingGatewayHealth,
  evidence: CertificationEvidence,
): FilingCertification {
  const live = health.provider === "live";
  const channel = health.activeChannel;
  const availability = channel === "none" ? null : health.channels[channel];
  const credentialsOk = Boolean(availability?.configured);
  const missing = availability?.missing ?? [];
  const submittedLive = evidence.liveSubmissions > 0;

  const steps: CertificationStep[] = [
    {
      id: "provider",
      label: "Live gateway selected",
      state: live ? "done" : "blocked",
      detail: live
        ? "FILING_GATEWAY=live — submissions go to the portal."
        : `Provider is “${health.provider}”. Nothing is transmitted until FILING_GATEWAY=live.`,
    },
    {
      id: "credentials",
      label: "Active channel credentials complete",
      state: channel === "none" ? "blocked" : credentialsOk ? "done" : "blocked",
      detail:
        channel === "none"
          ? "No FILING_CHANNEL is selected."
          : credentialsOk
            ? `All credentials for ${channel} are present.`
            : `Missing for ${channel}: ${missing.join(", ")}.`,
    },
    {
      id: "handshake",
      label: "Portal credential handshake proven",
      state: submittedLive ? "done" : live && credentialsOk ? "pending" : "blocked",
      detail: submittedLive
        ? "A live submission completed, which proves the handshake end to end."
        : "Run the credential preflight from the GST filing panel; it authorises without filing anything.",
    },
    {
      id: "first-submission",
      label: "First live submission recorded",
      state: submittedLive ? "done" : "pending",
      detail: submittedLive
        ? `${evidence.liveSubmissions} live submission${evidence.liveSubmissions === 1 ? "" : "s"} stored with a proof bundle.`
        : "No stored proof bundle reports the live provider yet.",
    },
    {
      id: "reconciliation",
      label: "Acknowledgement reconciled against the portal",
      state: evidence.verifiedFilings > 0 ? "done" : submittedLive ? "pending" : "blocked",
      detail:
        evidence.verifiedFilings > 0
          ? `${evidence.verifiedFilings} live filing${evidence.verifiedFilings === 1 ? "" : "s"} verified.`
          : submittedLive
            ? "A live submission exists but its acknowledgement has not been verified yet."
            : "Reconciliation runs after the first live submission.",
    },
  ];

  const verdict: CertificationVerdict = !live
    ? "simulation"
    : credentialsOk && submittedLive && evidence.verifiedFilings > 0
      ? "certified"
      : "pilot";

  const summary =
    verdict === "certified"
      ? `Live ${channel} filing is certified by stored evidence (last filed ${evidence.lastLiveFilingAt ?? "unknown"}).`
      : verdict === "pilot"
        ? "Live gateway is configured, but no reconciled live filing has been proven yet. Treat the next filing as a controlled pilot."
        : "This deployment is offline. Receipts are deterministic and explicitly marked as not transmitted.";

  return {
    provider: health.provider,
    activeChannel: channel,
    verdict,
    steps,
    liveSubmissions: evidence.liveSubmissions,
    verifiedFilings: evidence.verifiedFilings,
    lastLiveFilingAt: evidence.lastLiveFilingAt,
    summary,
  };
}

type StoredProof = { receipt?: { provider?: string } } | null;

/**
 * Read the deployment's (or one firm's) filing evidence. Scoping by
 * organization keeps a firm from seeing another firm's volumes; the operator
 * checklist itself is a deployment property.
 */
export async function getFilingCertification(organizationId: string | null = null): Promise<FilingCertification> {
  const health = filingGatewayHealth();
  const runs = await prisma.complianceFilingRun.findMany({
    where: {
      ...(organizationId ? { organizationId } : {}),
      filedAt: { not: null },
    },
    select: { proofBundle: true, verificationStatus: true, filedAt: true },
    orderBy: { filedAt: "desc" },
    take: 500,
  });

  const liveRuns = runs.filter((run) => {
    const proof = run.proofBundle as StoredProof;
    return proof?.receipt?.provider === "live";
  });
  const verified = liveRuns.filter((run) => run.verificationStatus === "verified");
  const lastLive = liveRuns[0]?.filedAt ?? null;

  return buildFilingCertification(health, {
    liveSubmissions: liveRuns.length,
    verifiedFilings: verified.length,
    lastLiveFilingAt: lastLive ? lastLive.toISOString() : null,
  });
}

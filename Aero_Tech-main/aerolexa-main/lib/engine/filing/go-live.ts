/**
 * Go-live readiness for one client.
 *
 * Promotion should be an evidence-backed decision, not a switch. This pure
 * assessment names every blocking prerequisite (live gateway, channel
 * credentials, required DSC signing) and separates warnings (a live filing that
 * has not been reconciled) from blockers. It never contacts a portal.
 */

import type { ProviderKind } from "./types";

export interface GoLiveFacts {
  provider: ProviderKind;
  channel: string;
  channelConfigured: boolean;
  missingCredentials: readonly string[];
  signingRequired: boolean;
  signingConfigured: boolean;
  /** Filed runs for this client (any provider). */
  filedRuns: number;
  /** Filed runs whose acknowledgement was reconciled. */
  verifiedRuns: number;
}

export interface GoLiveItem {
  id: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

export interface GoLiveAssessment {
  eligible: boolean;
  items: GoLiveItem[];
  blockers: string[];
  warnings: string[];
  summary: string;
}

export function assessGoLive(facts: GoLiveFacts): GoLiveAssessment {
  const items: GoLiveItem[] = [
    {
      id: "gateway",
      label: "Live filing gateway selected",
      ok: facts.provider === "live",
      blocking: true,
      detail:
        facts.provider === "live"
          ? "FILING_GATEWAY=live: submissions would reach the portal."
          : `FILING_GATEWAY is "${facts.provider}"; a promotion cannot produce a portal acknowledgement until it is live.`,
    },
    {
      id: "credentials",
      label: `${facts.channel} credentials complete`,
      ok: facts.channelConfigured,
      blocking: true,
      detail: facts.channelConfigured
        ? "Every credential required by the active channel is present."
        : `Missing: ${facts.missingCredentials.join(", ") || "unknown"}.`,
    },
    {
      id: "signing",
      label: "DSC signing ready when required",
      ok: !facts.signingRequired || facts.signingConfigured,
      blocking: true,
      detail: facts.signingRequired
        ? facts.signingConfigured
          ? "This channel requires a detached signature and the signing service is configured."
          : "This channel requires a detached signature but no signing service is configured."
        : "This channel does not require a detached DSC signature.",
    },
    {
      id: "reconciliation",
      label: "Live evidence reconciled",
      ok: facts.filedRuns === 0 || facts.verifiedRuns > 0,
      blocking: false,
      detail:
        facts.filedRuns === 0
          ? "No live filing yet: the first submission after promotion is the canary and must be reconciled before the next client is promoted."
          : facts.verifiedRuns > 0
            ? `${facts.verifiedRuns} of ${facts.filedRuns} live filing(s) are reconciled.`
            : `${facts.filedRuns} live filing(s) exist and none is reconciled — reconcile the acknowledgement before treating this client as certified.`,
    },
  ];

  const blockers = items
    .filter((item) => item.blocking && !item.ok)
    .map((item) => `${item.label}: ${item.detail}`);
  const warnings = items
    .filter((item) => !item.blocking && !item.ok)
    .map((item) => `${item.label}: ${item.detail}`);
  const eligible = blockers.length === 0;

  return {
    eligible,
    items,
    blockers,
    warnings,
    summary: eligible
      ? warnings.length > 0
        ? `Ready to promote ${facts.channel} to live filing, with ${warnings.length} warning(s) to resolve after the first submission.`
        : `Ready to promote ${facts.channel} to live filing.`
      : `Not ready to promote: ${blockers.length} blocking prerequisite${blockers.length === 1 ? "" : "s"} remain.`,
  };
}

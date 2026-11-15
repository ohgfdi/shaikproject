/**
 * One filing attempt, certified end to end.
 *
 * `filing-certification.ts` answers "can this deployment claim certification?"
 * from stored evidence. This module answers a narrower, operational question:
 * "did the attempt I just made produce evidence I can defend?" It composes the
 * existing proof builder/verifier and returns an exit code the operator runner
 * (`npm run filing:certify`) can trust.
 *
 * It deliberately cannot certify a deployment: one attempt, however clean, is a
 * pilot until reconciliation confirms the acknowledgement. That distinction is
 * the whole point of the certification model.
 */

import type { FilingGatewayHealth, FilingPreflightResult } from "@/lib/engine/filing/types";
import type { CertificationVerdict } from "@/lib/server/filing-certification";
import { verifyFilingProofBundle, type ProofCheck } from "@/lib/server/filing-proof-verify";

/** 0 = proven, 1 = attempted but not proven, 2 = cannot be proven offline. */
export type CertifyExitCode = 0 | 1 | 2;

export interface CertifyAttemptResult {
  ok: boolean;
  exitCode: CertifyExitCode;
  /** A single attempt can never certify a deployment — at best it is a pilot. */
  verdict: CertificationVerdict;
  checks: ProofCheck[];
  reason: string;
}

interface ReceiptShape {
  status?: unknown;
  provider?: unknown;
  ackNumber?: unknown;
  irn?: unknown;
  channel?: unknown;
}

function readReceipt(proof: unknown): ReceiptShape | null {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return null;
  const receipt = (proof as { receipt?: unknown }).receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  return receipt as ReceiptShape;
}

/**
 * Certify one stored/generated attempt.
 *
 * Inputs are the same facts the runner has after a submission: the gateway
 * health, the preflight (live only), the proof bundle and its digest. Nothing
 * is inferred from a claim in the payload.
 */
export function certifyFilingAttempt(input: {
  health: FilingGatewayHealth;
  preflight?: FilingPreflightResult | null;
  proof: unknown;
  bundleDigest?: string | null;
}): CertifyAttemptResult {
  const verification = verifyFilingProofBundle({
    proof: input.proof,
    ...(input.bundleDigest ? { bundleDigest: input.bundleDigest } : {}),
  });
  const receipt = readReceipt(input.proof);
  const provider = input.health.provider;

  if (provider !== "live") {
    return {
      ok: false,
      exitCode: 2,
      verdict: "simulation",
      checks: verification.checks,
      reason: `FILING_GATEWAY is "${provider}"; nothing was transmitted, so no live filing can be proven. Set FILING_GATEWAY=live with complete credentials first.`,
    };
  }

  const channel = input.health.activeChannel;
  const availability = channel === "none" ? null : input.health.channels[channel];
  if (!availability?.configured) {
    return {
      ok: false,
      exitCode: 1,
      verdict: "pilot",
      checks: verification.checks,
      reason:
        channel === "none"
          ? "No FILING_CHANNEL is selected, so the attempt cannot be attributed to a credentialed channel."
          : `The active channel "${channel}" is missing credentials: ${availability?.missing.join(", ") || "unknown"}.`,
    };
  }

  if (input.preflight && !input.preflight.ok) {
    return {
      ok: false,
      exitCode: 1,
      verdict: "pilot",
      checks: verification.checks,
      reason: `Credential preflight failed: ${input.preflight.detail}`,
    };
  }

  if (!receipt || receipt.provider !== "live") {
    return {
      ok: false,
      exitCode: 1,
      verdict: "pilot",
      checks: verification.checks,
      reason:
        receipt && typeof receipt.provider === "string"
          ? `The proof bundle records provider "${receipt.provider}" — a live attempt must record "live".`
          : "The proof bundle has no readable receipt.",
    };
  }

  const reference =
    (typeof receipt.ackNumber === "string" && receipt.ackNumber) ||
    (typeof receipt.irn === "string" && receipt.irn) ||
    null;
  const submitted = receipt.status === "filed";
  const digestProven = verification.bundleDigest !== null;
  const ok = verification.ok && submitted && reference !== null && digestProven;

  const reasons: string[] = [];
  if (!verification.ok) reasons.push("one or more proof checks failed");
  if (!submitted) reasons.push(`the portal receipt status is "${String(receipt.status)}"`);
  if (reference === null) reasons.push("the receipt carries no IRN/acknowledgement number");
  if (!digestProven) reasons.push("the bundle digest could not be recomputed");

  return {
    ok,
    exitCode: ok ? 0 : 1,
    verdict: "pilot",
    checks: verification.checks,
    reason: ok
      ? "The attempt is proven: the payload digest recomputes, the receipt anchors it, and the portal returned a reference. Deployment certification still requires reconciliation."
      : `The attempt is not proven: ${reasons.join("; ")}.`,
  };
}

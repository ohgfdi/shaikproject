/**
 * Independent verification of a filing proof bundle.
 *
 * `filing-proof.ts` *builds* the bundle; this module lets a third party
 * (an auditor, a client, or a different deployment) check it without trusting
 * the app that produced it. Everything needed is in the JSON:
 *
 *   payload        — the exact canonical document that was sent
 *   payloadDigest  — SHA-256 of canonicalJson(payload), recomputed here
 *   receipt.digest — the portal-shaped digest recorded at submit time
 *   signature      — optional detached DSC envelope (checked for shape only;
 *                    the signing service's trust chain is a separate concern)
 *
 * If the exporter also supplies the bundle digest stored in the database, the
 * verifier recomputes SHA-256 over the canonical proof and compares. A missing
 * bundle digest is reported as a skipped check, never as a pass.
 */

import { canonicalJson, sha256Hex, type FilingSignatureEnvelope } from "@/lib/engine/filing/signing";

import { filingProofDigest, type FilingProof } from "./filing-proof";

export interface ProofCheck {
  id: string;
  label: string;
  /** true = passed, false = failed, null = not applicable / not supplied. */
  ok: boolean | null;
  detail: string;
}

export interface ProofVerification {
  ok: boolean;
  checks: ProofCheck[];
  /** Recomputable bundle digest (the value that should match the database). */
  bundleDigest: string | null;
}

export interface ProofVerificationInput {
  proof: unknown;
  /** Optional digest stored alongside the bundle (e.g. ComplianceFilingRun.proofDigest). */
  bundleDigest?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Verify one bundle. The input may be the proof itself or an envelope
 * `{ proof, bundleDigest }` — the shape an export endpoint should produce.
 */
export function verifyFilingProofBundle(input: unknown): ProofVerification {
  const envelope = isRecord(input) && "proof" in input ? input : { proof: input };
  const proof = envelope.proof;

  if (!isRecord(proof)) {
    return {
      ok: false,
      bundleDigest: null,
      checks: [
        {
          id: "shape",
          label: "Bundle is a JSON object",
          ok: false,
          detail: "Expected a filing proof object or an envelope with a `proof` property.",
        },
      ],
    };
  }

  const candidate = proof as unknown as FilingProof;
  const checks: ProofCheck[] = [];

  checks.push({
    id: "version",
    label: "Supported proof version",
    ok: candidate.version === 1,
    detail: candidate.version === 1 ? "Version 1." : `Unsupported version: ${String(candidate.version)}.`,
  });

  checks.push({
    id: "identity",
    label: "Run and actor identified",
    ok:
      isRecord(candidate.run) &&
      typeof candidate.run.id === "string" &&
      candidate.run.id.length > 0 &&
      typeof candidate.actorId === "string" &&
      candidate.actorId.length > 0 &&
      isIsoDate(candidate.capturedAt),
    detail: "A proof must name the run, the actor who filed and the capture time.",
  });

  checks.push({
    id: "receipt",
    label: "Portal receipt present",
    ok:
      isRecord(candidate.receipt) &&
      typeof candidate.receipt.status === "string" &&
      typeof candidate.receipt.provider === "string" &&
      typeof candidate.receipt.submittedAt === "string" &&
      isIsoDate(candidate.receipt.submittedAt),
    detail: "The receipt records the provider, status and submission time.",
  });

  let computedPayloadDigest: string | null = null;
  let payloadCheck: ProofCheck;
  try {
    computedPayloadDigest = sha256Hex(canonicalJson(candidate.payload));
    const matches = computedPayloadDigest === candidate.payloadDigest;
    payloadCheck = {
      id: "payload-digest",
      label: "Payload digest recomputes",
      ok: matches,
      detail: matches
        ? `SHA-256 ${computedPayloadDigest.slice(0, 16)}… matches the stored payload digest.`
        : `Stored ${String(candidate.payloadDigest).slice(0, 16)}… does not match recomputed ${computedPayloadDigest.slice(0, 16)}…`,
    };
  } catch (err) {
    payloadCheck = {
      id: "payload-digest",
      label: "Payload digest recomputes",
      ok: false,
      detail: err instanceof Error ? err.message : "Payload could not be canonicalised.",
    };
  }
  checks.push(payloadCheck);

  const receiptMatches =
    isRecord(candidate.receipt) &&
    typeof candidate.receipt.digest === "string" &&
    candidate.receipt.digest === candidate.payloadDigest;
  checks.push({
    id: "receipt-digest",
    label: "Receipt digest matches the payload",
    ok: receiptMatches,
    detail: receiptMatches
      ? "The receipt anchors the same digest as the payload."
      : "The receipt digest and the payload digest differ — the bundle was altered or mixed from two attempts.",
  });

  checks.push({
    id: "digest-flag",
    label: "Stored comparison flag is consistent",
    ok: candidate.digestMatchesReceipt === receiptMatches,
    detail: candidate.digestMatchesReceipt
      ? "The bundle recorded a matching digest at capture time."
      : "The bundle recorded a mismatch at capture time — review before relying on it.",
  });

  let computedBundleDigest: string | null = null;
  try {
    computedBundleDigest = filingProofDigest(candidate);
  } catch {
    computedBundleDigest = null;
  }

  const suppliedDigest = typeof envelope.bundleDigest === "string" ? envelope.bundleDigest : null;
  if (suppliedDigest) {
    const matches = computedBundleDigest !== null && computedBundleDigest === suppliedDigest;
    checks.push({
      id: "bundle-digest",
      label: "Bundle digest matches the stored value",
      ok: matches,
      detail: matches
        ? "SHA-256 over the canonical bundle matches the digest on record."
        : `Stored bundle digest ${suppliedDigest.slice(0, 16)}… does not match recomputed ${(computedBundleDigest ?? "unavailable").slice(0, 16)}…`,
    });
  } else {
    checks.push({
      id: "bundle-digest",
      label: "Bundle digest matches the stored value",
      ok: null,
      detail: "No bundleDigest supplied. Recompute and compare it against the database value separately.",
    });
  }

  if (candidate.signature) {
    const signature = candidate.signature as FilingSignatureEnvelope;
    checks.push({
      id: "signature-shape",
      label: "Detached signature envelope is well formed",
      ok:
        typeof signature.signatureBase64 === "string" &&
        signature.signatureBase64.length > 0 &&
        typeof signature.certificateSerial === "string" &&
        signature.certificateSerial.length > 0,
      detail:
        "Signature presence is checked here; validating the DSC trust chain belongs to the signing service.",
    });
  }

  return {
    ok: checks.every((check) => check.ok !== false),
    checks,
    bundleDigest: computedBundleDigest,
  };
}

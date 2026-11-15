/**
 * Filing proof bundles — the evidence a firm keeps after pressing File.
 *
 * A portal receipt is not enough on its own: to defend a filing later you need
 * the exact document that was sent, the portal's response, and a digest that
 * proves the two have not been altered since. This module builds that bundle
 * deterministically so any reviewer can recompute the hashes.
 *
 * Honesty rules kept here:
 *  - the payload digest is recomputed locally and compared with the receipt's
 *    digest; a mismatch is recorded (`digestMatchesReceipt: false`) rather than
 *    hidden;
 *  - rejected/errored attempts are also captured, because "we tried and the
 *    portal refused" is evidence too;
 *  - no credential, token secret or portal password is ever included.
 */

import { normalizePem } from "@/lib/engine/filing/crypto";
import { canonicalJson, sha256Hex, type FilingSignatureEnvelope } from "@/lib/engine/filing/signing";
import type { FilingReceipt } from "@/lib/engine/filing/types";

export const FILING_PROOF_VERSION = 1 as const;

export interface FilingProofRun {
  id: string;
  organizationId: string;
  engagementId: string;
  taskId: string;
  title: string;
  authority: string;
  dueDate: string;
}

export interface FilingProofReceipt {
  provider: string;
  channel: string;
  status: string;
  token: string;
  reference: string;
  irn: string | null;
  ackNumber: string | null;
  ackDate: string | null;
  portalMessage: string | null;
  submittedAt: string;
  digest: string;
  httpStatus: number | null;
}

/**
 * Which portal configuration produced the receipt. Recorded so a later reader
 * can tell whether the certificate was earned against the key/version the
 * deployment is using today — portals rotate both, and a green certificate from
 * last quarter is not evidence for this one.
 */
export interface FilingPortalIdentity {
  portalVersion: string | null;
  /** SHA-256 of the normalised IRP public key PEM, or null when not configured. */
  keyFingerprint: string | null;
}

export interface FilingProof {
  version: typeof FILING_PROOF_VERSION;
  run: FilingProofRun;
  /** Portal configuration at capture time (nulls when the provider is offline). */
  portal: FilingPortalIdentity;
  /** Canonical document that was sent to the portal. */
  payload: unknown;
  /** The portal's response, copied without credentials. */
  receipt: FilingProofReceipt;
  /** SHA-256 of `canonicalJson(payload)` recomputed locally. */
  payloadDigest: string;
  /** True when the local digest equals the receipt's own digest. */
  digestMatchesReceipt: boolean;
  /** Detached DSC signature over the canonical payload, when the channel signs. */
  signature: FilingSignatureEnvelope | null;
  /** When the bundle was captured (ISO 8601). */
  capturedAt: string;
  /** Firm user who pressed File. */
  actorId: string;
}

export interface BuildFilingProofInput {
  run: FilingProofRun;
  payload: unknown;
  receipt: FilingReceipt;
  signature?: FilingSignatureEnvelope;
  actorId: string;
  capturedAt?: Date;
  /** Portal identity at capture time; defaults to the recorded-nothing shape. */
  portal?: FilingPortalIdentity;
}

const NO_PORTAL_IDENTITY: FilingPortalIdentity = { portalVersion: null, keyFingerprint: null };

/**
 * Read the portal identity from the environment (or any env map). Pure, so the
 * fingerprint rule is testable without a live portal. A malformed PEM yields a
 * null fingerprint rather than a bogus hash.
 */
export function portalIdentityFrom(
  env: Record<string, string | undefined> = process.env,
): FilingPortalIdentity {
  const portalVersion = env.FILING_PORTAL_VERSION?.trim() || null;
  const key = env.FILING_IRP_PUBLIC_KEY?.trim();
  let keyFingerprint: string | null = null;
  if (key) {
    try {
      keyFingerprint = sha256Hex(normalizePem(key));
    } catch {
      keyFingerprint = null;
    }
  }
  return { portalVersion, keyFingerprint };
}

/** Build the immutable proof bundle for one gateway attempt. */
export function buildFilingProof(input: BuildFilingProofInput): FilingProof {
  const payloadDigest = sha256Hex(canonicalJson(input.payload));
  return {
    version: FILING_PROOF_VERSION,
    run: {
      id: input.run.id,
      organizationId: input.run.organizationId,
      engagementId: input.run.engagementId,
      taskId: input.run.taskId,
      title: input.run.title,
      authority: input.run.authority,
      dueDate: input.run.dueDate,
    },
    portal: input.portal ?? NO_PORTAL_IDENTITY,
    payload: input.payload,
    receipt: {
      provider: input.receipt.provider,
      channel: input.receipt.channel,
      status: input.receipt.status,
      token: input.receipt.token,
      reference: input.receipt.reference,
      irn: input.receipt.irn,
      ackNumber: input.receipt.ackNumber,
      ackDate: input.receipt.ackDate,
      portalMessage: input.receipt.portalMessage,
      submittedAt: input.receipt.submittedAt,
      digest: input.receipt.digest,
      httpStatus: input.receipt.httpStatus,
    },
    payloadDigest,
    digestMatchesReceipt: payloadDigest === input.receipt.digest,
    signature: input.signature ?? null,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    actorId: input.actorId,
  };
}

/** SHA-256 over the canonical bundle — stored for quick integrity checks. */
export function filingProofDigest(proof: FilingProof): string {
  return sha256Hex(canonicalJson(proof));
}

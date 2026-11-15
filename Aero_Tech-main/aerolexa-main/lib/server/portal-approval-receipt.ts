/**
 * Client approval receipt for a filing run.
 *
 * The portal approval is a real act (a named person, at a time, over a specific
 * filing), but until now it existed only as a `stage` change and an event note
 * inside the firm's database. A client has no artefact of what they approved.
 * This module turns the stored event into a portable receipt with a
 * recomputable digest, so the firm and the client hold the same evidence.
 *
 * Versions:
 *   1  link-based approval (legacy; still verifies)
 *   2  adds identity: how the actor was identified (`portal-link` or
 *      `magic-link`) and, for the latter, the account id
 *   3  adds a detached `SHA256withRSA` signature over the version-2 digest,
 *      produced by a deployment's external DSC signing service
 *
 * Honesty: even v3 is CLICK-TO-APPROVE evidence. The signature proves the
 * receipt text was signed by the configured certificate; it is not a client-
 * held DSC signature and does not turn the click into an e-signature.
 */

import { canonicalJson, sha256Hex } from "@/lib/engine/filing/signing";

export const PORTAL_APPROVAL_RECEIPT_VERSION = 2 as const;

/** How the approving actor was identified. */
export type ApprovalIdentity = "portal-link" | "magic-link";

/**
 * Detached signature over the receipt digest, produced by the same external
 * signing service the filing path uses. The app never holds the private key.
 */
export interface ApprovalReceiptSignature {
  algorithm: "SHA256withRSA";
  /** Always equal to the receipt's own digest. */
  digest: string;
  signatureBase64: string;
  certificateSerial: string;
  signedAt: string;
  /** Signing-service id (e.g. "http-signing-service"). */
  signerId: string;
}

export interface PortalApprovalReceipt {
  version: 1 | 2 | 3;
  run: {
    id: string;
    taskId: string;
    title: string;
    authority: string;
    dueDate: string;
  };
  engagement: {
    id: string;
    name: string;
    organizationId: string;
  };
  approval: {
    stage: string;
    approvedAt: string;
    /** Name the client typed, when supplied. */
    approvedBy: string | null;
    note: string | null;
    /** Portal token id that performed the action. Not the token itself. */
    tokenId: string;
    /** v2+: how the actor was identified. */
    identity?: ApprovalIdentity;
    /** v2+: the signed-in client account, when identity is `magic-link`. */
    accountId?: string | null;
  };
  /** SHA-256 over the canonical receipt without `digest` or `signature`. */
  digest: string;
  /** v3 only. */
  signature?: ApprovalReceiptSignature;
}

export type ApprovalReceiptInput = Omit<PortalApprovalReceipt, "version" | "digest" | "signature"> & {
  approval: Omit<PortalApprovalReceipt["approval"], "identity" | "accountId"> & {
    identity?: ApprovalIdentity;
    accountId?: string | null;
  };
};

/** The approval fields that are hashed for a given receipt version. */
function approvalForDigest(
  version: 1 | 2,
  approval: PortalApprovalReceipt["approval"],
): Record<string, unknown> {
  const base = {
    stage: approval.stage,
    approvedAt: approval.approvedAt,
    approvedBy: approval.approvedBy,
    note: approval.note,
    tokenId: approval.tokenId,
  };
  if (version === 1) return base;
  return {
    ...base,
    identity: approval.identity ?? "portal-link",
    accountId: approval.identity === "magic-link" ? (approval.accountId ?? null) : null,
  };
}

/**
 * SHA-256 of the receipt's meaningful fields. Version 3 deliberately reuses the
 * version-2 digest, so the signature is over the same bytes as the evidence a
 * v2 holder can recompute.
 */
export function approvalReceiptDigest(receipt: ApprovalReceiptInput | PortalApprovalReceipt): string {
  const version: 1 | 2 = (receipt as { version?: number }).version === 1 ? 1 : 2;
  return sha256Hex(
    canonicalJson({
      version,
      run: receipt.run,
      engagement: receipt.engagement,
      approval: approvalForDigest(version, receipt.approval as PortalApprovalReceipt["approval"]),
    }),
  );
}

export function buildPortalApprovalReceipt(input: ApprovalReceiptInput): PortalApprovalReceipt {
  const approval: PortalApprovalReceipt["approval"] = {
    ...input.approval,
    identity: input.approval.identity ?? "portal-link",
    accountId:
      (input.approval.identity ?? "portal-link") === "magic-link"
        ? (input.approval.accountId ?? null)
        : null,
  };
  const receipt: Omit<PortalApprovalReceipt, "digest"> = {
    version: PORTAL_APPROVAL_RECEIPT_VERSION,
    run: input.run,
    engagement: input.engagement,
    approval,
  };
  return { ...receipt, digest: approvalReceiptDigest(receipt as PortalApprovalReceipt) };
}

/**
 * Promote a v2 receipt to v3 by attaching the signing service's envelope. The
 * digest does not change: the signature is over that digest.
 */
export function attachApprovalReceiptSignature(
  receipt: PortalApprovalReceipt,
  signature: ApprovalReceiptSignature,
): PortalApprovalReceipt {
  return {
    ...receipt,
    version: 3,
    signature: { ...signature, digest: receipt.digest },
  };
}

export interface ApprovalReceiptCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ApprovalReceiptVerification {
  ok: boolean;
  checks: ApprovalReceiptCheck[];
  digest: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Recompute the digest and check the shape, without trusting the producer. */
export function verifyPortalApprovalReceipt(value: unknown): ApprovalReceiptVerification {
  if (!isRecord(value)) {
    return {
      ok: false,
      digest: null,
      checks: [{ id: "shape", label: "Receipt is a JSON object", ok: false, detail: "Expected an approval receipt object." }],
    };
  }

  const receipt = value as unknown as PortalApprovalReceipt;
  const checks: ApprovalReceiptCheck[] = [];
  const supported = receipt.version === 1 || receipt.version === 2 || receipt.version === 3;

  checks.push({
    id: "version",
    label: "Supported receipt version",
    ok: supported,
    detail: supported ? `Version ${receipt.version}.` : `Unsupported version: ${String(receipt.version)}.`,
  });

  const approval = isRecord(receipt.approval) ? receipt.approval : null;
  const requiresIdentity = receipt.version === 2 || receipt.version === 3;
  const identityOk =
    !requiresIdentity ||
    (approval?.identity === "portal-link" ||
      (approval?.identity === "magic-link" &&
        typeof approval.accountId === "string" &&
        approval.accountId.length > 0));
  checks.push({
    id: "identity",
    label: "Approver identified",
    ok: identityOk,
    detail:
      approval?.identity === "magic-link"
        ? "Approved by a signed-in portal account."
        : "Approved by a holder of the portal link (not a signed-in account).",
  });

  const signature = isRecord(receipt.signature) ? receipt.signature : null;
  const signatureOk =
    receipt.version !== 3 ||
    (signature !== null &&
      signature.algorithm === "SHA256withRSA" &&
      typeof signature.signatureBase64 === "string" &&
      signature.signatureBase64.length > 0 &&
      typeof signature.certificateSerial === "string" &&
      signature.certificateSerial.length > 0 &&
      typeof signature.signerId === "string" &&
      signature.signerId.length > 0 &&
      isIsoDate(signature.signedAt) &&
      signature.digest === receipt.digest);
  checks.push({
    id: "signature",
    label: "Detached DSC signature envelope",
    ok: signatureOk,
    detail:
      receipt.version === 3
        ? signatureOk
          ? `Signed by ${String(signature?.signerId)} with certificate ${String(signature?.certificateSerial)}. Verify the signature against that certificate; this check is structural.`
          : "A version-3 receipt must carry a well-formed signature envelope over its digest."
        : "No detached signature: this approval is link-based evidence, not a DSC-signed document.",
  });

  checks.push({
    id: "subject",
    label: "Run, engagement and token identified",
    ok:
      isRecord(receipt.run) &&
      typeof receipt.run.id === "string" &&
      receipt.run.id.length > 0 &&
      typeof receipt.run.title === "string" &&
      receipt.run.title.length > 0 &&
      isRecord(receipt.engagement) &&
      typeof receipt.engagement.id === "string" &&
      receipt.engagement.id.length > 0 &&
      approval !== null &&
      typeof approval.tokenId === "string" &&
      approval.tokenId.length > 0 &&
      isIsoDate(approval.approvedAt),
    detail: "A receipt must name the run, the engagement, the approval time and the portal token that acted.",
  });

  let digest: string | null = null;
  let digestOk = false;
  try {
    digest = approvalReceiptDigest(receipt);
    digestOk = typeof receipt.digest === "string" && digest === receipt.digest;
  } catch {
    digestOk = false;
  }
  checks.push({
    id: "digest",
    label: "Receipt digest recomputes",
    ok: digestOk,
    detail: digestOk
      ? `SHA-256 ${String(digest).slice(0, 16)}… matches the stored digest.`
      : "The recomputed digest does not match — the receipt was altered after issue.",
  });

  return { ok: checks.every((check) => check.ok), checks, digest };
}

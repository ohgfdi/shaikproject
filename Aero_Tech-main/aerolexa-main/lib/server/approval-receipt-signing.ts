/**
 * Optional detached signing for client approval receipts.
 *
 * The signing path reuses the filing module's external signing service
 * (`FILING_SIGNING_URL` / `TOKEN` / `USER` / `CERT_SERIAL`); the app still never
 * holds a private key. Three behaviours, all deliberate:
 *
 *  - no signing service configured: return the v2 receipt unchanged;
 *  - signing configured and working: return v3 with the detached signature;
 *  - signing configured but incomplete/unreachable: REFUSE the approval rather
 *    than silently downgrade to an unsigned receipt. A firm that opted into
 *    signing must not believe an unsigned approval was signed.
 */

import { createVerify } from "node:crypto";

import { ApiError } from "@/lib/auth/guard";
import { resolveFilingSigner, resolveSigningAccount } from "@/lib/engine/filing/signing-service";

import {
  attachApprovalReceiptSignature,
  type PortalApprovalReceipt,
} from "./portal-approval-receipt";

/**
 * Verify the detached signature against a configured public certificate.
 *
 * Returns null when there is nothing to verify against (unsigned receipt, or
 * FILING_SIGNING_CERT_PEM unset) — never "true" by default. The signed bytes
 * are the receipt digest string, matching HttpSigningService's contract.
 */
export function verifyApprovalReceiptSignature(
  receipt: PortalApprovalReceipt,
  certificatePem: string = process.env.FILING_SIGNING_CERT_PEM ?? "",
): boolean | null {
  if (!receipt.signature || receipt.version !== 3) return null;
  if (!certificatePem.trim()) return null;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(receipt.digest);
    verifier.end();
    return verifier.verify(certificatePem, Buffer.from(receipt.signature.signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export async function signApprovalReceipt(
  receipt: PortalApprovalReceipt,
): Promise<PortalApprovalReceipt> {
  let signer;
  let account;
  try {
    signer = resolveFilingSigner();
    if (!signer) return receipt;
    account = resolveSigningAccount();
  } catch (err) {
    throw new ApiError(
      502,
      "APPROVAL_SIGNING_FAILED",
      `Signing is configured but incomplete (${err instanceof Error ? err.message : "unknown configuration error"}). Nothing was recorded; fix the FILING_SIGNING_* variables and retry.`,
    );
  }
  if (!account) {
    throw new ApiError(
      502,
      "APPROVAL_SIGNING_FAILED",
      "A signing service URL is configured but FILING_SIGNING_USER and FILING_SIGNING_CERT_SERIAL are missing. Nothing was recorded.",
    );
  }

  try {
    const result = await signer.sign(receipt.digest, account);
    return attachApprovalReceiptSignature(receipt, {
      algorithm: "SHA256withRSA",
      digest: receipt.digest,
      signatureBase64: result.signatureBase64,
      certificateSerial: result.certificateSerial,
      signedAt: result.signedAt,
      signerId: signer.id,
    });
  } catch (err) {
    throw new ApiError(
      502,
      "APPROVAL_SIGNING_FAILED",
      `The approval could not be signed by the configured signing service (${err instanceof Error ? err.message : "unknown signing error"}). Nothing was recorded; retry once the service is reachable.`,
    );
  }
}

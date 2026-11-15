/**
 * Remote DSC signing configuration.
 *
 * The app never holds a DSC private key. When a deployment supplies a signing
 * service URL + token, `resolveFilingSigner()` builds the HTTP adapter and
 * `resolveSigningAccount()` names the certificate the service should sign with.
 *
 * The one non-negotiable rule: a partial signing configuration is a fault, not
 * a reason to file unsigned. `efiling-audit` additionally refuses to submit
 * without a signer (and the boot-time env check refuses to start).
 */

import { serverEnv } from "@/lib/env";

import { HttpSigningService, type SigningAccount, type SigningService } from "./signing";

export interface FilingSigningReadiness {
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly required: boolean;
  readonly user: string | null;
  readonly certificateSerial: string | null;
}

function envValue(key: "FILING_SIGNING_URL" | "FILING_SIGNING_TOKEN" | "FILING_SIGNING_USER" | "FILING_SIGNING_CERT_SERIAL"): string {
  return String(serverEnv()[key] ?? "").trim();
}

/** The account/certificate the signing service should use. */
export function resolveSigningAccount(): SigningAccount | null {
  const user = envValue("FILING_SIGNING_USER");
  const certificateSerial = envValue("FILING_SIGNING_CERT_SERIAL");
  if (!user && !certificateSerial) return null;
  if (!user || !certificateSerial) {
    throw new Error(
      "DSC signing is partially configured: set both FILING_SIGNING_USER and FILING_SIGNING_CERT_SERIAL.",
    );
  }
  return { user, certificateSerial };
}

/**
 * Build the remote signer, or return null when no signing service is
 * configured. A URL without a token (or vice versa) throws: silently falling
 * back to an unsigned filing is exactly the failure this module prevents.
 */
export function resolveFilingSigner(): SigningService | null {
  const env = serverEnv();
  const url = envValue("FILING_SIGNING_URL");
  const token = envValue("FILING_SIGNING_TOKEN");
  if (!url && !token) return null;
  if (!url || !token) {
    throw new Error("DSC signing is partially configured: set both FILING_SIGNING_URL and FILING_SIGNING_TOKEN.");
  }
  return new HttpSigningService({ url, token, timeoutMs: env.FILING_SIGNING_TIMEOUT_MS });
}

/** Operator-facing readiness, used by the conformance runner and health API. */
export function filingSigningReadiness(): FilingSigningReadiness {
  const env = serverEnv();
  const missing = (["FILING_SIGNING_URL", "FILING_SIGNING_TOKEN", "FILING_SIGNING_USER", "FILING_SIGNING_CERT_SERIAL"] as const).filter(
    (key) => envValue(key) === "",
  );
  return {
    configured: missing.length === 0,
    missing,
    required: env.FILING_CHANNEL === "efiling-audit",
    user: envValue("FILING_SIGNING_USER") || null,
    certificateSerial: envValue("FILING_SIGNING_CERT_SERIAL") || null,
  };
}

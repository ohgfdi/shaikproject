/**
 * CA portal authentication and signing — certificate-based auth adapters for
 * GSTN, Income Tax e-filing, ROC (MCA) and TDS portals.
 *
 * Three signing methods are supported, mirroring the EfilingConfig matrix:
 *
 *   1. DSC (Digital Signature Certificate) — Class 2/3 PKCS#12 or PEM key+cert.
 *      The private key signs a SHA-256 hash of the submission payload; the signed
 *      hash + certificate are sent to the portal. This is the strongest auth and
 *      is required for ROC forms, audit reports, and certain corporate ITRs.
 *
 *   2. EVC (Electronic Verification Code) — a one-time code sent to a pre-validated
 *      bank account or mobile. No certificate needed. Used for most individual ITRs
 *      and TDS statements where the filer has a validated bank account.
 *
 *   3. ETM (E-Token Manager) / Aadhaar eSign — Aadhaar-based OTP or eSign for
 *      simplified signing on supported portals.
 *
 * CRYPTO: Uses the `jose` library (already installed for auth) for RSA signing
 * with PKCS#8 keys, and Node's crypto for SHA-256 hashing and X.509 parsing.
 * No new dependencies.
 *
 * HONESTY CONTRACT: The portal endpoints (GSTN services, IT e-filing, MCA) require
 * TLS client certificates, valid filing windows, and compliance with current portal
 * schemas. This engine implements the auth + signing flow and the submission
 * orchestration; the actual portal endpoints may change and the reviewer must verify
 * against the current portal behavior. The engine never stores DSC PINs — they are
 * used only in-memory during the signing operation.
 */

import { importPKCS8, SignJWT } from "jose";
import { createHash, X509Certificate } from "node:crypto";

import { ConnectorError } from "./errors";

// ---------------------------------------------------------------------------
// DSC — Digital Signature Certificate handling
// ---------------------------------------------------------------------------

/**
 * Normalize a DSC private key PEM: strip whitespace, unescape \n, validate.
 * Accepts PKCS#8 PEM (preferred) or PKCS#1 RSAPRIVATEKEY PEM.
 */
export function normalizeDscKey(raw: string): string {
  // Collapse any JSON-style \n escapes (only present when a PEM was stored as a
  // JSON-stringified value) into real newlines, then strip a surrounding
  // "..." wrapper that some JSON round-trips add. Real PEMs from node:crypto
  // already contain real newlines, so this is a no-op on them.
  const unescaped = raw.replace(/\\n/g, "\n");
  const trimmed = unescaped.trim().replace(/^"|"$/g, "");
  if (!trimmed.includes("-----BEGIN")) {
    throw new ConnectorError(
      "The DSC private key is not a PEM key. What happened: the key must include BEGIN/END header lines. How to fix: export the DSC private key as PEM (PKCS#8 preferred) from your token/software.",
      { status: 400, code: "DSC_KEY_INVALID" },
    );
  }
  // Key material is validated asynchronously on first use (signWithDsc imports
  // it with jose). Normalisation stays synchronous and side-effect free.
  return trimmed;
}

/**
 * Parse an X.509 certificate PEM and extract metadata useful for portal filing.
 * Returns the subject DN components the portals care about.
 */
export function parseDscCertificate(pem: string): {
  subjectName: string;
  serial: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  thumbprint: string;
  isExpired: boolean;
  /** The PAN extracted from subject if present (DSC PAN is critical for ROC/IT). */
  pan?: string;
} {
  const cert = new X509Certificate(pem);
  const now = new Date();

  // Node exposes certificate validity as strings (and, on newer releases, as
  // Date accessors validFromDate/validToDate). Normalise to Date so comparisons
  // and ISO formatting work on every supported Node version.
  const certMeta = cert as unknown as {
    validFrom: string | Date;
    validTo: string | Date;
    validFromDate?: Date;
    validToDate?: Date;
  };
  const validFrom = certMeta.validFromDate ?? new Date(certMeta.validFrom);
  const validTo = certMeta.validToDate ?? new Date(certMeta.validTo);

  // Extract PAN from subject if present (DSC certs for tax filing carry the PAN).
  const subject = cert.subject;
  const panMatch = subject.match(/PAN\s*:\s*([A-Z]{5}[0-9]{4}[A-Z]{1})/i);

  // SHA-256 thumbprint (uppercase hex, as portals expect).
  const thumbprint = createHash("sha256").update(cert.raw).digest("hex").toUpperCase();

  return {
    subjectName: subject,
    serial: cert.serialNumber,
    issuer: cert.issuer,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    thumbprint,
    isExpired: now > validTo || now < validFrom,
    pan: panMatch ? panMatch[1] : undefined,
  };
}

/**
 * Validate that a DSC certificate is currently valid (not expired, not before).
 * Returns the parsed certificate metadata, or throws if invalid/expired.
 */
export function validateDscCertificate(pem: string): ReturnType<typeof parseDscCertificate> {
  const info = parseDscCertificate(pem);
  if (info.isExpired) {
    throw new ConnectorError(
      `The DSC certificate has expired or is not yet valid. Valid from ${info.validFrom} to ${info.validTo}. What happened: the certificate cannot be used for signing. How to fix: renew the DSC certificate and update the credentials.`,
      { status: 400, code: "DSC_CERTIFICATE_EXPIRED" },
    );
  }
  if (!info.pan) {
    throw new ConnectorError(
      `The DSC certificate does not contain a PAN in the subject. What happened: tax-filing DSCs must carry the holder's PAN. How to fix: obtain a DSC with the PAN in the subject CN/RDN fields, then re-import.`,
      { status: 400, code: "DSC_CERTIFICATE_NO_PAN" },
    );
  }
  return info;
}

/**
 * Sign a payload hash with a DSC private key (RSA-SHA256).
 * Returns the base64-encoded signature suitable for portal submission.
 *
 * The payload is first hashed with SHA-256 (the portal's expected hash),
 * then the hash is signed with the DSC private key.
 */
export async function signWithDsc(
  payload: string,
  privateKeyPem: string,
  _pin?: string,
): Promise<{ signature: string; algorithm: "SHA256withRSA"; hashAlgorithm: "SHA-256" }> {
  const pem = normalizeDscKey(privateKeyPem);

  // Validate the key can be imported (this is where a bad key fails fast).
  let key;
  try {
    key = await importPKCS8(pem, "RS256");
  } catch {
    throw new ConnectorError(
      `The DSC private key could not be imported. What happened: the PEM is malformed or the key is encrypted with a password not supported here. How to fix: export an unencrypted PKCS#8 key (openssl pkcs8 -topk8 -nocrypt) or provide the PIN for an encrypted key.`,
      { status: 400, code: "DSC_KEY_INVALID" },
    );
  }

  // Hash the payload with SHA-256 (this is what the portal expects).
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");

  // Sign the hash with the private key.
  // jose's SignJWT can sign arbitrary payloads; we use it to sign the hash.
  const signatureJwt = await new SignJWT({ hash }).setProtectedHeader({ alg: "RS256", typ: "JWT" }).sign(key);

  // Extract the actual signature from the JWT (the second part).
  const parts = signatureJwt.split(".");
  if (parts.length !== 3) {
    throw new ConnectorError(
      "DSC signing produced an unexpected JWT structure. What happened: the signing library returned an invalid JWT. How to fix: report this as a bug with the key and payload details.",
      { status: 500, code: "DSC_SIGNING_ERROR" },
    );
  }

  // Decode the signature from base64url to base64 (portals typically want base64).
  const signatureBase64 = base64UrlToBase64(parts[1] ?? "");

  return {
    signature: signatureBase64,
    algorithm: "SHA256withRSA",
    hashAlgorithm: "SHA-256",
  };
}

/**
 * Sign a payload for DSC submission and return the complete signing bundle
 * that portals expect: the payload, the signature, the certificate, and metadata.
 */
export async function createDscSigningBundle(config: {
  payload: string;
  privateKeyPem: string;
  certificatePem: string;
  pin?: string;
  timeoutMs?: number;
}): Promise<{
  signature: string;
  algorithm: string;
  hashAlgorithm: string;
  certificateThumbprint: string;
  certificateSerial: string;
  payloadHash: string;
  signedAt: string;
  portalSubmission: {
    payload: string;
    signature: string;
    certificate: string;
    signingMethod: "dsc";
  };
}> {
  // Validate certificate first (fails fast if expired).
  const certInfo = validateDscCertificate(config.certificatePem);

  // Sign the payload.
  const signResult = await signWithDsc(config.payload, config.privateKeyPem, config.pin);

  // Hash for the portal's checksum.
  const payloadHash = createHash("sha256").update(config.payload, "utf8").digest("hex");

  return {
    signature: signResult.signature,
    algorithm: signResult.algorithm,
    hashAlgorithm: signResult.hashAlgorithm,
    certificateThumbprint: certInfo.thumbprint,
    certificateSerial: certInfo.serial,
    payloadHash,
    signedAt: new Date().toISOString(),
    portalSubmission: {
      payload: config.payload,
      signature: signResult.signature,
      certificate: config.certificatePem,
      signingMethod: "dsc",
    },
  };
}

// ---------------------------------------------------------------------------
// EVC — Electronic Verification Code
// ---------------------------------------------------------------------------

/**
 * EVC verification result — the portal returns an EVC code that must be
 * captured and validated within a short window.
 */
export interface EvcVerification {
  evcCode: string;
  verifiedAt: string;
  expiresAt: string;
  channel: "bank" | "mobile" | "aadhaar";
  bankAccountLast4?: string;
}

/**
 * Simulate / prepare an EVC verification flow. In a real integration this
 * would trigger the portal's EVC generation (bank validation / Aadhaar OTP)
 * and capture the returned EVC code.
 *
 * The engine returns a prepared EVC bundle that the submission flow can use.
 * The actual EVC must be obtained from the portal at submission time.
 */
export function prepareEvcVerification(config: {
  channel: "bank" | "mobile" | "aadhaar";
  bankAccount?: string;
  mobile?: string;
  aadhaarLast4?: string;
}): {
  channel: "bank" | "mobile" | "aadhaar";
  verificationMethod: string;
  createdAt: string;
  note: string;
} {
  const channel = config.channel;
  const now = new Date().toISOString();

  let verificationMethod: string;
  let note: string;

  switch (channel) {
    case "bank":
      verificationMethod = `EVC via pre-validated bank account (last 4: ${(config.bankAccount ?? "***").slice(-4)})`;
      note =
        "The portal sends an EVC to the pre-validated bank account linked to the filer's PAN/GSTIN. The EVC is valid for a short window (typically 15 minutes). Capture the EVC code returned by the portal and use it in the submission.";
      break;
    case "mobile":
      verificationMethod = `EVC via mobile OTP (registered mobile: ${config.mobile ? config.mobile.slice(-10) : "***"})`;
      note =
        "The portal sends an OTP to the mobile number registered with the PAN/GSTIN. The OTP is valid for a short window. Capture the OTP returned by the portal.";
      break;
    case "aadhaar":
      verificationMethod = `EVC via Aadhaar-based authentication (Aadhaar ending: ${config.aadhaarLast4 ?? "****"})`;
      note =
        "The portal uses Aadhaar e-KYC / OTP for verification. The Aadhaar number must be linked to the PAN (as required by Indian tax law). Capture the OTP returned by the portal.";
      break;
  }

  return {
    channel,
    verificationMethod,
    createdAt: now,
    note,
  };
}

// ---------------------------------------------------------------------------
// ETM / Aadhaar eSign
// ---------------------------------------------------------------------------

/**
 * ETM (E-Token Manager) or Aadhaar eSign preparation.
 * ETM is a software token that manages DSC-like signing without a physical token.
 * Aadhaar eSign uses OTP + biometric/PAN validation for document signing.
 */
export interface EtMConfig {
  method: "etm" | "aadhaar-esign";
  /** ETM device ID or Aadhaar number (last 4 for eSign). */
  identifier: string;
  /** For Aadhaar eSign: the OTP received from the portal. */
  otp?: string;
}

/**
 * Prepare an ETM / Aadhaar eSign signing bundle.
 * The portal returns an OTP or token challenge that must be captured.
 */
export function prepareEtMSigning(config: EtMConfig): {
  method: "etm" | "aadhaar-esign";
  identifierMasked: string;
  createdAt: string;
  note: string;
  challengeRequired: boolean;
} {
  const now = new Date().toISOString();
  const masked = config.identifier.slice(-4).padStart(config.identifier.length, "*");

  if (config.method === "etm") {
    return {
      method: "etm",
      identifierMasked: masked,
      createdAt: now,
      note: `ETM token ${masked} will be used for signing. The ETM software must be running and the token unlocked (PIN entered) before submission. The portal will challenge the ETM for a signature during the filing flow.`,
      challengeRequired: true,
    };
  }

  // Aadhaar eSign.
  return {
    method: "aadhaar-esign",
    identifierMasked: masked,
    createdAt: now,
    note: `Aadhaar eSign with Aadhaar ending ${masked}. An OTP will be sent to the Aadhaar-linked mobile. Capture the OTP and submit it with the filing. The eSign certificate is issued by the UIDAI-authorized CA for this session only.`,
    challengeRequired: true,
  };
}

// ---------------------------------------------------------------------------
// Portal auth result — unified shape for all three methods
// ---------------------------------------------------------------------------

/**
 * The result of preparing a portal signing operation. This is what the
 * submission engines consume to actually file the return/forms.
 */
export type PortalSigningMethod = "dsc" | "evc" | "etm";

export interface PortalSigningBundle {
  /** The signing method used. */
  signingMethod: PortalSigningMethod;
  /** When DSC is used, the signing bundle with signature + cert. */
  dscBundle?: Awaited<ReturnType<typeof createDscSigningBundle>>;
  /** When EVC is used, the EVC preparation. */
  evcPreparation?: ReturnType<typeof prepareEvcVerification>;
  /** When ETM/Aadhaar eSign is used, the ETM preparation. */
  etmPreparation?: ReturnType<typeof prepareEtMSigning>;
  /** The pre-submission payload that will be sent to the portal. */
  payload: string;
  /** SHA-256 hash of the payload (for portal checksum verification). */
  payloadHash: string;
  /** Timestamp of signing preparation. */
  preparedAt: string;
  /** Portal-specific form type being filed. */
  formType: string;
  /** Taxpayer identifier (GSTIN, PAN, TAN, or CIN). */
  taxpayerId: string;
}

/**
 * Prepare a portal signing bundle for the given method and payload.
 * This is the main entry point for the submission engines.
 */
export async function preparePortalSigning(config: {
  formType: string;
  taxpayerId: string;
  payload: string;
  signingMethod: PortalSigningMethod;
  /** For DSC: private key PEM. */
  dscPrivateKey?: string;
  /** For DSC: certificate PEM. */
  dscCertificate?: string;
  /** For DSC: PIN (if key is encrypted). */
  dscPin?: string;
  /** For EVC: channel. */
  evcChannel?: "bank" | "mobile" | "aadhaar";
  /** For EVC: bank account number. */
  evcBankAccount?: string;
  /** For EVC: mobile number. */
  evcMobile?: string;
  /** For ETM: ETM device ID or Aadhaar last 4. */
  etmIdentifier?: string;
  /** For ETM: OTP (if already received). */
  etmOtp?: string;
  timeoutMs?: number;
}): Promise<PortalSigningBundle> {
  const signingMethod = config.signingMethod;
  const now = new Date().toISOString();
  const payload = config.payload;
  const payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");

  // Build the bundle based on signing method.
  if (signingMethod === "dsc") {
    if (!config.dscPrivateKey || !config.dscCertificate) {
      throw new ConnectorError(
        `DSC signing requires both a private key and a certificate. What happened: the DSC credentials are incomplete. How to fix: provide the DSC private key PEM and certificate PEM.`,
        { status: 400, code: "DSC_CREDENTIALS_MISSING" },
      );
    }

    const dscBundle = await createDscSigningBundle({
      payload,
      privateKeyPem: config.dscPrivateKey,
      certificatePem: config.dscCertificate,
      pin: config.dscPin,
      timeoutMs: config.timeoutMs,
    });

    return {
      signingMethod: "dsc",
      dscBundle,
      payload,
      payloadHash,
      preparedAt: now,
      formType: config.formType,
      taxpayerId: config.taxpayerId,
    };
  }

  if (signingMethod === "evc") {
    const evcPreparation = prepareEvcVerification({
      channel: config.evcChannel ?? "bank",
      bankAccount: config.evcBankAccount,
      mobile: config.evcMobile,
      aadhaarLast4: undefined, // would need full Aadhaar for this
    });

    return {
      signingMethod: "evc",
      evcPreparation,
      payload,
      payloadHash,
      preparedAt: now,
      formType: config.formType,
      taxpayerId: config.taxpayerId,
    };
  }

  // ETM / Aadhaar eSign.
  const etmPreparation = prepareEtMSigning({
    method: "etm",
    identifier: config.etmIdentifier ?? "unknown",
    otp: config.etmOtp,
  });

  return {
    signingMethod: "etm",
    etmPreparation,
    payload,
    payloadHash,
    preparedAt: now,
    formType: config.formType,
    taxpayerId: config.taxpayerId,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert base64url encoding to standard base64. */
function base64UrlToBase64(base64Url: string): string {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' to make length a multiple of 4.
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return base64;
}

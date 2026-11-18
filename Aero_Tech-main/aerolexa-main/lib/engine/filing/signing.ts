/**
 * Cryptographic primitives for portal filing.
 *
 * These are the REAL hashes, MACs and canonical-serialisation helpers that a
 * portal expects — not placeholder strings. Everything is deterministic and
 * oracle-tested so a payload prepared here reproduces byte-for-byte across
 * callers, which is what lets a reviewer recompute a checksum or IRN hash and
 * confirm the document was not altered between preparation and submission.
 *
 * Honesty boundary (kept deliberately): the app NEVER holds a DSC private key.
 * DSC signing in this repo is done through a `Signer` that a deployment points
 * at an external signing service (CSP bridge / eSign / HSM). The LocalRsaSigner
 * exists only for oracle tests and key-held-inside-the-trust-boundary setups;
 * the default live path is the SigningServiceSigner HTTP adapter.
 */

import { createHash, createHmac, createSign, createPrivateKey, randomUUID } from "node:crypto";

/** Stable, order-independent serialisation of a JSON document (sorted keys). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, jsonValue) => {
    if (jsonValue && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
      return Object.fromEntries(Object.entries(jsonValue).sort(([a], [b]) => a.localeCompare(b)));
    }
    return jsonValue;
  });
}

/** SHA-256 hex digest (portal checksums, IRN-reference hashes, payload digests). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 base64 digest (GSTN "DocDigest" and document-hash headers). */
export function sha256Base64(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64");
}

/** HMAC-SHA256 base64 (portal request-auth / integrity headers). */
export function hmacSha256Base64(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64");
}

/** HMAC-SHA256 hex digest. */
export function hmacSha256Hex(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/**
 * GSTN-style checksum: SHA-256 hex over `<canonicalJson> + <sharedSecret>`.
 * This is the shape the IRP documentation describes for the `checksum` the
 * gateway computes over the signed payload — it makes the payload tamper-evident
 * without the portal needing the caller's secret.
 */
export function gstnChecksumHex(payload: unknown, sharedSecret: string): string {
  return sha256Hex(canonicalJson(payload) + sharedSecret);
}

/**
 * Once-only token for idempotent portal submissions (GSTN IRP / efiling both
 * deduplicate on this value). A corrected payload MUST use a fresh token; the
 * same payload resubmitted with the same token returns the original receipt.
 */
export function onceToken(): string {
  return randomUUID();
}

/** GSTN IRN data model: internal IRN reference (40 alphanumeric chars). */
export const IRN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36

/**
 * Deterministic 40-char IRN-shaped reference from the GSTN IRP formula:
 * SHA-256 of the canonical payload, uppercased, trimmed to 40. This is the
 * value the reference provider issues; the LIVE gateway replaces it with the
 * GSTN-issued IRN (see irp.ts).
 */
export function irnReference(canonicalPayload: string): string {
  return sha256Hex(canonicalPayload).toUpperCase().slice(0, 40);
}

/**
 * Sign a canonical payload with a DSC RSA/SHA-256 signature (base64). Real
 * PKCS#1v1.5 signing via node:crypto — verified against oracle vectors in tests.
 */
export function rsaSha256Sign(pemPrivateKey: string, data: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(data, "utf8");
  return signer.sign(createPrivateKey(pemPrivateKey)).toString("base64");
}

/**
 * A remote DSC signing adapter (CSP bridge / eSign / HSM gateway). The app
 * sends the document digest + a transaction reference; the signing service
 * holds the private key and returns the signature. This is the default LIVE
 * path — the DSC private key never enters the app.
 */
export interface SigningService {
  readonly id: string; // "csp-bridge" | "esign" | "hsm"
  sign(digest: string, account: SigningAccount): Promise<SigningResult>;
}

export interface SigningAccount {
  /** DSC user id / registration number on the signing service. */
  readonly user: string;
  /** Certificate serial (hex), used for audit and the portal's `DSCMeta` block. */
  readonly certificateSerial: string;
  readonly accountRef?: string;
}

export interface SigningResult {
  readonly signatureBase64: string;
  readonly certificateSerial: string;
  readonly signedAt: string; // ISO
}

/**
 * Deterministic, in-process signer backed by an HSM-held PEM/raw key. Intended
 * for oracle tests and for deployments whose HSM exposes the key in-process
 * (yubihsm-pkcs11 bridges etc.). Never used on the LIVE default path.
 */
export class LocalRsaSigner implements SigningService {
  readonly id = "local-rsa" as const;
  constructor(private readonly pemPrivateKey: string) {}

  async sign(digest: string, account: SigningAccount): Promise<SigningResult> {
    return {
      signatureBase64: rsaSha256Sign(this.pemPrivateKey, digest),
      certificateSerial: account.certificateSerial,
      signedAt: new Date().toISOString(),
    };
  }
}

/**
 * HTTP adapter for an external DSC signing service. The app sends only the
 * SHA-256 digest and the account reference; the service holds the private key
 * and returns a PKCS#1 v1.5 RSA/SHA-256 signature. This is the default live
 * path — the DSC key never enters this process.
 *
 * The wire contract is deliberately small and stable:
 *   POST {digest, algorithm: "SHA256withRSA", account: {user,
 *         certificateSerial, accountRef?}}
 *   →    {signatureBase64, certificateSerial?, signedAt?}
 * A service that wraps eSign/CSP/HSM exposes this shape at its own endpoint.
 * Anything else is a configuration fault and fails loudly.
 */
export interface HttpSigningServiceConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpSigningService implements SigningService {
  readonly id = "http-signing-service" as const;

  constructor(private readonly config: HttpSigningServiceConfig) {
    if (!config.url || !config.token) {
      throw new Error("DSC signing service requires both a URL and a bearer token.");
    }
  }

  async sign(digest: string, account: SigningAccount): Promise<SigningResult> {
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error("DSC signing service expects a SHA-256 hex digest.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(this.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({
          digest,
          algorithm: "SHA256withRSA",
          account: {
            user: account.user,
            certificateSerial: account.certificateSerial,
            ...(account.accountRef ? { accountRef: account.accountRef } : {}),
          },
        }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown transport error";
      throw new Error(`DSC signing service could not be reached: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`DSC signing service rejected the request (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("DSC signing service returned a non-JSON response.");
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const signature = typeof record?.signatureBase64 === "string" ? record.signatureBase64 : null;
    if (!signature) throw new Error("DSC signing service returned no signatureBase64.");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(signature, "base64");
    } catch {
      throw new Error("DSC signing service returned a malformed base64 signature.");
    }
    if (bytes.length === 0) throw new Error("DSC signing service returned an empty signature.");
    const certificateSerial =
      typeof record?.certificateSerial === "string" && record.certificateSerial
        ? record.certificateSerial
        : account.certificateSerial;
    const signedAt =
      typeof record?.signedAt === "string" && Number.isFinite(Date.parse(record.signedAt))
        ? new Date(record.signedAt).toISOString()
        : new Date().toISOString();
    return { signatureBase64: signature, certificateSerial, signedAt };
  }
}

/** Detached signature envelope attached to a filing proof / portal request. */
export interface FilingSignatureEnvelope {
  readonly algorithm: "SHA256withRSA";
  readonly digest: string;
  readonly signatureBase64: string;
  readonly certificateSerial: string;
  readonly signedAt: string;
  readonly signerId: string;
}

/** Sign the canonical payload once and return both the digest and envelope. */
export async function signFilingPayload(
  signer: SigningService,
  account: SigningAccount,
  payload: unknown,
): Promise<FilingSignatureEnvelope> {
  const digest = sha256Hex(canonicalJson(payload));
  const result = await signer.sign(digest, account);
  return {
    algorithm: "SHA256withRSA",
    digest,
    signatureBase64: result.signatureBase64,
    certificateSerial: result.certificateSerial,
    signedAt: result.signedAt,
    signerId: signer.id,
  };
}

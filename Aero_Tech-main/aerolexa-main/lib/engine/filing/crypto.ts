/**
 * GSTN IRP payload crypto.
 *
 * The IRP does not accept the invoice JSON in the clear. Its handshake is a
 * hybrid RSA + AES scheme, confirmed against the NIC e-Invoice API FAQ and the
 * published sandbox sample code:
 *
 *   1. Auth (RSA) — the app generates a random 32-byte AppKey, base64-encodes
 *      `{UserName, Password, AppKey, ForceRefreshAccessToken}`, encrypts THAT
 *      base64 string with the IRP's RSA public key (RSA/ECB/PKCS1Padding) and
 *      sends `{ "Data": "<base64 ciphertext>" }` to the auth endpoint.
 *   2. The auth response returns an `AuthToken` (valid 360 minutes) and a
 *      `Sek` (Session Encryption Key) already AES-encrypted with the AppKey.
 *      The app decrypts the Sek with the AppKey it generated.
 *   3. Every later call AES-256/ECB/PKCS5-encrypts the JSON payload with the
 *      Sek and base64-encodes it into the same `{ "Data": … }` envelope; the
 *      IRP encrypts ITS response the same way, so the app decrypts the
 *      response `Data` with the Sek.
 *
 * Only primitives live here — no network, no config. They are pure and
 * round-trip oracle-tested, so an operator can reproduce the exact bytes the
 * gateway sent without the portal.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
} from "node:crypto";

/** Length of the symmetric keys (AppKey / Sek) — AES-256. */
export const SYMMETRIC_KEY_BYTES = 32;

/**
 * Fresh base64 AppKey for one authentication round-trip. 32 random bytes →
 * 44 base64 chars, exactly what the IRP handshake expects (and what it hands
 * back encrypted as the Sek).
 */
export function createAppKey(): string {
  return randomBytes(SYMMETRIC_KEY_BYTES).toString("base64");
}

/** True when a value is a usable base64 decode of a 32-byte AES-256 key. */
export function isSymmetricKey(value: string): boolean {
  try {
    return Buffer.from(value, "base64").length === SYMMETRIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/**
 * RSA/ECB/PKCS1Padding encrypt (base64 out). `plaintext` is UTF-8; the caller
 * passes the base64-of-JSON string the IRP handshake specifies.
 */
export function rsaEncryptBase64(plaintext: string, publicKeyPem: string): string {
  const encrypted = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return encrypted.toString("base64");
}

/** RSA/ECB/PKCS1Padding decrypt (base64 in, UTF-8 out). Test/oracle helper. */
export function rsaDecryptBase64(cipherBase64: string, privateKeyPem: string): string {
  const decrypted = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(cipherBase64, "base64"),
  );
  return decrypted.toString("utf8");
}

/**
 * AES-256/ECB/PKCS5 encrypt (base64 out) with a base64 32-byte key. This is
 * the `{ "Data": … }` envelope used by both the IRN request and the IRP
 * response.
 */
export function aesEncryptBase64(plaintext: string, keyBase64: string): string {
  const cipher = createCipheriv("aes-256-ecb", decodeKey(keyBase64), null);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

/** AES-256/ECB/PKCS5 decrypt (base64 in, UTF-8 out) with a base64 32-byte key. */
export function aesDecryptBase64(cipherBase64: string, keyBase64: string): string {
  const decipher = createDecipheriv("aes-256-ecb", decodeKey(keyBase64), null);
  return Buffer.concat([decipher.update(Buffer.from(cipherBase64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * A PEM pasted into an env var usually arrives with literal "\n" escapes
 * rather than real newlines; restore them so node:crypto can parse the key.
 */
export function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

/**
 * True when `value` (raw PEM or one-line with \n escapes) parses as an RSA
 * public key. Used to fail live mode closed at BOOT on a mis-pasted key rather
 * than at the first filing, when it is too late.
 */
export function isValidRsaPublicKey(value: string): boolean {
  if (!value.trim()) return false;
  try {
    return createPublicKey(normalizePem(value)).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== SYMMETRIC_KEY_BYTES) {
    // A wrong key length is a configuration fault, but this module stays
    // dependency-free (no error taxonomy import); callers wrap it.
    throw new Error(`expected a ${SYMMETRIC_KEY_BYTES}-byte AES key, got ${key.length} bytes`);
  }
  return key;
}

/**
 * Generate an RSA-2048 keypair (PEM) — used by tests to stand in for the IRP's
 * public key and by operators to mint a throwaway keypair for the sandbox.
 */
export function generateIrpKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

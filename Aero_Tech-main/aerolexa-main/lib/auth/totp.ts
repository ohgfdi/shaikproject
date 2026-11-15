/**
 * TOTP (RFC 6238) + recovery codes for account MFA.
 *
 * Pure functions only: no database, no HTTP. The RFC 6238 vectors are pinned
 * in the tests, so a code generated here is provably the same code an
 * authenticator app shows at that instant.
 *
 * Storage decisions:
 *  - the TOTP seed is sealed with AES-256-GCM under AUTH_SECRET; a database
 *    leak alone cannot mint codes;
 *  - recovery codes are bcrypt-hashed, shown once, and consumed on use;
 *  - `lastUsedStep` makes a code single-use inside its 30-second window.
 */

import bcrypt from "bcryptjs";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { serverEnv } from "@/lib/env";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const SECRET_SEAL_VERSION = "v1";
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i/l/o/0/1

/** RFC 4648 base32 (no padding) — the format authenticator apps exchange. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  if (!clean) throw new Error("TOTP secret is empty.");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`TOTP secret contains an invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** One HOTP value (RFC 4226) for an explicit counter. */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("HOTP counter must be a non-negative integer.");
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(timestampMs = Date.now()): number {
  return Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
}

/** Current TOTP value (RFC 6238, HMAC-SHA1, 6 digits, 30-second step). */
export function totp(secret: string, timestampMs = Date.now(), digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(timestampMs), digits);
}

export interface VerifyTotpOptions {
  /** Clock-skew tolerance in steps (default ±1 = ±30s). */
  readonly window?: number;
  readonly at?: number;
  /** Last step already accepted; a code at or before it is a replay. */
  readonly lastUsedStep?: number | null;
}

export interface TotpVerification {
  readonly valid: boolean;
  readonly step: number | null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify a 6-digit TOTP value, with skew tolerance and replay rejection. */
export function verifyTotp(secret: string, code: string, options: VerifyTotpOptions = {}): TotpVerification {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return { valid: false, step: null };
  const current = totpStep(options.at);
  const window = options.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    if (safeEqual(hotp(secret, step), normalized)) return { valid: true, step };
  }
  return { valid: false, step: null };
}

/** A fresh 160-bit base32 seed (what an authenticator app scans). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI for the QR code / manual entry. */
export function otpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const issuer = input.issuer.trim() || "Ledgerly";
  const label = `${issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Seed sealing
// ---------------------------------------------------------------------------

function sealKey(): Buffer {
  return scryptSync(serverEnv().AUTH_SECRET, "ledgerly:totp:v1", 32);
}

/** Seal a TOTP seed at rest with AES-256-GCM. */
export function sealTotpSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_SEAL_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ".",
  );
}

/** Open a sealed seed; throws when the value was tampered with or the key rotated. */
export function openTotpSecret(sealed: string): string {
  const [version, ivPart, tagPart, cipherPart] = sealed.split(".");
  if (version !== SECRET_SEAL_VERSION || !ivPart || !tagPart || !cipherPart) {
    throw new Error("Stored MFA secret is not in the expected sealed format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherPart, "base64url")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Human-friendly one-time recovery codes (10 × 8 chars, grouped). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(8);
    let raw = "";
    for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function hashRecoveryCodes(codes: readonly string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(normalizeRecoveryCode(code), 10)));
}

/**
 * Check a recovery code against the stored bcrypt hashes. Returns the index of
 * the matched code so the caller can consume exactly that one, or -1.
 */
export async function findRecoveryCode(
  code: string,
  hashes: readonly string[],
): Promise<number> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 6) return -1;
  for (let index = 0; index < hashes.length; index += 1) {
    if (await bcrypt.compare(normalized, hashes[index]!)) return index;
  }
  return -1;
}

export function recoveryCodesRemaining(stored: string | null | undefined): number {
  if (!stored) return 0;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string").length : 0;
  } catch {
    return 0;
  }
}

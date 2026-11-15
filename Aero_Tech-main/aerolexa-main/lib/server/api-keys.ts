import { hash, compare } from "bcryptjs";
import { randomBytes } from "node:crypto";

const KEY_PREFIX = "ak_live_";
const KEY_ID_LENGTH = 8;
const KEY_SECRET_LENGTH = 32;

/** Alphanumeric key id — never contains "_", so the key is unambiguously splittable. */
const KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Shape of a full API key: `ak_live_<keyId>_<secret>`.
 *
 * The key id is alphanumeric so the `keyId` segment is always exactly
 * KEY_ID_LENGTH characters, whatever the base64url secret contains. The parser
 * below is therefore unambiguous — it never splits on every underscore, which
 * would break as soon as a secret happened to contain one.
 */
const KEY_PATTERN = /^ak_live_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{16,})$/;

function randomKeyId(): string {
  const bytes = randomBytes(KEY_ID_LENGTH);
  let out = "";
  for (let i = 0; i < KEY_ID_LENGTH; i++) {
    out += KEY_ID_ALPHABET[bytes[i]! % KEY_ID_ALPHABET.length];
  }
  return out;
}

/** Generate a new API key with prefix and secret. */
export function generateApiKey(): { key: string; prefix: string; secret: string } {
  const keyId = randomKeyId();
  const secret = randomBytes(KEY_SECRET_LENGTH).toString("base64url");
  const prefix = KEY_PREFIX + keyId;
  const key = `${prefix}_${secret}`;
  return { key, prefix, secret };
}

/** Hash an API key for storage. */
export async function hashApiKey(key: string): Promise<string> {
  return hash(key, 12);
}

/** Verify an API key against its hash. */
export async function verifyApiKey(key: string, keyHash: string): Promise<boolean> {
  return compare(key, keyHash);
}

/** Validate API key prefix format. */
export function validateApiKeyPrefix(prefix: string): boolean {
  return new RegExp(`^${KEY_PREFIX}[A-Za-z0-9]{${KEY_ID_LENGTH}}$`).test(prefix);
}

/** Validate a full API key's shape (without checking it against storage). */
export function validateApiKeyFormat(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Extract the lookup prefix from a full API key.
 *
 * Returns `ak_live_<keyId>` — exactly the `keyPrefix` stored alongside the key
 * hash — or null when the key is not shaped like an Ledgerly API key.
 *
 * Hardening: the input is trimmed first, so a client that accidentally sends a
 * trailing newline or surrounding spaces still resolves the SAME stored
 * prefix (and the bcrypt compare below sees the same trimmed bytes the
 * hash was made from) instead of a phantom `INVALID_KEY`.
 */
export function extractPrefix(key: string): string | null {
  const match = KEY_PATTERN.exec(key.trim());
  return match ? KEY_PREFIX + match[1] : null;
}

/**
 * Normalize the raw Authorization header value for verification:
 * strips surrounding whitespace from the credential part. The header value
 * itself must already have the scheme removed by the caller.
 */
export function normalizeApiKey(raw: string): string {
  return raw.trim();
}

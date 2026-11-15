/**
 * Encrypt connector credentials at rest.
 *
 * Connector configs (including passwords) are stored in the database as
 * AES-256-GCM ciphertext keyed by a SHA-256 digest of AUTH_SECRET — the same
 * secret that signs sessions. Even a full database dump does not expose
 * credentials. Never import this module from client code: it reads server env.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { serverEnv } from "@/lib/env";

import { ConnectorError } from "./errors";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

function key(): Buffer {
  return createHash("sha256").update(serverEnv().AUTH_SECRET).digest();
}

/** Serialize any JSON value to `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

/** Decrypt a blob produced by `encryptJson`. Throws ConnectorError on failure. */
export function decryptJson<T>(blob: string): T {
  try {
    const parts = blob.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION)
      throw new ConnectorError(
        "The stored connection settings could not be decrypted. What happened: the connection data format is unrecognized (possibly corrupted or from a different version). How to fix: delete this connection and re-enter the settings.",
        { status: 400, code: "CONNECTOR_DECRYPT" },
      );
    const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  } catch {
    throw new ConnectorError(
      "The stored connection settings could not be decrypted. What happened: the encryption key (AUTH_SECRET) may have changed since the connection was saved. How to fix: delete this connection and re-enter the settings.",
    );
  }
}

import { createHash, randomBytes } from "node:crypto";

/**
 * Email verification & password-reset tokens. Only the SHA-256 hash of the
 * token is stored (the DB is not a password vault). The raw token travels in
 * the emailed link once and is consumed on click.
 */
export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export const TOKEN_TTL: Record<"VERIFY_EMAIL" | "RESET_PASSWORD", number> = {
  VERIFY_EMAIL: 24 * 60 * 60 * 1000, // 24h
  RESET_PASSWORD: 60 * 60 * 1000, // 1h
};

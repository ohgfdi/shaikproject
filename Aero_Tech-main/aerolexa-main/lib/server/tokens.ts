/**
 * Token generation and validation utilities.
 */

import { randomBytes, createHash } from "node:crypto";

export interface TokenPair {
  raw: string; // The raw token (sent to user)
  hash: string; // The hashed token (stored in DB)
}

/**
 * Generate a secure random token.
 */
export function generateToken(): TokenPair {
  const raw = randomBytes(32).toString("hex");
  const hash = hashToken(raw);
  return { raw, hash };
}

/**
 * Hash a token for storage.
 * Uses SHA-256 with a prefix to distinguish from other hashes.
 */
export function hashToken(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `tok_${hash}`;
}

/**
 * Token TTL configurations.
 */
export const TOKEN_TTL = {
  VERIFY_EMAIL: 24 * 60 * 60 * 1000, // 24 hours
  RESET_PASSWORD: 60 * 60 * 1000, // 1 hour
  SESSION: 7 * 24 * 60 * 60 * 1000, // 7 days (configurable via env)
  API_KEY: null, // API keys don't expire (revoked manually)
} as const;

/**
 * Check if a token is expired.
 */
export function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt < new Date();
}

/**
 * Rate Limiting Types
 */

export interface RateLimitConfig {
  /** Maximum number of allowed calls per window */
  limit: number;
  /** Window length in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export type PrincipalType = "user" | "api_key";

export interface RateLimitContext {
  principalId: string;
  principalType: PrincipalType;
}

export interface RateLimitedError extends Error {
  statusCode: 429;
  retryAfterSeconds: number;
  retryAfter: string;
  principalId: string;
  principalType: PrincipalType;
  bucketName: string;
}

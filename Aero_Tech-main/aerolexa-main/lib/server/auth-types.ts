/**
 * Authentication Types
 *
 * Types for the authentication context that flows through the application.
 * Every request is authenticated as either a user session or an API key,
 * and carries the organization context for authorization.
 */

export type PrincipalType = "user" | "api_key";

export interface UserInfo {
  id: string;
  email: string;
  name: string;
}

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string;
}

export interface AuthenticationContext {
  /** The type of principal (user session or API key) */
  principalType: PrincipalType;

  /** The ID of the principal (user ID or API key ID) */
  principalId: string;

  /** The organization this request is scoped to */
  organizationId: string;

  // User-specific fields (only for user sessions)
  userId?: string;
  user?: UserInfo;

  // API key-specific fields (only for API keys)
  apiKeyId?: string;
  apiKeyName?: string;
  apiKeyScopes?: string[];

  // Session-specific fields (for user sessions)
  sessionId?: string;

  // Organization context (always present)
  organization?: OrganizationInfo;
}

/**
 * Minimal auth context for operations that don't need full user info.
 */
export interface AuthMinimalContext {
  principalType: PrincipalType;
  principalId: string;
  organizationId: string;
}

/**
 * Convert a full auth context to minimal for passing to services that
 * only need org context and principal identity.
 */
export function toMinimalContext(ctx: AuthenticationContext): AuthMinimalContext {
  return {
    principalType: ctx.principalType,
    principalId: ctx.principalId,
    organizationId: ctx.organizationId,
  };
}

/**
 * Check if the auth context represents an API key.
 */
export function isApiKeyAuth(ctx: AuthenticationContext): boolean {
  return ctx.principalType === "api_key";
}

/**
 * Check if the auth context represents a user session.
 */
export function isUserAuth(ctx: AuthenticationContext): boolean {
  return ctx.principalType === "user";
}

/**
 * Get the display name for the principal (for audit logs, etc.).
 */
export function getPrincipalDisplayName(ctx: AuthenticationContext): string {
  if (ctx.principalType === "user" && ctx.user) {
    return ctx.user.name;
  }
  if (ctx.principalType === "api_key" && ctx.apiKeyName) {
    return `API Key: ${ctx.apiKeyName}`;
  }
  return `Unknown (${ctx.principalType}:${ctx.principalId})`;
}

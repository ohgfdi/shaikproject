/**
 * Active organization selection.
 *
 * A user can belong to more than one organization (for example a CA who works
 * across two firms). Resolving `organizationMemberships[0]` makes the active
 * firm depend on row order, so every org-scoped write could land in the wrong
 * tenant. The active organization is therefore an explicit, signed-in choice
 * stored in an httpOnly cookie and validated against the user's memberships on
 * every read.
 */

import { cookies } from "next/headers";

import { brandKey } from "@/lib/brand";

const COOKIE_NAME = brandKey("active_org");
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The organization id the user last selected, if any. */
export async function readActiveOrganizationId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(COOKIE_NAME)?.value;
  return value && value.trim() ? value : null;
}

/** Persist the active organization choice (caller must verify membership first). */
export async function setActiveOrganizationId(organizationId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Clear the choice (e.g. when the user leaves an organization). */
export async function clearActiveOrganizationId(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

/** Test/diagnostic helper: the cookie name, without duplicating the literal. */
export const ACTIVE_ORGANIZATION_COOKIE = COOKIE_NAME;

/**
 * Resolve the membership that should be active.
 *
 * The stored choice wins only when it still matches a membership; otherwise
 * fall back to the first membership (new user, or a choice that was revoked).
 * Pure so the tenant-selection rule is unit-testable without cookies.
 */
export function selectActiveMembership<T extends { organizationId: string }>(
  memberships: readonly T[],
  activeOrganizationId: string | null,
): T | undefined {
  const selected = activeOrganizationId
    ? memberships.find((m) => m.organizationId === activeOrganizationId)
    : undefined;
  return selected ?? memberships[0];
}

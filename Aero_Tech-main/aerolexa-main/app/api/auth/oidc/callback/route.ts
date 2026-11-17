import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { exchangeCode, fetchUserInfo } from "@/lib/auth/oidc";
import { createSessionCookie, createSessionToken } from "@/lib/auth/session";
import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { publicEnv, serverEnv } from "@/lib/env";
import { logSecurityEvent } from "@/lib/server/activity";

export const dynamic = "force-dynamic";

/** Session TTL: mirror the custom login (SESSION_TTL_DAYS). */
function sessionTtlSeconds(): number {
  return serverEnv().SESSION_TTL_DAYS * 24 * 60 * 60;
}

/**
 * GET /api/auth/oidc/callback
 *
 * Finishes the generic OIDC flow: validates state, exchanges the code (PKCE),
 * reads the verified email from userinfo, then provisions/links the Ledgerly
 * account exactly like the Google/NextAuth bridge does — accounts are keyed
 * by email, so SSO and password sign-in resolve to the same user. On success
 * it sets the standard `ledgerly.session` cookie and redirects to the app.
 */
export async function GET(request: Request) {
  const env = serverEnv();
  const appUrl = publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const fail = (message: string) => NextResponse.redirect(`${appUrl}/login?ssoError=${encodeURIComponent(message)}`);

  if (!env.SSO_ENABLED || !env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    return fail("OIDC is not configured on this deployment.");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return fail(`The identity provider rejected the sign-in: ${providerError}.`);
  }
  if (!code || !state) return fail("The identity provider did not return an authorization code.");

  const store = await cookies();
  const expectedState = store.get(brandKey(BRAND_STORAGE_KEYS.oidcState))?.value;
  const verifier = store.get(brandKey(BRAND_STORAGE_KEYS.oidcVerifier))?.value;
  store.delete(brandKey(BRAND_STORAGE_KEYS.oidcState));
  store.delete(brandKey(BRAND_STORAGE_KEYS.oidcVerifier));
  if (!expectedState || !verifier) return fail("The sign-in flow expired — start again.");
  if (state !== expectedState)
    return fail("State mismatch — the sign-in cannot be trusted (possible CSRF). Start again.");

  const redirectUri = `${appUrl}/api/auth/oidc/callback`;

  try {
    const { discoverOidc } = await import("@/lib/auth/oidc");
    const discovery = await discoverOidc(env.OIDC_ISSUER);
    const tokens = await exchangeCode({
      discovery,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri,
      code,
      verifier,
    });
    const userinfo = await fetchUserInfo({ discovery, accessToken: tokens.accessToken });

    // Provision/link by email — the same contract as the NextAuth bridge in
    // app/api/auth/[...nextauth]/route.ts (resolveSsoUser): SSO users never
    // chose a password, so the hash is unguessable random bytes.
    const { prisma } = await import("@/lib/db");
    const { hashPassword } = await import("@/lib/auth/password");
    const { DEFAULT_WORKSPACE_SETTINGS } = await import("@/lib/types");
    const { stringifyJson } = await import("@/lib/json");
    const { randomBytes } = await import("node:crypto");

    const normalized = userinfo.email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email: normalized }, include: { workspace: true } });
    if (!user) {
      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
      user = await prisma.user.create({
        data: {
          name: userinfo.name?.trim() || normalized.split("@")[0] || "SSO user",
          email: normalized,
          passwordHash,
          emailVerifiedAt: new Date(), // the IdP verified ownership of the address
          workspace: {
            create: {
              name: `${(userinfo.name?.trim() || normalized.split("@")[0] || "Your").split(" ")[0]}'s workspace`,
              settings: stringifyJson({ ...DEFAULT_WORKSPACE_SETTINGS }),
            },
          },
        },
        include: { workspace: true },
      });
    }

    const sessionToken = await createSessionToken(user.id);
    const response = NextResponse.redirect(appUrl);
    const cookie = createSessionCookie(sessionToken, sessionTtlSeconds());
    response.cookies.set(cookie.name, cookie.value, cookie.options);

    if (user.workspace) {
      await logSecurityEvent(user.workspace.id, user.id, "SECURITY_SSO", `${user.email} signed in with OIDC SSO`);
    }
    return response;
  } catch (err) {
    return fail(err instanceof Error ? err.message : "OIDC sign-in failed.");
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { buildAuthorizeUrl, createPkcePair, createState, discoverOidc } from "@/lib/auth/oidc";
import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";
import { publicEnv, serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/oidc/authorize
 *
 * Starts the generic OIDC authorization-code flow with state + PKCE:
 * redirects the browser to the IdP's authorization endpoint and sets two
 * short-lived cookies (state, PKCE verifier) that the callback must echo.
 * Requires SSO_ENABLED=true plus OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET.
 */
export async function GET(_request: Request) {
  const env = serverEnv();
  if (!env.SSO_ENABLED) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "SSO_DISABLED", message: "SSO is not enabled on this deployment (SSO_ENABLED=true)." },
      },
      { status: 503 },
    );
  }
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SSO_NOT_CONFIGURED",
          message: "OIDC is not configured: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.",
        },
      },
      { status: 503 },
    );
  }

  const appUrl = publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const redirectUri = `${appUrl}/api/auth/oidc/callback`;

  try {
    const discovery = await discoverOidc(env.OIDC_ISSUER);
    const state = createState();
    const pkce = createPkcePair();

    const authorizeUrl = buildAuthorizeUrl({
      discovery,
      clientId: env.OIDC_CLIENT_ID,
      redirectUri,
      state,
      pkce,
    });

    const store = await cookies();
    const common = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600, // 10 minutes — the whole flow should take seconds
    };
    store.set(brandKey(BRAND_STORAGE_KEYS.oidcState), state, common);
    store.set(brandKey(BRAND_STORAGE_KEYS.oidcVerifier), pkce.verifier, common);

    return NextResponse.redirect(authorizeUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OIDC authorization failed.";
    return NextResponse.redirect(`${appUrl}/login?ssoError=${encodeURIComponent(message)}`);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  buildAuthnRequestXml,
  buildRedirectUrl,
  createStatePayload,
  createSamlRequestId,
  fetchIdpMetadata,
  samlAcsUrl,
} from "@/lib/auth/saml";
import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";
import { publicEnv, serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/saml/authorize
 *
 * Starts the SAML Web Browser SSO flow with the HTTP-Redirect binding:
 * fetches/validates the IdP metadata (SAML_METADATA_URL), builds an
 * AuthnRequest (deflate+base64 in the query string) and redirects the browser
 * to the IdP's SingleSignOnService. A short-lived cookie carries our request
 * id, which the ACS uses to bind the Response (InResponseTo) — replay and
 * CSRF are bound to it.
 */
export async function GET() {
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
  if (!env.SAML_METADATA_URL) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SAML_NOT_CONFIGURED",
          message: "SAML is not configured: set SAML_METADATA_URL (the IdP federation metadata URL).",
        },
      },
      { status: 503 },
    );
  }

  const appUrl = publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const acsUrl = samlAcsUrl(appUrl);

  try {
    const metadata = await fetchIdpMetadata(env.SAML_METADATA_URL);
    const requestId = createSamlRequestId();
    const xml = buildAuthnRequestXml({ requestId, issueInstant: new Date(), acsUrl });
    const redirectUrl = buildRedirectUrl({ ssoUrl: metadata.ssoPostUrl, xml, relayState: appUrl });

    const store = await cookies();
    store.set(brandKey(BRAND_STORAGE_KEYS.samlRequest), createStatePayload(requestId), {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600, // 10 minutes — the whole flow should take seconds
    });

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "SAML sign-in could not start.";
    return NextResponse.redirect(`${appUrl}/login?ssoError=${encodeURIComponent(message)}`);
  }
}

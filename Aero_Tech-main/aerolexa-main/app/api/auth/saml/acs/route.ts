import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { SAML_ENTITY_ID, fetchIdpMetadata, samlAcsUrl, splitStatePayload, validateSamlResponse } from "@/lib/auth/saml";
import { createSessionCookie, createSessionToken } from "@/lib/auth/session";
import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";
import { publicEnv, serverEnv } from "@/lib/env";
import { logSecurityEvent } from "@/lib/server/activity";

export const dynamic = "force-dynamic";

/** Session TTL: mirror the custom login (SESSION_TTL_DAYS). */
function sessionTtlSeconds(): number {
  return serverEnv().SESSION_TTL_DAYS * 24 * 60 * 60;
}

/**
 * POST /api/auth/saml/acs
 *
 * The Assertion Consumer Service: receives the IdP's HTTP-POST binding
 * (SAMLResponse form field), validates it against the IdP metadata (signed
 * assertion/response, InResponseTo binding, conditions window, audience,
 * recipient) and provisions/links the Ledgerly account by the verified email
 * — exactly the OIDC contract. On success it sets the standard
 * `ledgerly.session` cookie and redirects into the app.
 */
export async function POST(request: Request) {
  const env = serverEnv();
  const appUrl = publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const fail = (message: string) =>
    NextResponse.redirect(`${appUrl}/login?ssoError=${encodeURIComponent(message)}`, { status: 303 });

  if (!env.SSO_ENABLED || !env.SAML_METADATA_URL) {
    return fail("SAML is not configured on this deployment.");
  }

  const store = await cookies();
  const stateCookie = store.get(brandKey(BRAND_STORAGE_KEYS.samlRequest))?.value;
  store.delete(brandKey(BRAND_STORAGE_KEYS.samlRequest));
  const state = stateCookie ? splitStatePayload(stateCookie) : null;
  if (!state) return fail("The sign-in flow expired — start again.");

  const acsUrl = samlAcsUrl(appUrl);

  try {
    const metadata = await fetchIdpMetadata(env.SAML_METADATA_URL);
    const form = await request.formData();
    const samlResponse = String(form.get("SAMLResponse") ?? "");
    if (!samlResponse) return fail("The identity provider did not post a SAML response.");

    const identity = validateSamlResponse({
      samlResponse,
      xml: "",
      certificates: metadata.certificates,
      requestId: state.requestId,
      audience: SAML_ENTITY_ID,
      acsUrl,
      now: new Date(),
    });

    // Provision/link by email — the same contract as the OIDC/NextAuth bridges:
    // SSO users never chose a password, so the hash is unguessable random bytes.
    const { prisma } = await import("@/lib/db");
    const { hashPassword } = await import("@/lib/auth/password");
    const { DEFAULT_WORKSPACE_SETTINGS } = await import("@/lib/types");
    const { stringifyJson } = await import("@/lib/json");
    const { randomBytes } = await import("node:crypto");

    const normalized = identity.email!.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { email: normalized }, include: { workspace: true } });
    if (!user) {
      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
      user = await prisma.user.create({
        data: {
          name: identity.name?.trim() || normalized.split("@")[0] || "SSO user",
          email: normalized,
          passwordHash,
          emailVerifiedAt: new Date(), // the IdP verified ownership of the address
          workspace: {
            create: {
              name: `${(identity.name?.trim() || normalized.split("@")[0] || "Your").split(" ")[0]}'s workspace`,
              settings: stringifyJson({ ...DEFAULT_WORKSPACE_SETTINGS }),
            },
          },
        },
        include: { workspace: true },
      });
    }

    const sessionToken = await createSessionToken(user.id);
    const response = NextResponse.redirect(appUrl, { status: 303 });
    const cookie = createSessionCookie(sessionToken, sessionTtlSeconds());
    response.cookies.set(cookie.name, cookie.value, cookie.options);

    if (user.workspace) {
      await logSecurityEvent(user.workspace.id, user.id, "SECURITY_SSO", `${user.email} signed in with SAML SSO`);
    }
    return response;
  } catch (err) {
    return fail(err instanceof Error ? err.message : "SAML sign-in failed.");
  }
}

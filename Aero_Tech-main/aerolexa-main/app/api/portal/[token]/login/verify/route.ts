import { NextResponse } from "next/server";

import {
  PORTAL_SESSION_TTL_SECONDS,
  portalSessionCookie,
  verifyPortalLogin,
} from "@/lib/server/portal-auth";

export const dynamic = "force-dynamic";

/**
 * GET — consume a sign-in link and return to the portal with a session cookie.
 * A bad token redirects to the login page rather than leaking why.
 */
export async function GET(request: Request, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const raw = new URL(request.url).searchParams.get("t") ?? "";
  try {
    const verified = await verifyPortalLogin(raw);
    const response = NextResponse.redirect(new URL(`/portal/${token}`, request.url));
    const cookie = portalSessionCookie(verified.sessionToken);
    response.cookies.set({
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      sameSite: "lax",
      secure: cookie.options.secure as boolean,
      path: "/",
      maxAge: PORTAL_SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL(`/portal/${token}/login?error=invalid`, request.url));
  }
}

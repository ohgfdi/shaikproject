import { NextResponse } from "next/server";

import {
  PORTAL_SESSION_TTL_SECONDS,
  portalSessionCookie,
  verifyPortalLogin,
} from "@/lib/server/portal-auth";

export const dynamic = "force-dynamic";

/**
 * GET — verify the engagement-agnostic invite link sent by the firm, then land
 * on a page that tells the client to open their portal link. The session is
 * already bound to that engagement, so the approval they make there is named.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("t") ?? "";
  try {
    const verified = await verifyPortalLogin(raw);
    const response = NextResponse.redirect(new URL("/portal/signed-in", request.url));
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
    return NextResponse.redirect(new URL("/portal/signed-in?error=invalid", request.url));
  }
}

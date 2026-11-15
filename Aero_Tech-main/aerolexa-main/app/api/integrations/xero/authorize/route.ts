import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/server/api";
import { newXeroState, xeroAuthorizeUrl, xeroConfigured } from "@/lib/server/xero-oauth";

export const dynamic = "force-dynamic";

/**
 * Start the Xero authorisation-code flow. The state is stored in a short-lived,
 * httpOnly cookie and compared on the callback, so a forged callback cannot
 * attach a different Xero tenant to this workspace.
 */
export async function GET(request: Request) {
  try {
    await requireAuth();
    if (!xeroConfigured()) {
      return NextResponse.redirect(
        new URL("/connectors?xero=not-configured", request.url),
      );
    }
    const state = newXeroState();
    const response = NextResponse.redirect(xeroAuthorizeUrl(state));
    response.cookies.set("xero_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 10 * 60,
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/guard";
import { connectXero } from "@/lib/server/xero-oauth";

export const dynamic = "force-dynamic";

/**
 * Xero redirects here with `code` + `state`. The state must match the cookie
 * set by /authorize; the user must still have a session. On success the refresh
 * token is encrypted into the workspace's connector and the browser lands back
 * on the connectors screen with a readable outcome.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("xero_oauth_state="))
    ?.slice("xero_oauth_state=".length);

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(new URL("/connectors?xero=invalid-state", url.origin));
  }

  try {
    const ctx = await requireAuth();
    const result = await connectXero(ctx, code);
    const response = NextResponse.redirect(
      new URL(`/connectors?xero=connected&tenant=${encodeURIComponent(result.tenantName)}`, url.origin),
    );
    response.cookies.delete("xero_oauth_state");
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Xero connection failed.";
    const response = NextResponse.redirect(
      new URL(`/connectors?xero=error&message=${encodeURIComponent(message.slice(0, 180))}`, url.origin),
    );
    response.cookies.delete("xero_oauth_state");
    return response;
  }
}

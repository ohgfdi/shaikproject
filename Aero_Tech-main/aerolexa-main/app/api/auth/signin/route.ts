import { NextResponse } from "next/server";

/** Initiate SSO login for a given provider.
 *  The provider's login endpoint sets cookies/redirects the user's browser.
 *  We 302 to the provider's authorize URL; NextAuth handles the redirect flow.
 */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  // Only allow known providers
  const allowed = ["google", "azure", "oidc"];
  if (!allowed.includes(provider)) {
    return NextResponse.json({ ok: false, error: "Unknown provider" }, { status: 400 });
  }

  // Use NextAuth's built-in sign-in flow
  // NextAuth expects a POST to /api/auth/signin/[provider] but we'll redirect
  // The /api/auth/[...nextauth] route handles the actual OAuth dance.
  // Instead, we delegate to the NextAuth session handler.
  const url = new URL(request.url);
  const searchParams = url.searchParams;
  const redirectTo = searchParams.get("redirect") || "/dashboard";

  // Respond with JSON that the client can use to initiate the flow
  // The client should redirect to /api/auth/signin/[provider] which then
  // triggers the NextAuth OAuth flow.
  return NextResponse.json({ ok: true, provider, redirectTo });
}

/** Handle the callback after the user authenticates with the provider.
 *  NextAuth's /api/auth/callback/[provider] route handles this, but we
 *  expose a simple endpoint here for the frontend to POST to.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  if (!["google", "azure", "oidc"].includes(provider)) {
    return NextResponse.json({ ok: false, error: "Unknown provider" }, { status: 400 });
  }

  // NextAuth handles the full OAuth flow when called from the sign-in page.
  // This endpoint just acknowledges the request and can be used for CSRF protection.
  return NextResponse.json({ ok: true, provider });
}
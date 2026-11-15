import { jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";

import { BRAND_STORAGE_KEYS, brandKey, legacyBrandKey } from "@/lib/brand";
import { applySecurityHeaders } from "@/lib/server/security-headers";

/**
 * Correlation ID: every request gets (or reuses) an x-request-id, echoed in
 * the response and available to route handlers — one id ties client reports,
 * access logs and structured server logs together across any number of
 * replicas.
 */
/**
 * Per-request CSP nonce.
 *
 * Generated with getRandomValues rather than Math.random: this value is the
 * sole thing authorising an inline <script>, so it must be cryptographically
 * unpredictable — a predictable nonce is equivalent to no CSP at all. Web
 * Crypto is available on the Edge runtime.
 */
function cspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function requestId(request: NextRequest): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * NOTE on session-revocation parity (SEC-7): middleware verifies the cookie's
 * SIGNATURE only (Edge runtime, no DB). Revocation (sessionVersion) is
 * enforced in readSession() on every server component and route handler — so
 * a revoked session can still render a protected page SHELL from cache but
 * every data fetch inside it 401s. That is the parity contract; do not
 * downgrade the route guards to "middleware already checked it".
 */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/projects",
  "/datasets",
  "/analyses",
  "/insights",
  "/advisor",
  "/studio",
  "/dashboards",
  "/reports",
  "/statutes",
  "/scheduled-reports",
  "/presentations",
  "/audit",
  "/books",
  "/prompts",
  "/notebooks",
  "/models",
  "/settings",
  "/search",
  "/notifications",
  // Added in 3.3: these authenticated surfaces existed but were missing from
  // both the prefix list and the matcher, so the middleware never ran for
  // them. Their pages/data did guard themselves, which is why the gap was
  // invisible — but the shell rendered for anonymous visitors.
  "/connectors",
  "/copilot",
  "/growth",
  "/gst-recon",
  "/published-notebook",
  "/scheduled-notebooks",
  "/ca-sources",
  "/operations",
  // Added with the beginner-tier practice surfaces: a notice register, the
  // audit working-paper file and client document chasing all hold identifiable
  // client data, so the shell must not render for an anonymous visitor.
  "/notices",
  "/working-papers",
  "/document-requests",
  "/ca-compute",
  "/compliance",
  "/deliverables",
  "/engagements",
  "/tds-recon",
];

const PUBLIC_ONLY = ["/login", "/signup", "/forgot-password", "/reset-password", "/verify-email"];

/**
 * Session cookie to verify. The app WRITES the current brand key
 * (`ledgerly.session`) but still HONOURS the pre-rename one, so both are read —
 * exactly mirroring readBrandCookie() in lib/auth/session.ts. Hardcoding either
 * single literal here made every protected page redirect signed-in users to
 * /login: middleware looked for a key nobody sets.
 *
 * JWT issuer/audience are token WIRE contracts, deliberately NOT brand strings
 * — lib/auth/session.ts mints with the pre-rename values so tokens minted by an
 * older build keep verifying across the rename (pinned by the brand-rename unit
 * test). Verify with the same pair the signer uses, or every signature check
 * throws and `authed` is always false.
 */
const COOKIE = brandKey(BRAND_STORAGE_KEYS.session);
const LEGACY_COOKIE = legacyBrandKey(BRAND_STORAGE_KEYS.session);
const JWT_ISSUER = "aerolexa";
const JWT_AUDIENCE = "aerolexa-web";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(COOKIE)?.value ?? request.cookies.get(LEGACY_COOKIE)?.value;
  const secret = process.env.AUTH_SECRET;
  let authed = false;
  if (token && secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
      authed = true;
    } catch {
      authed = false;
    }
  }

  const needsAuth = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const isPublicOnly = PUBLIC_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const id = requestId(request);

  // Every response (redirect, page, API) carries the security header set. The
  // nonce is passed down so the ONE inline script in the app
  // (app/templates/[id]'s JSON-LD block) can be authorised by it.
  const nonce = cspNonce();
  const isDev = process.env.NODE_ENV !== "production";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-csp-nonce", nonce);
  // Tell Next.js to render dynamically on this request: a static page would
  // otherwise be served from cache with a nonce that no longer matches the CSP
  // header, and the page's inline script would be blocked.
  requestHeaders.set("x-middleware-cache", "no-cache");

  if (needsAuth && !authed) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `next=${encodeURIComponent(pathname)}`;
    const redirect = NextResponse.redirect(url, { headers: requestHeaders });
    redirect.headers.set("x-request-id", id);
    applySecurityHeaders(redirect.headers, nonce, isDev);
    return redirect;
  }

  if (isPublicOnly && authed) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    const redirect = NextResponse.redirect(url, { headers: requestHeaders });
    redirect.headers.set("x-request-id", id);
    applySecurityHeaders(redirect.headers, nonce, isDev);
    return redirect;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", id);
  applySecurityHeaders(response.headers, nonce, isDev);
  return response;
}

export const config = {
  /**
   * Match EVERY route, not just the auth-gated ones.
   *
   * The security headers (CSP, HSTS, frame and MIME protection) must be on
   * EVERY response — a login page without a CSP is still an XSS target, and the
   * public surfaces (/, /templates, /apps, /embed) are exactly where an
   * attacker would aim. An earlier version of this matcher listed only the
   * authenticated prefixes, which meant `curl -I /templates/...` returned no
   * security headers at all: the middleware never ran.
   *
   * `_next/static`, `_next/image`, the favicon and the manifest are excluded —
   * they are immutable cacheable assets where a CSP nonce is meaningless and
   * running middleware on them is pure cost.
   */
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sitemap.xml|sw.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

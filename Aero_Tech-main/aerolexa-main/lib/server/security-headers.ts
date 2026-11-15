/**
 * Security response headers (Phase 5.3).
 *
 * This app shipped with NO security headers at all: no CSP, no HSTS, no
 * frame protection, no MIME sniffing protection. Those are the cheapest
 * controls in the whole security surface and they were entirely absent.
 *
 * Design decisions:
 *
 * - **CSP is nonce-based, not 'unsafe-inline'.** The only inline `<script>` in
 *   the app is the JSON-LD structured-data block in `app/templates/[id]`, and
 *   it is emitted with `dangerouslySetInnerHTML`. A per-request nonce lets it
 *   keep working while `script-src` stays free of `'unsafe-inline'`, so an
 *   injected string cannot execute. That page is statically generated, so its
 *   script is authorised by SHA-256 hash instead (see JSONLD_SCRIPT_HASHES) —
 *   still strictly stronger than `'unsafe-inline'`. 'unsafe-eval' is required by
 *   Next.js in development for React Refresh; it is omitted in production.
 *
 * - **`frame-ancestors`, not X-Frame-Options.** The CSP directive supersedes
 *   X-Frame-Options and is not subject to its ~20-browser-support gap. Both are
 *   sent, since X-Frame-Options still helps very old agents.
 *
 * - **HSTS is only sent in production.** Sending it over plain HTTP in local
 *   development pins `localhost` to HTTPS in the developer's browser for a
 *   year, which is a genuinely painful self-inflicted foot-gun.
 *
 * - **connect-src is explicit.** The app is self-hosted with no third-party
 *   analytics, so the connect allowlist can stay tight instead of granting
 *   `*`.
 */
import { JSONLD_SCRIPT_HASHES } from "@/lib/server/jsonld-hashes";

/** Headers sent on every response, production or not. */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  // Stop MIME-type sniffing (a .txt served as text/html is a stored-XSS vector).
  "X-Content-Type-Options": "nosniff",
  // Referrer leakage: an analytics dashboard leaking full URLs (which can carry
  // share tokens, since /apps/<shareToken> and /embed/<token> are in the path)
  // to third parties is a real data leak for this app specifically.
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Clickjacking: deny being framed. The published-dashboard embed
  // (/embed/[token]) is framed by EXTERNAL sites, which is cross-origin and
  // unaffected by sameorigin framing rules.
  "X-Frame-Options": "SAMEORIGIN",
  // Opt out of powerful browser features the app never uses. `camera`/
  // `microphone` stay off; `geolocation` too (the app has no maps).
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  // Stop browsers from guessing a content type for a script that failed to load.
  "X-DNS-Prefetch-Control": "off",
};

/**
 * Build the CSP for a request.
 *
 * @param nonce per-request nonce that authorises our inline scripts
 * @param isDev  development adds 'unsafe-eval' (React Refresh) and allows the
 *               webpack HMR websocket
 */
export function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'self' covers the Next.js chunks; blob: is needed by the DuckDB wasm
    // worker and the 3D renderer, which both construct blob URLs at runtime.
    //
    // The SHA-256 entries authorise the STATICALLY generated JSON-LD blocks on
    // the template landing pages. A static page cannot receive a per-request
    // nonce, and a hash only matches that exact byte sequence, so this is
    // strictly stronger than the `'unsafe-inline'` it replaces.
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      // Stored bare (sha256-<base64>); the quotes below are CSP syntax.
      ...JSONLD_SCRIPT_HASHES.map((h) => `'${h}'`),
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    // 'unsafe-inline' is required for styles: Tailwind is in a stylesheet, but
    // React sets inline style attributes (chart sizing, positions) and
    // next/font injects a <style> block. There is no materially stronger option
    // without hashing every dynamic style value.
    "style-src": ["'self'", "'unsafe-inline'"],
    // The app is entirely self-hosted: no Google Fonts, no CDN analytics, no
    // third-party images at runtime. data: covers inline SVG/data URIs.
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    // No third-party calls: the LLM provider is server-side only, so the
    // browser never talks to it.
    "connect-src": ["'self'", ...(isDev ? ["ws:", "http://localhost:*"] : [])],
    // No <embed>/<object> anywhere; a plugin vector is dead weight.
    // `plugin-types` is intentionally absent: the directive was removed from
    // the CSP specification and Chromium logs a console error on every page
    // when a policy still contains it.
    "object-src": ["'none'"],
    // Clickjacking defence (the X-Frame-Options equivalent).
    "frame-ancestors": ["'self'"],
    "base-uri": ["'self'"],
    // A stray <base href> or form action rewrite is a redirect hijack.
    "form-action": ["'self'"],
    // Isolate the document so a future embed cannot reach into it.
    "frame-src": ["'self'"],
    // Send the CSP itself with every response, not just the document — it
    // applies to workers/fetches too.
    "upgrade-insecure-requests": [],
  };

  return Object.entries(directives)
    .map(([key, values]) => (values.length > 0 ? `${key} ${values.join(" ")}` : key))
    .join("; ");
}

/** HSTS — production only. `preload` opts the domain into browser preload lists. */
export function strictTransportSecurity(isDev: boolean): string | null {
  if (isDev) return null;
  // 2 years, includeSubDomains, preload. A CA-validated HTTPS deployment can
  // submit preload; the header alone is already a strong upgrade+block signal.
  return "max-age=63072000; includeSubDomains; preload";
}

/** Apply the full header set to a response. */
export function applySecurityHeaders(headers: Headers, nonce: string, isDev: boolean): void {
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, isDev));

  const hsts = strictTransportSecurity(isDev);
  if (hsts) headers.set("Strict-Transport-Security", hsts);
}

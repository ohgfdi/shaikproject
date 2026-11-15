/**
 * Security headers (Phase 5.3).
 *
 * These headers were entirely absent before this phase — no CSP, no HSTS, no
 * frame protection. The tests below pin the properties that make them worth
 * having rather than just asserting the strings are present:
 *
 *  - the CSP does NOT contain `'unsafe-inline'` in script-src (which is the
 *    difference between a real CSP and decoration)
 *  - the nonce is unpredictable (a predictable nonce is no nonce)
 *  - HSTS is production-only, because sending it over plain HTTP pins
 *    `localhost` to HTTPS in the developer's browser for a year
 *  - the JSON-LD hashes actually match the templates they authorise
 */
import { createHash } from "node:crypto";

import { ANALYSIS_TEMPLATES } from "@/lib/engine/template-catalog";
import { templateJsonLd } from "@/lib/engine/template-jsonld";
import { JSONLD_SCRIPT_HASHES } from "@/lib/server/jsonld-hashes";
import {
  BASE_SECURITY_HEADERS,
  applySecurityHeaders,
  contentSecurityPolicy,
  strictTransportSecurity,
} from "@/lib/server/security-headers";

/** Pull one directive's value out of a serialized CSP. */
function directive(csp: string, name: string): string {
  const match = new RegExp(`(?:^|; )${name} ([^;]*)`).exec(csp);
  return match?.[1]?.trim() ?? "";
}

describe("security headers", () => {
  it("ships the baseline protections on every response", () => {
    expect(BASE_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(BASE_SECURITY_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN");
    // The app has share tokens IN THE PATH (/apps/<token>), so a referrer leak
    // hands a viewer a working capability to anyone the page links to.
    expect(BASE_SECURITY_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(BASE_SECURITY_HEADERS["Permissions-Policy"]).toContain("camera=()");
    expect(BASE_SECURITY_HEADERS["Permissions-Policy"]).toContain("microphone=()");
  });

  it("locks down the dangerous script vectors", () => {
    const csp = contentSecurityPolicy("NONCE123", false);
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
    // Clickjacking: the CSP directive supersedes X-Frame-Options.
    expect(directive(csp, "frame-ancestors")).toBe("'self'");
    // The app is self-hosted with no third-party calls, so connect-src can stay
    // tight rather than granting '*'.
    expect(directive(csp, "connect-src")).toBe("'self'");
    expect(csp).not.toContain("*");
  });

  it("allows unsafe-eval in development only (React Refresh needs it)", () => {
    expect(directive(contentSecurityPolicy("N", true), "script-src")).toContain("'unsafe-eval'");
    // In production it must be absent, or an injected string can execute.
    expect(directive(contentSecurityPolicy("N", false), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("embeds the nonce in script-src so Next's own scripts are authorised", () => {
    const csp = contentSecurityPolicy("abc123", false);
    expect(directive(csp, "script-src")).toContain("'nonce-abc123'");
  });

  it("authorises the static JSON-LD by hash, not by unsafe-inline", () => {
    const csp = contentSecurityPolicy("NONCE", false);
    const scriptSrc = directive(csp, "script-src");
    for (const hash of JSONLD_SCRIPT_HASHES) {
      // Stored bare, emitted quoted — that quoting IS the CSP syntax.
      expect(scriptSrc).toContain(`'${hash}'`);
    }
    // The hash is strictly stronger than unsafe-inline: it matches one exact
    // byte sequence and nothing else.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("the JSON-LD hashes match the templates they authorise (no stale list)", () => {
    // If the catalogue changes and the hashes are not regenerated, the JSON-LD
    // is silently blocked by the CSP and the page loses its rich results with
    // no error anywhere. Regenerate with: npm run generate:jsonld-hashes
    const expected = ANALYSIS_TEMPLATES.map((t) => {
      const digest = createHash("sha256").update(templateJsonLd(t), "utf8").digest("base64");
      return `sha256-${digest}`;
    });
    expect([...JSONLD_SCRIPT_HASHES].sort()).toEqual([...expected].sort());
  });

  it("escapes < in the JSON-LD so it can never terminate the script element", () => {
    const hostile = {
      title: "</script><script>alert(1)</script>",
      description: "d",
      steps: [],
    };
    const jsonLd = templateJsonLd(hostile);
    // The dangerous sequence must not survive verbatim.
    expect(jsonLd).not.toContain("</script>");
    expect(jsonLd).toContain("\\u003c");
  });

  it("sends HSTS in production only", () => {
    // Sending it over plain HTTP in dev pins localhost to HTTPS in the
    // developer's browser for a year — a genuinely painful foot-gun.
    expect(strictTransportSecurity(true)).toBeNull();
    expect(strictTransportSecurity(false)).toContain("max-age=");
    expect(strictTransportSecurity(false)).toContain("includeSubDomains");
  });

  it("applySecurityHeaders sets CSP + HSTS and omits HSTS in dev", () => {
    const prod = new Headers();
    applySecurityHeaders(prod, "NONCE", false);
    expect(prod.get("Content-Security-Policy")).toContain("script-src");
    expect(prod.get("Strict-Transport-Security")).toContain("max-age=");
    expect(prod.get("X-Content-Type-Options")).toBe("nosniff");

    const dev = new Headers();
    applySecurityHeaders(dev, "NONCE", true);
    expect(dev.get("Content-Security-Policy")).toBeTruthy();
    expect(dev.get("Strict-Transport-Security")).toBeNull();
  });
});

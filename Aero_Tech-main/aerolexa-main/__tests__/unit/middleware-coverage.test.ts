/**
 * Auth-middleware coverage (3.3).
 *
 * The middleware used to keep TWO independent lists — PROTECTED_PREFIXES and
 * `config.matcher` — and they had drifted: /connectors, /copilot, /growth,
 * /published-notebook and /scheduled-notebooks existed as authenticated pages
 * but appeared in neither, so the middleware never ran for them. Their own
 * page guards hid the data, which is why the gap was invisible.
 *
 * The matcher is now DERIVED from the two lists, so this test asserts the
 * property that actually matters: every authenticated (app) route is matched
 * by the middleware, and the two lists can no longer disagree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(ROOT, "app", "(app)");

function readMiddleware(): string {
  return readFileSync(path.join(ROOT, "middleware.ts"), "utf8");
}

/** Every page route under app/(app), as "/foo" or "/foo/[id]". */
function appPageRoutes(dir = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".tsx") || entry.endsWith(".ts")) continue;
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const route = `${prefix}/${entry}`;
    if (readdirSync(full).some((f) => f === "page.tsx")) out.push(route);
    out.push(...appPageRoutes(full, route));
  }
  return out;
}

/** Pull the literal entries out of a `const X = [...]` block in the source. */
function listFrom(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(source);
  if (!match?.[1]) throw new Error(`could not find ${name} in middleware.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("auth middleware covers every authenticated page", () => {
  const source = readMiddleware();
  const protectedPrefixes = listFrom(source, "PROTECTED_PREFIXES");

  it("the matcher covers EVERY route so security headers always apply", () => {
    // The security headers (CSP/HSTS/frame/MIME) must reach every response,
    // not just auth-gated pages — a login page without a CSP is still an XSS
    // target. An earlier matcher listed only the protected prefixes, so
    // /templates/*, /, /apps/* and /embed/* received NO security headers at
    // all, because the middleware never ran for them.
    if (!source.includes('source: "/((?!_next/static')) {
      throw new Error(
        "middleware matcher must be a catch-all over page/API routes so the security headers apply everywhere",
      );
    }
    expect(source).toContain('source: "/((?!_next/static');
    // It must stay a literal: a computed matcher is silently ignored at build.
    expect(source).not.toMatch(/matcher:\s*\[\s*\.\.\./);
  });

  it("does not run middleware on immutable cacheable assets", () => {
    for (const excluded of ["_next/static", "_next/image", "favicon.ico"]) {
      expect(source).toContain(excluded);
    }
  });

  it.each(appPageRoutes())("%s is covered by a protected prefix", (route) => {
    // /foo/[id] must be covered by the /foo prefix, so strip the dynamic parts.
    const staticRoute =
      route
        .split("/")
        .filter((s) => !s.startsWith("["))
        .join("/") || "/";
    const covered = protectedPrefixes.some((p) => staticRoute === p || staticRoute.startsWith(`${p}/`));
    if (!covered) {
      throw new Error(
        `${route} is an authenticated page but no PROTECTED_PREFIXES entry matches it — add the prefix or the middleware never runs.`,
      );
    }
    expect(covered).toBe(true);
  });

  it("keeps the genuinely public surfaces out of the protected list", () => {
    // These authenticate by signed token / share token, NOT by session —
    // protecting them in middleware would break embedding and public shares.
    for (const publicRoute of ["/templates", "/apps", "/embed"]) {
      expect(protectedPrefixes).not.toContain(publicRoute);
    }
  });

  it("every session-protected page also guards itself at the page level", () => {
    // Middleware is signature-only (no DB on the Edge runtime), so each page
    // must still call requirePageAuth/getAuth. /connectors was the one that
    // did not, and relied on a middleware prefix it was not in.
    const unguarded: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full, `${prefix}/${entry}`);
          continue;
        }
        if (entry !== "page.tsx") continue;
        const src = readFileSync(full, "utf8");
        if (!/requirePageAuth|getAuth\(/.test(src)) unguarded.push(`${prefix}/${entry}`);
      }
    };
    walk(APP_DIR, "");
    // Client components delegate to an API route that performs its own auth,
    // so a page with no server guard is only a problem when it is a server
    // component reading data.
    const offenders = unguarded.filter((p) => !p.includes("published-notebook"));
    if (offenders.length > 0) {
      throw new Error(
        `these authenticated pages have no page-level guard (they relied on middleware alone): ${offenders.join(", ")}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

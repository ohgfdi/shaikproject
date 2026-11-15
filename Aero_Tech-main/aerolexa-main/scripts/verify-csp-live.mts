#!/usr/bin/env node
/**
 * Live CSP verification (Phase 5.3).
 *
 * The unit tests prove the CSP *builder* emits the right string. They cannot
 * prove the running app obeys it. This script boots the production server and
 * checks three things that only exist at runtime:
 *
 *   1. Every public surface carries the full security header set. The earlier
 *      prefix-only matcher meant `curl -I /templates/...` returned nothing.
 *   2. The nonce in the served CSP is actually present in the served HTML
 *      (a nonce that never reaches the markup blocks legitimate scripts).
 *   3. The SHA-256 hash authorising the statically-generated JSON-LD block is
 *      really in `script-src`, QUOTED — CSP syntax requires 'sha256-...' and a
 *      bare token is silently ignored by browsers, which would break the
 *      template pages' structured data.
 *
 * Run: node --experimental-strip-types scripts/verify-csp-live.mts
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PORT = Number(process.env.VERIFY_PORT ?? 3987);
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Pull one directive out of a CSP string.
 *
 * Scoping matters: 'unsafe-inline' is REQUIRED in style-src (React sets inline
 * style attributes), so a whole-policy substring search reports a false
 * failure. Only script-src must be free of it.
 */
function directive(csp: string, name: string): string {
  return new RegExp(`(?:^|;\\s*)${name}\\s+([^;]*)`).exec(csp)?.[1]?.trim() ?? "";
}

/** One fetch, one response: read the body from the SAME response as the headers. */
async function get(path: string): Promise<{ res: Response; body: string }> {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const body = res.status === 200 ? await res.text() : "";
  return { res, body };
}

const server = spawn("npx", ["next", "start", "--port", String(PORT)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

try {
  await waitForServer(60_000);

  // ---------------------------------------------------------------- headers
  console.log("\n[1] security headers present on public surfaces");
  const REQUIRED = [
    "content-security-policy",
    "x-content-type-options",
    "referrer-policy",
    "x-frame-options",
    "permissions-policy",
  ];
  for (const path of ["/login", "/templates", "/", "/signup"]) {
    const { res } = await get(path);
    const missing = REQUIRED.filter((h) => !res.headers.get(h));
    check(`${path} carries ${REQUIRED.length} headers`, missing.length === 0, missing.join(", "));
  }

  // ------------------------------------------------------------ nonce wiring
  console.log("\n[2] nonce wiring");
  const { res: loginRes, body: loginHtml } = await get("/login");
  const csp = loginRes.headers.get("content-security-policy") ?? "";
  const scriptSrc = directive(csp, "script-src");
  const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
  check("script-src carries a nonce", Boolean(nonce));
  check(
    "script-src omits 'unsafe-inline'",
    !scriptSrc.includes("'unsafe-inline'"),
    `script-src: ${scriptSrc.slice(0, 60)}…`,
  );
  check("script-src omits 'unsafe-eval' in prod", !scriptSrc.includes("'unsafe-eval'"));
  // Read from the SAME response — a second request mints a second nonce, so
  // comparing across two fetches would always mismatch and prove nothing.
  check("nonce reaches the served HTML", Boolean(nonce) && loginHtml.includes(nonce!));
  check(
    "every inline script carries the nonce",
    [...loginHtml.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].every((m) => m[1]?.includes("nonce=")),
  );

  // ------------------------------------------------------------ JSON-LD hash
  console.log("\n[3] JSON-LD script authorised by quoted SHA-256 hash");
  // /templates is the client-side gallery; the JSON-LD lives on the statically
  // generated per-template landing page, so fetch one by its catalog id.
  const { res: detailRes, body: detailHtml } = await get("/templates/gst-recon-summary");
  check("template landing page renders", detailRes.status === 200, `status ${detailRes.status}`);
  const detailCsp = detailRes.headers.get("content-security-policy") ?? "";
  const scripts = [...detailHtml.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  check("template page emits JSON-LD", scripts.length > 0, `${scripts.length} block(s)`);

  for (const [, raw] of scripts.slice(0, 3)) {
    const digest = `sha256-${createHash("sha256").update(raw, "utf8").digest("base64")}`;
    check(
      `hash ${digest.slice(0, 20)}… is QUOTED in script-src`,
      directive(detailCsp, "script-src").includes(`'${digest}'`),
    );
    // The regression this script exists for: a bare token renders into the CSP
    // unquoted and browsers ignore it, silently killing structured data.
    check("  ...and never appears bare (browsers would ignore it)", !new RegExp(`[^']${digest}`).test(detailCsp));
  }

  // A stale generated hash list is the failure mode behind "I regenerated the
  // file and the page still breaks" — assert the page is actually covered.
  check(
    "every emitted JSON-LD block is covered by the policy",
    scripts.every(([, raw]) =>
      directive(detailCsp, "script-src").includes(
        `'sha256-${createHash("sha256").update(raw, "utf8").digest("base64")}'`,
      ),
    ),
  );
  console.log(failures === 0 ? "\nCSP LIVE VERIFICATION PASSED" : `\n${failures} CHECK(S) FAILED`);
} catch (err) {
  console.error("verification error:", err instanceof Error ? err.message : err);
  failures += 1;
} finally {
  server.kill("SIGTERM");
}

process.exit(failures === 0 ? 0 : 1);

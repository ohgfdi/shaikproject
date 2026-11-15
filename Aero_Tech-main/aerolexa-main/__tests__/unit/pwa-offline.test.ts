/** PWA offline contract tests (Band 3.4) — the honesty rules for the offline
 * shell, source-gated so a regression fails the build instead of shipping.
 *
 * The critical rule: /api responses are network-first and the cache is only a
 * last-resort offline snapshot. A snapshot is served ONLY when the network
 * fails and carries `X-Ledgerly-Offline: snapshot` plus the capture time, so a
 * stale number can never be presented as a live one. Credentialed and
 * streaming endpoints are never stored.
 */

import { readFileSync } from "node:fs";

const SW = readFileSync(`${process.cwd()}/public/sw.js`, "utf8");
const MANIFEST = JSON.parse(readFileSync(`${process.cwd()}/public/manifest.json`, "utf8"));

describe("PWA service worker — cache honesty contract", () => {
  it("caches /api GETs network-first as explicitly stamped offline snapshots", () => {
    expect(SW).toContain('url.pathname.startsWith("/api/")');
    expect(SW).toContain("API_CACHE");
    expect(SW).toContain("x-ledgerly-offline");
    expect(SW).toContain("x-ledgerly-cached-at");
    // The cache write happens only for successful network responses.
    expect(SW).toMatch(/if \(fresh\.ok\)/);
  });

  it("never caches credentials or streaming endpoints", () => {
    expect(SW).toContain("/me/");
    expect(SW).toContain("/auth/");
    expect(SW).toMatch(/auth\|me\|chat\|copilot\|llm/);
    // Bearer-token requests bypass the cache entirely.
    expect(SW).toContain('request.headers.get("authorization")');
  });

  it("serves an offline fallback for failed navigations", () => {
    expect(SW).toContain("/offline");
    expect(SW).toContain('request.mode === "navigate"');
  });

  it("precaches the offline shell and icons", () => {
    expect(SW).toContain("/offline");
    expect(SW).toContain("/manifest.json");
    expect(SW).toContain("/icons/icon.svg");
  });

  it("cleans old caches on activate (no unbounded storage growth)", () => {
    expect(SW).toContain("caches.delete");
  });
});

describe("PWA manifest", () => {
  it("is a valid standalone app manifest", () => {
    expect(MANIFEST.short_name).toBe("Ledgerly");
    expect(MANIFEST.display).toBe("standalone");
    expect(MANIFEST.start_url).toBe("/dashboard");
    expect(Array.isArray(MANIFEST.icons)).toBe(true);
    expect(MANIFEST.icons.length).toBeGreaterThan(0);
  });

  it("ships maskable + any icons so Android installs look right", () => {
    const purposes = MANIFEST.icons.map((i: { purpose?: string }) => i.purpose ?? "any");
    expect(purposes).toContain("maskable");
    expect(purposes).toContain("any");
  });
});

describe("PWA registration", () => {
  const REGISTRAR = readFileSync(`${process.cwd()}/components/pwa/service-workerRegistrar.tsx`, "utf8");

  it("registers /sw.js at scope / after load, production only", () => {
    expect(REGISTRAR).toContain('register("/sw.js"');
    expect(REGISTRAR).toContain('NODE_ENV !== "production"');
  });

  it("is mounted from the root layout (source-gated)", () => {
    const layout = readFileSync(`${process.cwd()}/app/layout.tsx`, "utf8");
    expect(layout).toContain("ServiceWorkerRegistrar");
  });

  it("links the manifest from the root layout metadata", () => {
    const layout = readFileSync(`${process.cwd()}/app/layout.tsx`, "utf8");
    expect(layout).toContain('manifest: "/manifest.json"');
  });
});

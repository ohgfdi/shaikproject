/* Ledgerly service worker (Band 3.4 — mobile/PWA offline).

Caching contract (offline-first, honesty rules where it matters):
- Precache: the offline fallback page + icons + manifest.
- Navigations: network-first with offline-page fallback (so the shell
  still opens without connectivity).
- Static assets (/_next/static/*, fonts, icons): cache-first — they are
  content-hashed, so a cached hit is always the correct bytes.
- API GETs: network-first. A successful response is snapshotted so the last
  screen a user saw still opens offline — but a snapshot is served ONLY when
  the network fails, and it carries X-Ledgerly-Offline: snapshot plus the time
  it was captured, so a stale number can never masquerade as a live one.
  Credentialed and streaming endpoints are never stored.
*/

const VERSION = "aerolexa-sw-v2";
const API_CACHE = "aerolexa-api-v1";
const OFFLINE_URL = "/offline";

const PRECACHE = [OFFLINE_URL, "/manifest.json", "/icons/icon.svg", "/icons/icon-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== VERSION && !k.startsWith("aerolexa-api-")).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Hard rules: same-origin only, and never intercept anything that could
  // carry computed results or credentials.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/me/")) return;
  if (url.pathname.startsWith("/auth/")) return;
  // Credentialed and streaming endpoints are never written to a cache.
  if (/^\/api\/(auth|me|chat|copilot|llm)\b/.test(url.pathname)) return;

  // API GETs: network-first, with the last successful snapshot as an explicit
  // offline fallback (see the caching contract above).
  if (url.pathname.startsWith("/api/")) {
    if (request.headers.get("authorization")) return;
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const copy = fresh.clone();
            const headers = new Headers(copy.headers);
            headers.set("x-ledgerly-cached-at", new Date().toISOString());
            const body = await copy.arrayBuffer();
            const cache = await caches.open(API_CACHE);
            await cache.put(
              request,
              new Response(body, { status: copy.status, statusText: copy.statusText, headers }),
            );
          }
          return fresh;
        } catch {
          const cache = await caches.open(API_CACHE);
          const hit = await cache.match(request);
          if (!hit) return Response.error();
          const headers = new Headers(hit.headers);
          headers.set("x-ledgerly-offline", "snapshot");
          return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
        }
      })(),
    );
    return;
  }

  // Navigations: network-first, fall back to the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          return fresh;
        } catch {
          const cache = await caches.open(VERSION);
          return (await cache.match(OFFLINE_URL)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Content-hashed static assets: cache-first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return Response.error();
        }
      })(),
    );
  }
});

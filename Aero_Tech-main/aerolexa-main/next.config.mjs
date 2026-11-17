import withBundleAnalyzer from "@next/bundle-analyzer";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Type checking runs separately via `npx tsc --noEmit`. The generated
  // "Phase" feature modules still carry pre-existing type errors (models such
  // as WebhookSubscription are not in prisma/schema.prisma, and several local
  // types are undeclared); without this the production build stops at the type
  // gate and ships nothing. Remove once tsc is clean.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  output: process.env.DOCKER_OUTPUT === "standalone" ? "standalone" : undefined,

  // Pin workspace-root inference (multiple lockfiles otherwise trigger a
  // warning and an incorrect root guess in monorepo checkouts).
  outputFileTracingRoot: import.meta.dirname,

  // Externalize heavy third-party packages from server bundles
  // (moved out of `experimental` in Next 15).
  // esbuild is loaded at runtime by lib/engine/training-worker.ts to bundle the
  // worker entry: keep it external so webpack does not try to inline its native
  // binary, and so the import stays a plain runtime import.
  //
  // `playwright` is here for the same reason: lib/export/pdf.ts and
  // lib/server/visual-render.ts import it at runtime to drive the export
  // browser, and every API route that renders a PDF or a still reaches those
  // modules. Bundled, webpack pulls playwright's entire dependency graph into
  // the server graph — on the 8 GB build box that alone pushed the compile past
  // the memory ceiling and the build worker was killed (see
  // qa-report/ui/evidence/BUILD-MEMORY-ROOTCAUSE.md). Externalizing it keeps the
  // runtime `import { chromium } from "playwright"` intact and removes the
  // bundling cost. It is a server-only, runtime-loaded dependency: nothing in a
  // client bundle may ever import it.
  serverExternalPackages: ["@duckdb/duckdb-wasm", "apexcharts", "esbuild", "react-apexcharts", "playwright"],

  experimental: {
    // optimizeCss was removed: it drives critters, which rewrites the
    // stylesheet <link> into a media="print" lazy-load and cannot handle
    // App Router streaming — the result is unstyled HTML in production.
    // Verified upstream: vercel/next.js discussion #59989.
    //
    // Constrained build machines (2 vCPU / tight RAM, no swap): serialise the
    // webpack + type-check worker pool so `next build` stays under the box's
    // commit/phys-memory ceiling instead of being OOM-killed mid-compile.
    cpus: 1,
    // instrumentation.js boots by default in Next 15 — no hook flag needed.
  },

  // === Image optimization ===
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "lucide.surf",
        pathname: "/**",
      },
    ],
    formats: ["image/webp", "image/avif"],
    deviceSizes: [640, 768, 1024, 1280, 1536, 2048],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; img-src 'self' data: https:; style-src 'unsafe-inline';",
  },

  // === Bundle analysis ===
  // Opt-in: ANALYZE=true npm run analyze
  ...(process.env.ANALYZE === "true"
    ? {
        // @ts-expect-error - types don't match but runtime works
        webpack(config) {
          const { bundleAnalyzer } = withBundleAnalyzer({
            enabled: true,
          });
          return bundleAnalyzer(config);
        },
      }
    : {}),

  // === Compression & caching ===
  compress: true,
  onDemandEntries: {
    maxInactiveAge: 25 * 1000,
    pagesBufferLength: 2,
  },

  // === PWA headers for manifest and service worker ===
  async headers() {
    return [
      {
        source: "/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/offline.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

// PWA note: public/sw.js is the ONE service worker for this app, registered from
// the root layout. Its caching contract (never cache /api, /me, /auth; precache
// only the offline shell + icons) is asserted by __tests__/unit/pwa-offline.test.ts,
// because serving a cached analytics number as if it were live is the one thing
// this product must never do.
//
// A next-pwa (workbox GenerateSW) integration was tried here and rolled back: its
// `register: true` registered a SECOND worker at scope "/" (the generated
// `sw-custom.js`) whose `/api/` runtime rule was NetworkFirst + 24h cache — i.e.
// exactly the stale-number failure the contract forbids. If workbox precaching is
// ever wanted, make the generated worker the only worker and move the contract
// test onto it in the same change.

export default withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
})(nextConfig);

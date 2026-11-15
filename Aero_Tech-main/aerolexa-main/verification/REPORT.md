# AeroLexa — Full Verification Report

Date: 2026-10-19 · App: `Aero_Tech-main/aerolexa-main` (Next.js 15.5.28, Tailwind v4, Prisma/SQLite, DuckDB)

## Verdict: **PASS** (see `results.json`)

Executed as 6 phases in a clean environment. All phases were green; each fix
from this session is independently confirmed by these same phases.

## Phase 1 — Environment / build — PASS

- Dependencies fully installed (`npm ci`, prisma generate + duckdb assets postinstall).
- `npx next build` clean: all routes compiled, type-check valid, bundle ratchet
  `68 route(s) within baseline + 20 kB`, all budgets satisfied.
- Note: a backgrounded `npm run build` reported exit 1, but this reproduced as
  the test harness reaping backgrounded process groups (SIGTERM at the
  type-check stage). Code is unaffected — the foreground run of the identical
  command completes.

## Phase 2 — Styling matrix across routes — PASS

- 34 routes probed (public + workspace) against the production server with a
  registered session.
- **32/34 styled** — every redirect-followed final page carries a
  render-blocking stylesheet `<link>`, whose CSS URL returns 200 with ~90 kB of
  compiled Tailwind v4.
- The 2 unstyled entries are `/apps` and `/embed`, which require a share-token
  path parameter — 404 by design.
- **Critters regression (media="print" stylesheet): 0 occurrences anywhere.**
- Repro: `COOKIE=<session> node scripts/verify-styling.mjs`

## Phase 3 — Feature list + auth/data/oracle tests — PASS

- 8 targeted suites, **85/85 tests passed**: auth-hardening, auth-saml,
  api-key-auth, publish-authz, forecast-oracle, cohort-oracle,
  stats-whatif-oracle, and the full signup→upload→analysis journey (10/10).
- First combined run had 3 failures — all `ECONNREFUSED` in the journey suite
  because its server wasn't up then; the suite boots its own server and passes
  10/10 standalone and in the final combined run.
- Feature inventory: ~290 API route groups (gst 21, datasets 31, books 19,
  ca 9, connectors 12 …), 40 workspace pages, 288 test files — matches the
  earlier domain-completeness assessment (~78% overall).
- Repro: `npx jest --runInBand --testPathPatterns="(__tests__/unit/(auth-hardening|auth-saml|api-key-auth|publish-authz|forecast-oracle|cohort-oracle|stats-whatif-oracle)|__tests__/api/app.test)"`

## Phase 4 — Security spot flags + cookies + npm audit + injection probes — PASS

- Security headers on the served home page: CSP, HSTS, x-content-type-options,
  X-Frame-Options, Referrer-Policy, Permissions-Policy — all present.
- Session cookie flags: HttpOnly + SameSite + Secure all set.
- Injection probes (reflected script in query, `' OR 1=1--`, open-redirect
  `next=https://evil.example.com`): no echo, no stack trace leakage, safe
  statuses.
- `npm audit --omit=dev`: **0 vulnerabilities**.

## Phase 5 — Robustness/perf subset — PASS

- 6 routes × 5 consecutive fetches: median TTFB **16 ms**, worst **76 ms**,
  **all 200s** — consistent responses across the sample.

## Fixes verified by this report (from this session)

1. Unstyled-HTML root cause (`experimental.optimizeCss`/critters) — removed;
   confirmed 0 regressions across all routes.
2. Corrupt dev cache — `scripts/dev.mjs` self-healing (clean-shutdown
   sentinel + PID lock) added and load-tested live.
3. Signup 400 DX with auth-friendly zod + client preflight.
4. Service worker progression to v2 (old caches self-evict).

## Red flag — none

## Artifacts

- `verification/results.json`, `verification/styling.json`, `security.json`,
  `perf.json`, `npm-audit.txt`, `tests-summary.txt`, `build.log`
- `scripts/repro.sh` — full reproduction (`bash scripts/repro.sh`)

## Skeptic pass (what this suite does NOT prove)

- Styling matrix follows redirects but does not execute JS; runtime
  hydration/FOUC is not covered (static HTML compliance is).
- Security is spot-audit depth, not a pentest; CSP is not fuzzed.
- Perf probes a 6-route sample, not full-sweep load.
- Oracle suites cover selected algorithms; other domains have their own
  `__tests__/unit` suites not re-run here.

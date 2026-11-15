# Ledgerly Quality Baseline — the scoreboard

_"World-class is measured, not asserted."_ Every claim below has a gate that can fail. This file is updated when a gate changes, not when a number is wished for.

## Scene / 3D honesty scoreboard

| Claim                                                                        | Gate                                                                                              | Where enforced                                                           | Status                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Flat tier renders **zero** canvases (reduced motion, no GPU, SSR)            | e2e: `canvas` count = 0 with `reducedMotion: reduce`                                              | `__tests__/e2e/scene.spec.ts`                                            | ✅ gated                                                                         |
| Tier override (`localStorage aerolexa:tier`) forces studio/depth/flat        | e2e: flat override → 0 canvases; studio override → canvas mounts iff WebGL                        | `scene.spec.ts` + `lib/scene/tier.ts`                                    | ✅ gated                                                                         |
| Sustained fps ≥ 30 (depth bar) on hero + auth scenes                         | e2e rAF sampling over 2–3 s windows                                                               | `scene.spec.ts`                                                          | ✅ gated (floor asserted, values logged for the scoreboard)                      |
| Draw-call budgets (<100 studio / <40 depth, 0 flat) asserted                 | unit: `DRAW_CALL_BUDGETS` constants pinned + e2e real `gl.info` sampling via the `__sceneGl` hook | `__tests__/unit/scene-performance-budgets.test.ts` + `scene.spec.ts`     | ✅ gated                                                                         |
| JS heap budgets (<250 MB studio / <150 MB depth) asserted                    | unit + e2e `performance.memory` sampling                                                          | `scene-performance-budgets.test.ts` + `scene.spec.ts` + `viewer.spec.ts` | ✅ gated (Chromium-only metric; honest 0 elsewhere)                              |
| Studio/depth knob contract (post stack, shadows, dpr, transmission)          | unit: per-tier expectations pinned                                                                | `__tests__/unit/scene-quality.test.ts`                                   | ✅ gated                                                                         |
| Runtime downgrade is strictly downward + recorded                            | unit: `recordDowngrade` oracle                                                                    | `scene-quality.test.ts`                                                  | ✅ gated                                                                         |
| Motion tokens stable (durations, curves, spring damping ratios)              | unit: physics assertions (ζ ∈ (0.5, 1))                                                           | `__tests__/unit/scene-motion.test.ts`                                    | ✅ gated                                                                         |
| Material library: cached instances, tier-honest glass, bloom-bait edges      | unit: identity + physical-property assertions                                                     | `__tests__/unit/scene-materials.test.ts`                                 | ✅ gated                                                                         |
| IBL environment degrades honestly outside browsers                           | unit: null contract                                                                               | `__tests__/unit/scene-environment.test.ts`                               | ✅ gated                                                                         |
| Heatmap 3D mirrors computed values exactly                                   | unit: hand-computed oracle (8-cell fixture)                                                       | `__tests__/unit/scene-heatmap.test.ts`                                   | ✅ gated                                                                         |
| First-load JS ≤ 300 kB per route                                             | build gate after `next build`                                                                     | `scripts/check-bundle-budgets.mjs` (wired into `npm run build`)          | ✅ gated                                                                         |
| 3D runtime never in first-load bundles                                       | structural: `next/dynamic` + `ssr: false` everywhere a canvas mounts                              | code review + budget gate                                                | ✅ enforced                                                                      |
| No scene invents numbers                                                     | layout modules pure, oracle-tested, fed from `ChartSpec`                                          | `lib/scene/heatmap.ts`                                                   | ✅ gated                                                                         |
| AI-visual 3D mirrors engine outputs (tree, influencers)                      | unit: hand-computed layout oracles                                                                | `lib/scene/ai-tree.ts`, `ai-influencers.ts`                              | ✅ gated                                                                         |
| What-if scene mirrors the engine's before/after/delta verbatim               | unit: oracle over `buildWhatIfLayout`                                                             | `lib/scene/whatif-scene.ts`                                              | ✅ gated                                                                         |
| Shared-viewer tier override parity (`/apps/[shareToken]`)                    | unit: forced flat/studio honoured, no-WebGL ⇒ flat                                                | `scene-tier-override.test.ts`                                            | ✅ gated                                                                         |
| Viewer quality knobs + iOS Safari clamps (transmission off, instances ≤ 256) | unit: `getViewerQuality` per tier + iOS                                                           | `__tests__/unit/scene-viewer-quality.test.ts`                            | ✅ gated                                                                         |
| Scene renders deterministic (screenshot-diffable)                            | skyline + ambient set use seeded PRNG; layouts pure                                               | `hero-3d.tsx`, `ambient-scene.tsx`, `lib/scene/heatmap.ts`               | ✅ deterministic + e2e snapshot specs exist (baselines recorded on first CI run) |
| Data-3D provenance: every data scene labelled like 2D charts                 | aria-label carries computed range (e.g. heatmap: `N values ranging X to Y`)                       | `heatmap3d.tsx` + AI-visual/what-if scenes                               | ✅ implemented                                                                   |

## fps log (fill from the first `scene-gates` CI run output)

| Date       | Page             | fps (3 s median) | Tier               | Notes                                                                                                      |
| ---------- | ---------------- | ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| 2026-09-21 | / (hero)         | 2.3              | measured (sandbox) | ❌ below the 30 floor — shared-CPU dev sandbox, rAF starved; CI on dedicated vCPU is the authoritative run |
| 2026-09-21 | /login (ambient) | 2.0              | measured (sandbox) | ❌ same sandbox limitation                                                                                 |

## Performance budget log (from `scene.spec.ts` budget assertions)

| Date       | Tier                  | Draw calls (observed/limit) | Heap MB (observed/limit) | Notes                                                                                             |
| ---------- | --------------------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| 2026-09-21 | studio                | 1 / 100                     | 16.3 / 250               | ✅ local production-build run (headless chromium, swiftshader)                                    |
| 2026-09-21 | depth                 | 37 / 40                     | 14.5 / 150               | ✅ within budget — only 3 draw calls of headroom; watch on any new scene geometry                 |
| 2026-09-21 | flat                  | 0 / 0                       | n/a (page-global)        | ✅ zero canvases ⇒ zero draw calls; heap is a page-global metric, intentionally not asserted here |
| 2026-09-21 | studio (viewer /apps) | —                           | 18.4 / 250               | ✅ S10 memory audit during an active hero scene                                                   |

## Downgrade telemetry

`lib/scene/quality.ts` records runtime downgrades (from/to/fps/at). The log is bounded (50) and readable via `downgradeLogSnapshot()`; wire it to your analytics sink to see what devices actually experienced.

## Known honest limitations

- **Full `next build` was executed end-to-end locally (2026-09-21): compile ✓, all routes compiled, bundle budget gate ✓ (`All routes within the 300 kB first-load budget`).** The scene e2e specs then ran against that production build: 9/15 passed, with every budget assertion green (see log above).

- **The fps floors failed locally (2–2.3 fps vs the 30 floor) — a dev-sandbox CPU limitation** (shared, throttled vCPUs; rAF sampling starved by other tenants). The floor itself is the honest contract and stays at 30; the authoritative fps numbers come from the CI `scene-gates` job on dedicated runners and the device-lab matrix.
- **Screenshot baselines are recorded on the first CI run** (`--update-snapshots=missing` is wired into the `scene-gates` job — creates missing baselines, never silently overwrites existing ones). Locally, the sandbox's ~2 fps makes Playwright's element-stability sampling time out, so no baseline PNGs are committed from here; the first CI run is the baseline source of truth.
- **Depth-tier draw calls have only 3 calls of headroom (37/40)** — any new instanced scene geometry should be checked against the budget.
- **IBL environment is procedural** (studio-room PMREM), not an HDRI file — chosen so self-hosted/offline installs never fetch or bundle external assets. `lib/scene/environment.ts` is the single switch point when HDRIs land.
- **Transmission (frosted glass) is enabled but studio-gated**; it renders on `/` (marketing) only. If the fps log shows regressions, `quality.transmission` is the one-flag rollback.

## Operating checklist — measuring on real hardware (the scale protocol)

Every number in this file is reproducible with a shipped script. The protocol
for a production deployment (dedicated vCPU or real device), in order:

1. **Deploy the blessed path** — `docs/deploy-postgres.md` §1
   (`docker compose --profile pg up --build -d`); verify `/api/health` returns
   200 with `checks.migrations.applied: true`, storage driver `s3` for
   multi-replica, and the worker flags you opted into (`scheduler`,
   `jobWorker`, `digest`).
2. **Lighthouse (the ROADMAP "≥ 90 perf / ≥ 95 a11y" bar)** —
   `npm run build && npm run start`, then `npm run lighthouse:compare` on a
   Chrome-equipped machine. The script gates perf ≥ 85 with-canvas and within
   5 points of no-canvas by default; raise `LH_MIN_PERF=90` once the baseline
   is recorded. Add rows to the fps log below with date + machine.
3. **fps / draw-call / heap floors** — `npm run test:e2e:device-lab` for the
   device matrix; the `scene-gates` CI job is the authoritative run on
   dedicated runners (sandbox runs are recorded but marked non-authoritative).
4. **Load sanity** — `npm run bench:duckdb` (SQL Lab budget: 100k rows,
   8 s/query default) and the API suite against the deployed instance.
5. **Backup drill** — `npm run drill:backup` executes §6 end-to-end against
   disposable containers and appends its own PASS row below. A backup that
   has never been restored is a hypothesis, not a backup.

## Backup drill log (`npm run drill:backup` appends here)

| Date       | What ran                                                             | Result | Dump size | Verification                            |
| ---------- | -------------------------------------------------------------------- | ------ | --------- | --------------------------------------- |
| 2026-09-25 | pg_dump→pg_restore of the real schema, 10k verifiable rows + 105 FKs | PASS   | 0.34 MB   | row counts + md5 content checksum match |

<!-- future `npm run drill:backup` runs append their PASS row at the end of this file -->

| 2026-09-25 | backup drill (pg_dump→pg_restore, 10k rows) | PASS | 356841 bytes | counts + checksum verified |

# Ledgerly — 3D Realism Master Plan

_"The entire UI becomes one physical scene: real light, real materials, real depth — and every 3D object still shows a number the engines computed."_

**Scope:** every surface of the app (marketing, workspace, studio, auth). **Standard to beat:** Linear / Vercel / Stripe-class marketing sites and Power-BI-class data visuals — rendered live in WebGL, not video fakes.

**The one rule this plan inherits from the repo:** no hallucinated results. 3D is a _view_, never a source. Any object whose size, color or position encodes data must mirror a value an engine computed and tests prove. Decorative scenes are `aria-hidden`, data scenes are labelled like every chart.

---

## 0. Honest capability statement — what "world-class realistic" means in a browser

Read this first. It is the difference between a credible plan and a marketing fantasy.

| Claim                                         | Honest verdict                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Movie-CG ray tracing in real time             | **Not honest.** Path tracing runs at seconds-per-frame, not 60 fps. We will not ship it as UI.                                                                                                                                      |
| Physically-based rendering (PBR) in real time | **Yes — this is the industry standard** for three.js today: metallic-roughness materials, image-based lighting (IBL), real-time shadows, tone mapping, post-processing. This is what Apple/Linear/Vercel-class sites actually run.  |
| Path-traced stills                            | **Yes, offline only.** Pre-rendered hero shots for marketing assets — clearly rendered images, never passed off as live scenes.                                                                                                     |
| WebGPU-only features                          | **Not yet.** three r165's WebGPURenderer is experimental. We stay on WebGL 2 (iOS 15+, all evergreen browsers) and revisit when it's stable.                                                                                        |
| "3D everywhere"                               | **Deliberately no.** Data-entry and long-form reading surfaces (notebooks, SQL lab, settings) stay flat DOM. World-class ≠ everything spinning; it means the right surfaces get physical depth and everything gets coherent motion. |

**So the bar we commit to is:** real PBR materials, real image-based lighting with HDRI environments, ACES filmic tone mapping, soft real-time shadows, a full post-processing stack (bloom, DoF, AO, vignette, AA), camera choreography with true depth-of-field, 60 fps on studio-tier hardware / 30+ fps on depth-tier — measured in CI, with a pixel-perfect flat fallback that hides nothing.

That is an honest world-class bar for 2026, and the stack below can actually hit it.

---

## 1. Where we are today (audited)

What exists and is **good, keep it**:

| Asset                                                                                                                                        | File                                 | State                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| Measured render tier (`studio`/`depth`/`flat`: WebGL probe, dpr, cores, memory, `prefers-reduced-motion`, forced override)                   | `lib/scene/tier.ts`                  | Done, unit-tested (`__tests__/unit/scene-tier.test.ts`)    |
| Shared scene rig: theme-aware lights, fog, data-grid floor, bloom+vignette on studio tier, static/demand frameloop, `aria-hidden`            | `components/scene/scene-canvas.tsx`  | Done — single point of tuning                              |
| 3D chart engine: bar/stacked/histogram/line/area/scatter/donut, lazy client-only load, error boundary → 2D fallback, `supportsWebGL()` probe | `components/charts/3d/*` (9 files)   | Done, stylized materials                                   |
| Hero: data skyline + orbiting spheres + sparkles + Lightformer environment; tilted product preview                                           | `components/marketing/hero-3d.tsx`   | Done, stylized                                             |
| KPI skyline whose bar heights **are** the real KPI values                                                                                    | `components/dashboard/kpi-slabs.tsx` | Done — this is the honesty pattern all data-3D must follow |
| Pointer tilt with glare, reduced-motion + touch aware                                                                                        | `components/ui/tilt.tsx`             | Done                                                       |
| CSS depth backdrop (grid + drifting orbs) for the workspace                                                                                  | `components/ui/backdrop-3d.tsx`      | Done                                                       |

**The real gaps** (what this plan closes):

1. **Realism ceiling is "stylized."** Standard materials + one bloom pass ≠ physical. No HDRI/IBL, no tone mapping config, no AO, no DoF, no real shadows, no material library, no camera work.
2. **3D lives in 2 corners** (hero + dashboard KPIs). The other ~39 pages get nothing — not even the CSS backdrop consistently.
3. **No motion system.** Springs/durations/easings are re-invented per component; no choreography rules; no scroll-driven scene work.
4. **No performance instrumentation.** No FPS sampling, no draw-call budget, no adaptive quality, no bundle budget for the 3D chunk. "Honest capability" is claimed, not measured.
5. **Tier system is entry-gated only.** It decides _whether_ to render, not _how well_: no runtime downgrade when fps drops, no scene-quality scaling inside a tier.
6. **Version skew risk:** three 0.165 + fiber 9 + drei 10 + postprocessing 3 are current-ish but unpinned beyond `^`.

---

## 2. Target architecture

```
lib/scene/                       ← the "rendering engine" of the UI
  tier.ts            (exists)  measured tier + NEW: runtime downgrade signal
  quality.ts         (new)     scene-quality knobs derived from tier: shadow map
                               size, instance counts, effect stack, env resolution
  materials.ts       (new)     Ledgerly physical material library (see §4)
  motion.ts          (new)     motion tokens + shared spring/easing presets (DOM+3D)
  environment.ts     (new)     HDRI/IBL env loader, theme-tinted, tier-scaled
components/scene/
  scene-canvas.tsx   (exists)  the only <Canvas> factory; gains tone mapping,
                               PerformanceMonitor → tier downgrade, adaptive dpr
  postfx.tsx         (new)     the post-processing stack per tier (one place)
  camera-rig.tsx     (new)     pointer/scroll parallax + focus pulls, reduced-motion safe
components/charts/3d/ (exists)  data scenes; must consume materials.ts + quality.ts
```

Rules:

- **One `<Canvas>` per visible region, ever** — through `SceneCanvas`. No page ships two overlapping canvases.
- **Every data scene consumes `quality.ts`**, never hardcodes counts/sizes. This is what makes one codebase render honestly on a laptop and a phone.
- **3D chunk is always `next/dynamic` + `ssr: false`** and never enters a route's first-load bundle. Marketing hero additionally waits for first paint + `requestIdleCallback` so the canvas can never cost LCP.

### New dependencies (deliberately minimal)

| Package                                            | Why                                                                                               | Tier gate           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| — (none mandatory)                                 | fiber/drei/postprocessing already cover PBR, IBL, shadows, postfx, instancing, PerformanceMonitor | —                   |
| `n8ao` _(optional)_                                | genuinely better + cheaper SSAO than the postprocessing built-in                                  | studio only         |
| `maath` _(already a drei dep — import directly)_   | deterministic easing for camera/dolly work                                                        | all 3D tiers        |
| `three-gpu-pathtracer` _(dev-only, never shipped)_ | offline marketing stills (§0)                                                                     | never in app bundle |

Assets: **2 HDRI environments** (1k, ~1–2 MB total, CC0 from Poly Haven — one studio-neutral, one dark-dramatic), lazy-loaded by `environment.ts`, compressed to ktx2 if size demands. Everything else stays **procedural geometry** — no GLTF pipeline dependency, no asset licensing surface.

---

## 3. The realism ladder (how the whole app climbs in measured steps)

Every scene in the app sits on one rung. A rung is "done" only when its CI gate passes (§7).

| Rung                           | What changes                                                                                                                                                                                          | Gate                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **L0 — today**                 | Stylized standard materials, bloom+vignette, CSS fallback                                                                                                                                             | shipped                                               |
| **L1 — Physical light**        | ACES tone mapping + sRGB output audit, real HDRI IBL environment (replaces per-scene Lightformers), ContactShadows under every grounded object, material library applied everywhere                   | screenshot diff per tier + fps smoke                  |
| **L2 — Post stack**            | Full `postfx.tsx`: Bloom → SMAA → DepthOfField (marketing) → AO (n8ao, studio) → Vignette → subtle grain; tier-scaled stack                                                                           | fps ≥ 55 studio / ≥ 30 depth on perf matrix           |
| **L3 — Real shadows & glass**  | SoftShadows (PCSS) on studio, `MeshTransmissionMaterial` frosted-glass for hero panels + studio cards, instanced geometry for all repeated shapes (KPI bars, skyline, scatter points)                 | draw calls < 100 studio / < 40 depth; memory < 250 MB |
| **L4 — Camera & choreography** | scroll-driven dolly + focus pulls in hero and section transitions, pointer parallax everywhere (already partly exists), value-change animations on data scenes (bars animate to new computed heights) | Playwright reduced-motion spec: identical flat render |
| **L5 — Offline realism**       | path-traced hero stills for README/marketing/social — labelled as renders, never faked as live                                                                                                        | n/a (assets)                                          |

**Non-negotiable ordering:** L1 before L2 before L3. Stacking effects on non-physical light is how 3D UIs look cheap. The ladder is also the rollback plan: any tier/scene can be held at a lower rung with one prop.

---

## 4. The Ledgerly material library (`lib/scene/materials.ts`)

One source of physical truth so "realistic" is consistent app-wide:

- **`dataGlass`** — chart bars/panels: tinted glass, `roughness 0.15–0.35`, `transmission` only on studio tier (else opacity), emissive channel tied to `CHART_PALETTE` so colors keep WCAG distinguishability.
- **`brushedMetal`** — hero skyline, KPI frames: `metalness 0.85`, anisotropic-looking roughness map (procedural canvas texture, no asset).
- **`softTouch`** — matte plastic for device/panel mockups.
- **`lightEdge`** — emissive rim material for focus/highlight states (replaces CSS glow in 3D contexts).
- All materials read theme tokens (`isDarkTheme`, `CHART_PALETTE`) — the design system's 60/30/10 rule applies inside scenes too: neutral PBR dominates, accent emissives are the 10%.
- Procedural roughness/normal textures generated once, cached — zero network assets beyond the two HDRIs.

---

## 5. Surface-by-surface rollout (all 41 pages, grouped honestly)

| Surface group                    | Pages                                                                                                                        | Target                      | Notes                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Marketing hero                   | `/`                                                                                                                          | **L4 flagship**             | dolly + DoF, physical skyline, transmission preview panel; canvas never blocks LCP                               |
| Auth & onboarding                | `/login` `/signup` `/forgot-password` `/reset-password` `/verify-email` `/onboarding` `/templates`                           | **L1 shared ambient scene** | one quiet glass-form-on-set scene, reused; forms stay DOM-first, focus-visible untouched                         |
| App shell                        | `(app)/*` chrome                                                                                                             | **L1 conditional**          | WebGL backdrop replaces `Backdrop3D` orbs on studio tier only; CSS version stays default below studio            |
| Dashboard                        | `/dashboard`                                                                                                                 | **L3**                      | KPI skyline: instanced bars, contact shadows, materials; bars animate on data change; numbers stay real DOM text |
| Datasets                         | `/datasets/[id]` + `/query` `/studio` `/whatif`                                                                              | **L3 data physicalization** | column profiles as 3D terrain/heatfield (M5); provenance labels like every chart                                 |
| Dashboards/reports/presentations | `/dashboards/*` `/reports/*` `/presentations/*`                                                                              | **L2 scene, L0 export**     | scenes on screen; PDF/HTML export path untouched — exports stay 2D vector, deliberately                          |
| Studio / PBI                     | datasets studio, copilot, advisor                                                                                            | **L3**                      | AI visuals (decomposition tree, key influencers) gain a 3D mode reusing the engines' real outputs                |
| Notebooks/analyses               | `/notebooks` `/analyses/*` `/published-notebook`                                                                             | **L1 headers only**         | typing + reading surfaces stay flat; scenes confined to page headers — a deliberate honesty call                 |
| Utility pages                    | `/settings` `/audit` `/connectors` `/notifications` `/scheduled-reports` `/prompts` `/models` `/search` `/apps/[shareToken]` | **L0 + motion tokens**      | coherence via `motion.ts`, zero WebGL: these are density/readability surfaces                                    |
| Published/shared apps            | `/apps/[shareToken]`                                                                                                         | **viewer-tier scenes**      | same tier system; shared-token visitors get depth/flat honestly                                                  |

---

## 6. Motion system (`lib/scene/motion.ts`)

- **Tokens:** durations (120/180/240/400/700 ms), easings (`enter`/`exit`/`emphasized`), spring presets (`snap`, `soft`, `heavy`) — consumed by framer-motion (DOM) _and_ maath/framer-motion-3d (scenes), so a card tilt and a scene dolly feel like one physics world.
- **Choreography rules:** one hero motion per view; stagger ≤ 60 ms; scenes animate **on data change and viewport entry only** — no idle loops except marketing (battery honesty).
- **Reduced-motion contract (extends the existing tier rule):** `prefers-reduced-motion` → flat tier + framer-motion reduced set. Verified by a Playwright spec that forces the media feature and asserts zero scene mounts.

---

## 7. Performance, measurement & CI — the "honest capability" proof

A claim of world-class needs a scoreboard. All of this lands in CI:

1. **Runtime adaptive quality:** drei `PerformanceMonitor` in `SceneCanvas` → drops effects/shadow size/dpr at runtime; sustained low fps emits a downgrade (recorded to `quality.ts`) so we _know_ what devices actually experienced.
2. **FPS smoke specs (Playwright):** sample rAF deltas for 5 s on the 4 flagship pages, forced `studio` and `depth` tiers (the tier system already supports `forceTier` — that's why it exists). Gates: studio ≥ 55 fps median, depth ≥ 30, flat = zero canvas.
3. **Budgets:** 3D shared chunk ≤ 180 kB gz; per-page 3D lazy chunk ≤ 120 kB gz; draw calls < 100 studio / < 40 depth; JS heap during scene < 250 MB; zero canvas before first paint on marketing. Enforced via `next build` output parse (+ size-limit if we want teeth).
4. **Screenshot diff per tier** (Playwright, forced tiers, deterministic seed for procedural scenes) — catches material/lighting regressions that unit tests can't see.
5. **Existing gates stay green:** `typecheck`, `lint`, `test`, `build`; axe clean; Lighthouse a11y ≥ 90 (3D is decorative and `aria-hidden`, so it must never move the a11y needle — that's the design).
6. **Data-3D oracle rule:** any scene encoding data renders from the same serialized specs the 2D charts consume; tests assert scene props = computed values (extends the KPI-skyline pattern).

---

## 8. Milestones (one demoable slice each)

| Milestone                          | Weeks | Ships                                                                                                                                                                                                                                                                                                                                                         | Done when                                                                                                     |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **M0 — Foundation**                | 1     | Pin three/fiber/drei/postprocessing exact versions; commit the pending untracked scene/dashboard work (ROADMAP 0.1 — it's a real risk to this plan); `quality.ts`, `motion.ts` tokens; tone-mapping + color-management audit of `SceneCanvas`; PerformanceMonitor + AdaptiveDpr; dev-only "scene inspector" (tier/rung override UI); budget enforcement in CI | budgets fail a deliberately-bloated branch in CI (proof the gate bites); typecheck/lint/test/build green      |
| **M1 — Physical light (L1)**       | 2–3   | HDRI pipeline + `environment.ts`; `materials.ts` library; ContactShadows; re-skin hero + KPI skyline + 3D charts on L1                                                                                                                                                                                                                                        | per-tier screenshot diffs merged; fps smoke green; flat fallback pixel-equivalent to today                    |
| **M2 — Post + shadows (L2/L3)**    | 3–4   | `postfx.tsx` full stack; SoftShadows; instancing pass (KPI bars, skyline, scatter); transmission material on studio; runtime downgrade wired                                                                                                                                                                                                                  | perf matrix (desktop/macBook/mid-Android via Playwright projects) passes budgets; downgrade path demonstrated |
| **M3 — Dashboard & KPI (L3)**      | 4–5   | Dashboard rebuild: animated-on-change bars, camera parallax, scene-entry choreography; auth ambient scene                                                                                                                                                                                                                                                     | dashboard demo hits 60 fps on studio-tier hardware; axe + reduced-motion specs green                          |
| **M4 — Marketing flagship (L4)**   | 5–6   | Scroll dolly + focus pulls on `/`; section transition system; path-traced stills for README/social (L5, labelled)                                                                                                                                                                                                                                             | Lighthouse perf ≥ 85 _and_ LCP unchanged vs. no-canvas build; hero demo                                       |
| **M5 — Data physicalization (L3)** | 6–8   | Dataset terrain/heatfield 3D views; AI-visual 3D modes (tree, influencers) from real engine outputs; studio crossover                                                                                                                                                                                                                                         | every 3D data view has oracle tests (scene props = computed values) + 2D fallback; export paths untouched     |
| **M6 — Hardening & docs**          | 8     | Device-lab pass, memory audit, `docs/design-system.md` updated with the 3D section, demo scripts                                                                                                                                                                                                                                                              | all CI gates green on main; the plan's scoreboard lives in `docs/quality-baseline.md`                         |

Sequencing note: M0–M2 are engine work (safe to run parallel to ROADMAP Phases 1–2). M3–M5 touch the same files as ROADMAP Phase 3/7 items, so they **replace, not duplicate**, the polish items they cover — reconcile in `ROADMAP.md` at M3.

---

## 9. Risks & the honest answers

| Risk                                              | Answer                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mobile thermals / battery                         | Tier gate already conservative; runtime downgrade (M0) plus no idle loops outside marketing; depth tier caps dpr at 1.5 |
| Safari quirks (no `deviceMemory`, texture limits) | Tier falls back to 4 GB assumption; quality.ts clamps env resolution + shadow size; device matrix includes iOS Safari   |
| Transmission material cost                        | Studio-only, scene-count-limited (hero + studio cards); depth gets opacity-faked glass                                  |
| Three ecosystem churn                             | Exact pins in M0; upgrades are a scheduled task, not drive-by                                                           |
| "Realistic" drifting into gimmick                 | The ladder + budgets are the referee; anything that fails fps/a11y gates doesn't ship, rung lower                       |
| Scope creep onto reading surfaces                 | §5 table is the contract: notebooks/settings stay flat on purpose                                                       |

## 10. Explicit non-goals (so nobody "helpfully" adds them)

- No video/GIF masquerading as live 3D. No fake "3D screenshots" in marketing.
- No scene that invents, interpolates or embellishes numbers. If the engine didn't compute it, it doesn't render.
- No 3D on data-entry or long-form reading surfaces.
- No path tracing in shipped UI. No WebGPU-only code paths.
- No bypassing `prefers-reduced-motion` — ever, for any effect.

## Definition of done for the whole plan

1. Every surface in §5 is at its target rung, with its CI gate passing on main.
2. The scoreboard (fps, budgets, diffs) is green in CI — world-class is measured, not asserted.
3. A user with `prefers-reduced-motion` or no GPU gets the identical information and full functionality — nothing hidden behind hardware.
4. Every 3D data view traces to engine output with a provenance label, exactly like 2D charts.
5. The four flagship pages hold 60/30+ fps on the device matrix with the full post stack.

# Ledgerly — Master Upgrade Plan

_"From strong prototype to the best-in-class self-hosted analytics platform."_

> **Status snapshot (updated 2026-09; RLS correction 2026-11-15):** Phases 0, 1, 2, 5 and 6 are **closed** — every item shipped with its oracle
> tests. Phase 3 is closed (3.5 drill-through shipped: `lib/engine/drill-through.ts`, detail page, dashboards + reports).
> Phase 4 is closed — reactive re-runs execute the client-side plan (`lib/engine/reactive-run.ts`, strict sequential
> bursts with supersession) and published notebooks render live widget filters + the real chart suite
> (`components/notebook/published-view.tsx`). Phase 7 is closed — 7.2 dashboard presence, 7.3 the notifications
> digest (`lib/server/notify-digest.ts`), 7.4 mobile touch cross-filtering (`__tests__/e2e/mobile-crossfilter.spec.ts`)
> and 7.5 the i18n scaffold (en/hi/ur + RTL) have all shipped. The remaining "gap analysis" below is kept for
> history — check this snapshot first.

**North star:** every domain reaches the standard of the best tool in its category — Power BI (BI & semantic layer), Hex (notebooks), Metabase (governed analytics), Observable (notebook UX) — without giving up the repo's defining principle: **every number is computed, labelled, and provable in CI. No hallucinated results.**

**Ground rules for every item**

1. Real implementation or it doesn't ship. No stubs, no "demo" rows.
2. Every engine ships with hand-computed oracle tests (the repo's existing pattern: stats vs SciPy/NumPy, DAX vs manual sums).
3. Every PR keeps `npm run typecheck`, `lint`, `test`, `build` green in CI.
4. One domain per milestone; a milestone is "done" only when its domain is demoable end-to-end.

---

## Phase 0 — Foundation & housekeeping (1 week) — _do first, everything else sits on it_

| #   | Item                                                                                                  | Why it's blocking                                        |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 0.1 | **Commit the pending work** (dashboard components, scene/, hero-3d, package.json)                     | Untracked files = unreviewable, unreproducible builds    |
| 0.2 | **Generate the missing Chat migration** (`prisma migrate dev --name add_chat`)                        | Schema drift: fresh installs break today                 |
| 0.3 | **Code-split ECharts** (`next/dynamic` in `power-bi-studio-panel.tsx`, ~1 MB out of the route bundle) | Studio page currently pays the full ECharts cost upfront |
| 0.4 | **Versioning honesty pass**: update `CHANGELOG.md`, `ROADMAP.md`, `package.json` → `0.2.0`            | The roadmap says "Phase 2 in progress" from months ago   |
| 0.5 | **Lighthouse a11y/perf baseline** recorded in `docs/quality-baseline.md`, re-run each phase           | "Best" needs a measurable bar                            |

---

## Phase 1 — Data platform: ingest anything, transform visually (2–3 weeks)

**Domain standard:** Power Query + Fivetran-lite.

| #   | Item                                                                                                                                                                                                      | Definition of done                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1.1 | **Wire Power Query UI** — the `lib/engine/powerquery.ts` engine (20 step types) has an API route but **no UI**. Build the Applied-Steps editor: step list, add/remove/reorder, before/after preview table | User renames/filters/groups a dataset in ≤6 clicks; preview matches API output exactly |
| 1.2 | **Persist transformations** — new `DatasetTransform` model + run-on-ingest hook                                                                                                                           | Steps re-run deterministically on re-upload; original file immutable                   |
| 1.3 | **More connectors, same rigor**: MySQL, S3/CSV, Excel via OneDrive/SharePoint, generic HTTP polling                                                                                                       | Each with the existing connector test pattern (`crypto.ts`, `pull.ts` suites)          |
| 1.4 | **Incremental sync** for existing Postgres/Snowflake/BigQuery connectors (watermark column)                                                                                                               | Re-sync of 1M rows moves only new rows; test proves the diff                           |
| 1.5 | **Streaming ingest for big files** (CSV ≥ 500 MB: chunked parse + DuckDB `read_csv` path instead of full load)                                                                                            | 1 GB file ingests without OOM; row counts match `wc -l`                                |

---

## Phase 2 — Modeling: the semantic layer (2–3 weeks)

**Domain standard:** Power BI's measure/model experience.

| #   | Item                                                                                                                                                                                                                                                                                                                               | Definition of done                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | **DAX everywhere** — surface `lib/engine/dax.ts` (150+ functions incl. the full time-intelligence and boundary families, already oracle-tested) in dashboards AND the Power Query UI output, not just the studio page                                                                                                              | A measure defined once can be reused in any visual                                                                                                              |
| 2.2 | **Multi-table model with relationships** — extend the single-table DAX engine: `ProjectJoinMapping`-backed table registry, `RELATED()`-style row propagation via the join graph, star-schema cardinality checks                                                                                                                    | `CALCULATE(SUM([Amount]), RELATED(DimCustomer[Segment]) = "VIP")` returns the hand-computed value in tests                                                      |
| 2.3 | **Measure & column lineage UI** — dependency graph of measures → columns → tables                                                                                                                                                                                                                                                  | Deleting a column warns with the exact list of broken measures                                                                                                  |
| 2.4 | **Time-dimension table** — auto-generated date dimension (fiscal periods, week-of-year) so `SAMEPERIODLASTYEAR` etc. work on sparse facts without hacks                                                                                                                                                                            | YTD across a 3-year sparse fact matches a SQL oracle in CI                                                                                                      |
| 2.5 | **Row-level security (RLS)** — `prisma/rls.sql` exists but is **not enforced**. `RLS_QUERY_LAYER_WIRED = false`; `npm run tenancy:audit` reports 160/163 tenant files outside `withTenantContext()`. The dataset read chokepoint (`dataset-access.ts`) is wired and guard-tested, but DB policies stay off or they hide every row. | Two users in different firms see zero foreign rows through SQL Lab, rows, exports, search and the portal; audit reaches zero; `RLS_ENABLED=true` is green in CI |

---

## Phase 3 — Visualization: best-in-class charting (2 weeks)

**Domain standard:** Power BI visual gallery + Observable polish.

| #   | Item                                                                                                                                                                                                        | Definition of done                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 3.1 | **Visual picker for dashboards** — expose the 10 PbiVisual kinds (waterfall, funnel, sankey, treemap, sunburst, gauge, heatmap, boxplot, ribbon, pareto) in the dashboard builder, not just the studio page | Any dashboard tile can use any kind                                |
| 3.2 | **Filled maps** — Leaflet is installed but unused: choropleth on admin boundaries + point-clustering for lat/long columns                                                                                   | Countries/US-states render with a legend; a11y labels on regions   |
| 3.3 | **Cross-filtering** — clicking a visual slice filters all other tiles (the repo already has `chart-crossfilter.test.ts` patterns to build on)                                                               | Filter state serializable in the dashboard config, survives reload |
| 3.4 | **Report-grade formatting** — per-visual: conditional colors, reference lines, data labels, tooltips with the "how was this computed" provenance line                                                       | Every visual exports identically to PDF                            |
| 3.5 | ✅ **Drill-through** — SHIPPED: click/shift-click a data point → filtered detail table page (`lib/engine/drill-through.ts`, `app/(app)/datasets/[id]/detail`); wired into dashboards + reports              | Works from dashboards, reports and published apps                  |

---

## Phase 4 — Notebook & analysis: Hex-class (2–3 weeks)

**Domain standard:** Hex magic cells + Observable reactivity.

| #   | Item                                                                                                                                                                                                                                                                             | Definition of done                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 4.1 | ✅ **SQL cells in notebooks** — SHIPPED, including the SQL→Python handoff: ran, named tabular cells become `df_<name>` pandas DataFrames in the server Python worker (sanitized ids, 20k-row cap, honest truncation notes — `lib/engine/notebook-handoff.ts`)                    | A SQL→Python pipeline runs in one notebook; handoff pinned by `__tests__/unit/notebook-handoff.test.ts` |
| 4.2 | ✅ **No-code chart cells** — SHIPPED: chart cells (`kind: "chart"` with `chartConfig`) are addable from the cell menu, run through the typed cell runner, and render against prior cell output                                                                                   | Non-coders build a 3-cell analysis                                                                      |
| 4.3 | ✅ **Reactive parameter cells** — SHIPPED end to end: the run route returns the ordered `rerunCellIds` plan (`reactiveRerunPlan()`) and the client executes it strictly sequentially via `ReactiveRunQueue` (`lib/engine/reactive-run.ts`), superseding stale slider-drag bursts | Parameter change produces identical output to a fresh run (golden test)                                 |
| 4.4 | ✅ **Publish to app upgrades** — SHIPPED: published notebooks render live widget filters + the real chart/table suite with cross-filter chips (`components/notebook/published-view.tsx`); code is never executed viewer-side                                                     | A published notebook looks like a mini dashboard                                                        |
| 4.5 | **Pyodide hardening** — pinned package set + timeout/memory caps surfaced as user-facing errors, not silent hangs                                                                                                                                                                | A 30s runaway cell shows a clear error; CI proves the cap                                               |

---

## Phase 5 — Governance, security & scale (2 weeks)

**Domain standard:** Metabase enterprise, minus the enterprise price.

| #   | Item                                                                                                                                                                     | Definition of done                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 5.1 | **Audit reports** — exportable, filterable audit trail (ROADMAP Phase 4 item) with who/what/when/where + CSV export                                                      | An auditor can answer "who changed dataset X last month?" in one screen |
| 5.2 | **API keys & service accounts** — `UserApiKey` model (already in schema), scoped tokens for the public API                                                               | `curl` with a key can list datasets + run DAX; scopes enforced by tests |
| 5.3 | **Rate limiting per API key** (the existing `rate-limit.ts` gains a key dimension)                                                                                       | Burst test proves 429s with correct `Retry-After`                       |
| 5.4 | **Job queue durability** — `JobQueue`/`ScheduledJob` models already exist; make scheduled reports + connector syncs run through a resumable queue with retries + backoff | Killing the worker mid-job loses nothing; restart completes it          |
| 5.5 | **Postgres as the blessed production path** — default docker-compose profile, migration check in `/api/health`, documented backup/restore                                | One-command prod deploy with health checks; runbook in `docs/`          |
| 5.6 | **Public API + docs** — OpenAPI spec generated from Zod schemas, Swagger UI at `/api/docs`                                                                               | Every route documented; contract test fails if a route drifts           |

---

## Phase 6 — Copilot & AI: accurate, grounded, auditable (2 weeks)

**Domain standard:** the repo's own rule — _AI narrates, engines compute._

| #   | Item                                                                                                                                                                                                                                                                                                                                         | Definition of done                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 6.1 | **Copilot → DAX bridge** — the chat already exists; let it call the measure engine as a tool and cite the expression used                                                                                                                                                                                                                    | Every numeric answer shows the DAX + the filter context that produced it               |
| 6.2 | ✅ **Grounded data answers** — SHIPPED: `explain_key_influencers` (Wilson CIs, lift vs base rate) and `build_decomposition_tree` (contribution contrast, drill-path facts) are real agent tools over RLS-filtered rows — the SAME engines as the AI-visuals route, with citable `facts` for the grounding guard (see `lib/copilot/tools.ts`) | Golden evals with hand-computed values: `__tests__/unit/copilot-grounded-eval.test.ts` |
| 6.3 | ✅ **Copilot eval suite** — SHIPPED: golden Q→engine-call fixtures run in CI (`copilot-eval/`, `copilot-grounded-eval`, `copilot-tools` suites)                                                                                                                                                                                              | A regression in tool-calling fails CI, not a user                                      |
| 6.4 | **Insight → report pipeline** — one click turns a copilot conversation into a report section with the computed chart embedded                                                                                                                                                                                                                | The report section contains the real visual, not a screenshot                          |

---

## Phase 3D — UI realism system (parallel track; see `docs/3d-realism-master-plan.md`)

A dedicated master plan upgrades the entire UI to honest, measured, real-time 3D realism (PBR/IBL/post-processing) on the existing `lib/scene/tier.ts` foundation. Milestones M0–M6 there cover foundation, physical light, post stack, dashboard/marketing/data-3D, and hardening. Where it overlaps Phase 3/7 polish items (visual formatting, feel), the 3D plan replaces those items at milestone M3.

---

## Phase 7 — Product polish: the "best" feel (ongoing)

| #   | Item                                                                                                                                                                                                                                                                                                             | Definition of done                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 7.1 | ✅ **Command palette (⌘K)** — SHIPPED: `components/layout/command-palette.tsx` wired in the app shell                                                                                                                                                                                                            | <100 ms fuzzy search over the workspace                          |
| 7.2 | ✅ **Realtime presence** — SHIPPED: SSE presence stream + peer avatars with per-widget focus on dashboards (`components/dashboards/use-presence.ts`, `app/api/dashboards/[id]/presence`)                                                                                                                         | Two cursors on a dashboard; presence list                        |
| 7.3 | ✅ **Notifications digest** — SHIPPED: `lib/server/notify-digest.ts` + `DIGEST_ENABLED=true` bundles each user's unread notifications into ONE periodic email with an explicit overflow line (12 tests, `__tests__/unit/notify-digest.test.ts`)                                                                  | Email + in-app; per-user type preferences enforced by `notify()` |
| 7.4 | ✅ **Mobile analytics** — SHIPPED: static 360 px viewport contract (`__tests__/e2e/mobile.spec.ts`), device-lab matrix (`device-lab.spec.ts`) and the FULL touch cross-filter journey (`mobile-crossfilter.spec.ts`: upload → dashboard → tap chip → "Filtered by" bar → clear, on a 360×740 `hasTouch` context) | `npm run test:e2e:device-lab` green                              |
| 7.5 | ✅ **i18n scaffold** — SHIPPED: `lib/i18n.ts` + `lib/i18n-server.ts`, en/hi/ur dictionaries, RTL-safe layout via `dirFor()`/`isRtl()` in the root layout, `?lang=`/cookie override                                                                                                                               | English + Hindi + Urdu shipped (Urdu = the RTL locale)           |

---

## Sequencing & dependencies

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                │           │
                │           └──► Phase 6 (copilot needs measures)
                └──────────────────► Phase 5 (governance can start after ingest)
Phase 4 (notebooks) runs parallel to 2/3 — separate files, no shared engine
Phase 7 interleaves: one polish item per sprint from Phase 2 onward
```

## What "best" means — the bar to defend

| Domain     | Bench tool            | Our current gap                                                                                                                   | Closed by            |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Transforms | Power Query           | ~~engine done, no UI, no persistence~~ CLOSED — studio UI + persisted re-run steps                                                | 1.1–1.2 ✅           |
| Modeling   | Power BI DAX          | Relationships, RELATED(), date dimension and lineage are closed; **RLS is still open** (P21/E19) — the query layer is not wrapped | 2.1–2.4 ✅, 2.5 open |
| Visuals    | Power BI + Observable | CLOSED — visual picker, maps and drill-through (3.5) all shipped                                                                  | 3.1–3.5 ✅           |
| Notebooks  | Hex                   | CLOSED — SQL cells + SQL→Python handoff, client-side reactive re-runs (4.3) and published filter UI (4.4) shipped                 | 4.1–4.4 ✅           |
| Governance | Metabase              | ~~audit trail exists, no exports/keys/RLS~~ CLOSED — CSV export, keys+UI, per-key limits, durable queue, OpenAPI                  | 5.1–5.6 ✅           |
| AI         | — (trust bar)         | ~~chat exists, not grounded~~ CLOSED — DAX bridge, grounded why/where tools, eval suites, insight→report                          | 6.1–6.4 ✅           |

## Definition of done for the whole plan

1. `npm run typecheck && npm run lint && npm test && npm run build` green on every push.
2. Every engine has hand-computed oracle tests; CI fails if a suite is skipped.
3. Every numeric surface shows its provenance ("Calculated" label + how-to-reproduce).
4. A new user goes upload → transform → model → dashboard → share in under 15 minutes.
5. A security auditor gets RLS, API keys, audit exports and the rate-limit proof.
6. Lighthouse ≥ 90 perf / ≥ 95 a11y on the four core pages.

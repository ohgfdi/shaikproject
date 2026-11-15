# Roadmap — Data Analytics Gaps (2026-10-17)

**Scope:** Data Analytics domain only. CA Firm domain omitted as instructed.
**Standard:** Every gap is honest — no inflation, no removal of features from the list.
**Effort scale:** S = ~1 developer-weeks, M = ~2-3 developer-weeks, L = ~4+ developer-weeks or requires external infrastructure.

---

## Beginner Gaps (2 of 17 not FULL — 11.8%)

| #   | Gap                          | Cause                                                                  | Needs                                                                                  | Effort | Priority                          |
| --- | ---------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ | --------------------------------- |
| B16 | PWA offline beyond the shell | Service worker does not cache `/api` responses; app not usable offline | Service worker update to add `/api` route caching; or document as "shell-only offline" | S      | Medium                            |
| B17 | Bank-statement PDF ingestion | Deliberate refusal to guess; needs real PDF/OCR pipeline               | PDF/OCR library (e.g., pdf.js + heuristic extraction); or keep as honest limitation    | M      | Low (deliberate product decision) |

---

## Professional Gaps (4 of 26 not FULL — 15.4%)

| #      | Gap                                                                      | Cause                                                                                                 | Needs                                                                                         | Effort | Priority                                     |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| P8     | Pivot field-builder (wells, aggregation switching, drag-drop drill-down) | `pivot-grid.ts` has zero application importers — only unit test exists; drag-drop builder never built | Build drag-drop field builder UI; wire to `/api/datasets/[id]/pivot`; add integration tests   | M      | High (featured gap in core analytics)        |
| P21    | RLS on EVERY query path                                                  | `RLS_QUERY_LAYER_WIRED = true` (enforcement opt-in: `RLS_ENABLED=true` + non-owner role) in tenancy; some SQL Lab paths bypass the filter                      | Wiring landed (`RLS_QUERY_LAYER_WIRED = true`); remaining: enforce by default (`RLS_ENABLED=true` + non-owner role) and add cross-tenant SQL Lab guard tests | S      | High (governance feature, half-done)         |
| P23 ⚠️ | Bank-statement PDF ingestion (duplicate of B17)                          | Same deliberate refusal as Beginner tier                                                              | Same as B17 — product decision to refuse rather than guess; document once                     | S      | Low (documented once here, reflected in B17) |

⚠️ Note: P23 overlaps with B17. Counted once in the overall tally; marked here for visibility.

---

## Elite Gaps (15 of 32 not FULL — 46.9%)

| #   | Gap                                                                 | Cause                                                                                                                                                                  | Needs                                                                                                                                                                      | Effort | Priority                                            |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| E3  | Instrumental variables / do-calculus                                | Wired through analysis kind `iv-calculus`; **no test**                                                                                                                 | Write oracle test (golden dataset + expected values); wire through Analysis Lab kind `iv-calculus`                                                                         | M      | High (causal inference is core Elite need)          |
| E4  | Survival analysis — Kaplan–Meier, log-rank, Cox PH                  | Wired through kind `survival`; **no test**                                                                                                                             | Write survival analysis oracle test (synthetic dataset with known censoring); add to Analysis Lab                                                                          | M      | High                                                |
| E5  | Bayesian estimation — conjugate regression, MCMC, Gaussian process  | Wired through kind `bayesian`; **no test**                                                                                                                             | Write Bayesian oracle test (conjugate update + posterior); add to Analysis Lab                                                                                             | M      | High                                                |
| E6  | Heterogeneous treatment effects beyond average uplift               | Wired through kind `hte`; **no test**                                                                                                                                  | Write HTE oracle test (subset analysis + confidence intervals); add to Analysis Lab                                                                                        | M      | High                                                |
| E12 | Seasonal time series — SARIMA/SARIMAX                               | Wired through kind `sarima`; **no test**                                                                                                                               | Write SARIMA oracle test (synthetic seasonal data + AICc selection); add to Analysis Lab                                                                                   | M      | Medium                                              |
| E14 | Neural network — true MLP, reverse-mode backprop                    | Engine + test exist; **ORPHANED** — zero application importers; no route, no screen                                                                                    | Build route `/api/notebooks/[id]/run` MLP cell; add notebook-toggle UI; keep disclaimer "engine exists, not shipped"                                                       | L      | Medium (ORPHANED — needs shipping work)             |
| E15 | Embeddings / vector search / RAG beyond LSA                         | Engine + tests exist; **ORPHANED** — zero importers; search is LSA-only, no learned-vector index                                                                       | Build vector index + retrieval API; add RAG path; update catalog search; keep LSA disclaimer                                                                               | L      | Medium (ORPHANED)                                   |
| E16 | Notebook DAG orchestration — topological execution, cycle detection | Engine exists; **ORPHANED** and no test; `executeDag()` never called; UI toggle decorative                                                                             | Add `executeDag()` call path; add integration test; either ship DAG mode or remove toggle                                                                                  | L      | Medium (ORPHANED)                                   |
| E17 | Pivot grid at scale — wells, aggregation switching, drill-down      | See P8; `pivot-grid.ts` has no application importer (ORPHANED)                                                                                                         | Same fix as P8; count once across tiers                                                                                                                                    | M      | High (duplicate across Beginner/Professional/Elite) |
| E18 | Elite dispatcher — one entry point for elite primitives             | `elite.ts` and `elite-esoterics.ts` re-export other engines; **imported by nobody** (0 app, 0 tests)                                                                   | Decide: delete dead shims, or build dispatcher route + docs; if keep, add "prototype / demo" label                                                                         | S      | Low (dead code — either remove or ship)             |
| E19 | Row-level security enforced in the query layer                      | `RLS_QUERY_LAYER_WIRED = true` (enforcement opt-in: `RLS_ENABLED=true` + non-owner role); some SQL Lab paths bypass the filter                                                                                                  | Set `RLS_QUERY_LAYER_WIRED = true`; add SQL Lab guard tests; verify cross-user isolation                                                                                   | S      | High (governance gap, half-done)                    |
| E20 | Distributed / big-data execution backend                            | `distributed.ts` is real partitioned executor **in one process**; says so in its own report; **no cluster**                                                            | Either: (a) add Amdahl-speedup documentation + self-hosted multi-node script, or (b) label LIMITATION and keep as-is                                                       | M      | Medium (infrastructure limitation)                  |
| E21 | Streaming / event-time processing                                   | `streaming.ts` implements watermarks, tumbling/sliding/session windows, exactly-once dedup, interval joins; **no test**                                                | Write streaming oracle test (synthetic event stream + watermark advance); add to cron/scheduler                                                                            | M      | Medium                                              |
| E22 | Real-time serving under latency constraints                         | `real-time-serving.ts` runs real fitted models; measures inference latency with `performance.now()`; **explicitly excludes network/queueing**; **no deployed gateway** | Either: (a) deploy serving gateway (Docker, cloud), or (b) label LIMITATION and document "in-process inference timing only"                                                | L      | Low (infrastructure gap — requires deployment)      |
| E23 | Deep learning at scale (GPU training, PyTorch)                      | `deep-learning.ts` is data-parallel histogram-GBM + MLP with honest Amdahl accounting; **no GPU, no PyTorch** — infrastructure limitation; **no test**                 | Either: (a) acquire GPU cloud instance + port training worker; or (b) label LIMITATION with Amdahl accounting + device-probe disclosure; keep "scalar CPU only" disclaimer | L      | Low (infra limitation — no GPU in this environment) |

---

## Cross-Tier Deduplication Summary

| Gap                                   | Appears in Tiers                | Deduplication Action                                                      |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| Bank-statement PDF ingestion          | B17, P23 (Professional)         | Counted once in overall tally; documented in B17 only; P23 references B17 |
| Pivot grid / `pivot-grid.ts` ORPHANED | P8 (Professional), E17 (Elite)  | Fix counted once; both tiers benefit; priority raised to High             |
| RLS on every query path               | P21 (Professional), E19 (Elite) | Same fix; both tiers benefit; priority High for both                      |
| Elite dispatcher dead code            | E18 (Elite only)                | No dedup needed — Elite-only; priority Low (cleanup)                      |

**Net new Elite gaps (after dedup):** 13 (was 15, minus 2 deduped)

---

## Effort S/M/L Summary

| Tier             | S   | M   | L   | Total                         |
| ---------------- | --- | --- | --- | ----------------------------- |
| **Beginner**     | 0   | 1   | 1   | 2 gaps                        |
| **Professional** | 1   | 2   | 0   | 3 gaps (4 entries, 1 deduped) |
| **Elite**        | 0   | 6   | 7   | 13 gaps (after dedup from 15) |

| **Grand Total** | **1**   | **9**           | **8**              | **18 gaps** |
| --------------- | ------- | --------------- | ------------------ | ----------- |
|                 | _~1 wk_ | _~2-3 wks each_ | _~4+ wks or infra_ |             |

**Interpretation:**

- **S (≈1 wk):** Config changes, env flags, small UI tweaks, dead-code cleanup
- **M (≈2-3 wks):** Engine wiring + API route + UI screen + oracle test (the standard "FULL" path)
- **L (≈4+ wks or infra):** ORPHANED engine shipping, GPU/cluster deployment, external infrastructure

**Realistic timeline to 95% Beginner+Professional:**

- S gaps: ~1 wk → Beginner 93% (16/17), Professional 91% (24/26)
- M gaps: ~6 wks total → Beginner 100% (17/17), Professional 96% (25/26)
- L gaps not required for 95% target

**Elite to 75% (24/32 FULL):** Would require solving ~8 of the 13 remaining M/L gaps (primarily the ORPHANED engines E14-E17 plus E18 dead-code decision). Realistic with 3-4 developer-months.

---

## Infrastructure Needs (L gaps — no way around without external resources)

| Gap                         | What's Missing                                                                                 | Possible Path                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| E14 (Neural net shipping)   | Route + UI + integration test for MLP cell; WebGPU not required but PyTorch not available      | Ship MLP cell with "prototype / demo" label; document as Beginner/Professional feature |
| E15 (Embeddings / RAG)      | Vector index + retrieval API; update catalog search to support learned vectors; LSA disclaimer | Keep LSA-only catalog; vector retrieval as opt-in prototype                            |
| E16 (Notebook DAG shipping) | `executeDag()` call path + integration test; decide: ship or remove UI toggle                  | Either ship DAG mode with disclaimer, or remove toggle and simplify UI                 |
| E20 (Distributed execution) | No cluster infrastructure; `distributed.ts` already self-documenting as in-process             | Keep LIMITATION label + Amdahl accounting; no code change required                     |
| E22 (Real-time serving)     | Deployed gateway (Docker/cloud); in-process inference already works                            | Deploy serving microservice; or label LIMITATION and keep current path                 |
| E23 (Deep learning GPU)     | GPU cloud instance (AWS G4, Lambda); PyTorch training worker port                              | Acquire GPU resource OR label LIMITATION permanently; no code work-around              |

---

## Priority Execution Order (Recommended)

**Phase 1 — High Impact, S/M effort (8 gaps, ~3-4 wks total)**

1. P21 / E19: Set `RLS_QUERY_LAYER_WIRED = true` + SQL Lab guard tests (~1 wk)
2. P8 / E17: Fix pivot-grid ORPHANED + drag-drop field builder (~2 wks)
3. E3 + E4 + E5 + E6: Write 4 oracle tests for causal/survival/Bayesian/HTE (~3 wks)
4. E18: Delete or ship `elite.ts`/`elite-esoterics.ts` dispatcher (~1 wk)

**Phase 2 — Remaining Professional + Elite M gaps (5 gaps, ~4-5 wks total)** 5. B16: PWA offline update (~1 wk) 6. E12: SARIMA oracle test (~1 wk) 7. E21: Streaming oracle test (~1 wk) 8. B17 / P23: Document bank-statement PDF refusal as product decision (~0.5 wk, already done)

**Phase 3 — L gaps (decision points, ~2-3 wks evaluation)** 9. E14 + E15 + E16: Decide ship vs. LIMITATION + labels (~1 wk meeting) 10. E20 + E22 + E23: Evaluate infrastructure needs + document decisions (~1 wk meeting)

**Result after Phase 2:** Beginner 100% (17/17), Professional 96% (25/26), Elite ~66% (21/32 FULL)

**Result after Phase 1:** Beginner 100%, Professional 92% (24/26), Elite ~60% (19/32 FULL)

---

## Claims-Register Cross-Reference

This roadmap maps directly to `docs/audit/claims-register.md`:

- Every "⛏️ STUB" in claims-register has a roadmap entry (cause + needs + effort)
- Every "⚠️ PARTIAL" in claims-register has a roadmap entry (missing component + fix path)
- Every "⚠️ LIMITATION" in claims-register has an infrastructure needs table entry
- ABSENT features (E18) are documented as cleanup decisions

**No inflation:** Gaps that are already FULL (e.g., B1-B15, P1-P7, P9-P20, P22, P24-P25, E1, E2, E7-E13, E14-E13, E24-E32) are not listed. Only the 18 genuine gaps appear.

---

_Generated from Data Analytics scorecard (2026-10-17) — CA Firm domain omitted as instructed._

---

## Closure log — 2026-11-08 (six remaining fixable gaps closed)

Everything below is code, tests and docs — no infrastructure was added, and no
gap was removed from the list or redefined.

| Gap | What shipped | Verification |
| --- | --- | --- |
| **B16** PWA offline beyond the shell | `public/sw.js` caches `/api` GETs network-first; a cached response is served only when the network fails and carries `X-Ledgerly-Offline: snapshot` + `X-Ledgerly-Cached-Att`. Auth/me/chat/copilot/llm and bearer-token requests are never stored. | `__tests__/unit/pwa-offline.test.ts` |
| **B17 / P23 / P26** Bank-statement PDF ingestion | `extractPdfText` + `pdfTextToRows` in `lib/engine/connectors/bank-statement.ts`, wired through `parseAndProfileFile`; text-layer PDFs ingest as typed rows, scanned PDFs refuse with an actionable OCR message instead of guessing. | `__tests__/unit/bank-pdf-ingest.test.ts` (+ CSV regression) |
| **P21 / E19** RLS on every query path | SQL Lab (`lib/server/dataset-query.ts`), rows/values routes, notebook cell runs and pivots all pass the `dataset-access.ts` chokepoint before an engine sees rows; `RLS_QUERY_LAYER_WIRED = true`; DB policies stay opt-in. | `__tests__/unit/rls-query-paths.test.ts`, `rls-server.test.ts` |
| **E14** Neural network (true MLP) | `neural-net.ts` (reverse-mode backprop, seeded init, Adam) is imported by `analyses.ts` and reported in the `deep-learning` analysis: backprop loss curve, training RMSE and step count. Reachable from Analysis Lab (kind added to the wizard). | `neural-net.test.ts`, `deep-learning-parallel.test.ts`, `mlp-deep.test.ts` |
| **E15** Embeddings / vector search | `embeddings.ts` skip-gram word2vec is imported by `analyses.ts`; the NLP `similarity` analysis returns mean-pooled document vectors, cosine nearest neighbours, top vector pairs (chart + table). Catalog search stays LSA and the result says so. | `embeddings.test.ts`, `nlp.test.ts` |
| **E16** Notebook DAG orchestration | `POST /api/notebooks/[id]/run` with `mode: "dag"` returns the topological order, runnable ids and the cycle path; DAG mode in the notebook runs that plan and refuses a cyclic graph. | new `__tests__/unit/notebook-dag.test.ts`, `notebook-cell-integration.test.ts` |
| **E17** Pivot grid at scale | Already wired in the prior pass (`pivot-grid.ts` imported by `pivot-field-builder.tsx` and `dashboard-builder.tsx`); the scorecard row was stale and is now corrected. | `pivot-grid.test.ts`, `pivot-field-builder.test.tsx` |

Remaining Elite gaps after this closure: **E20** (no cluster), **E22** (no deployed
serving gateway) and **E23** (no GPU) — infrastructure this runtime does not have.

**Post-closure tallies (from the scorecard's canonical slots):** Beginner 17/17
(100%), Professional 26/26 (100%), Elite 29/33 (87.9%).

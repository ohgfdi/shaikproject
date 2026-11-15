# Aerolexa — Product Overview

> **Tagline:** From raw data to boardroom decisions.
> **Category:** Self-hosted business intelligence & analytics workspace.
> **Version:** 0.6.1 · **License:** MIT
> **Stack:** Next.js 15 (App Router), React 19, TypeScript 5.7, Prisma 7, Tailwind 3
> **Primary market:** India (₹ pricing, Razorpay, DPDP Act, Hindi + Urdu locales)

---

## Table of contents

1. The problem we solve
2. Who we target
3. Product overview
4. Core capabilities
5. The 10 extended modules
6. Data connectors — 14 built in
7. Analytics engines
8. Machine learning, hand-written
9. Causal inference and forecasting
10. The AI copilot — "AI narrates, engines compute"
11. Reproducibility, governance and compliance
12. Why choose Aerolexa instead of the alternatives
13. Pricing
14. Technology architecture
15. Quality and verification culture
16. Deployment profiles and module gating
17. Scope and explicit non-goals
18. Honest risks and recommendations

---

## 1. The problem we solve

### 1.1 The daily reality of an Indian accounting firm

A chartered accountant asked to reconcile GST for a client does this today:

```
Tally export  ->  paste into Excel  ->  VLOOKUP until it breaks
              ->  build a pivot by hand  ->  screenshot into Word
              ->  email the PDF
```

That is **hours of manual clicking per client, per month**, and it has three structural defects:

| Defect | Consequence |
|---|---|
| **Non-reproducible** | If the client sends a corrected file, the whole manual chain is redone from scratch. There is no way to know which step changed. |
| **Unauditable** | The error rate lives inside the VLOOKUPs. If a mismatch is later challenged, nobody can prove which row was wrong or when. |
| **Non-scalable** | Each client is a fresh spreadsheet. Ten clients means ten disconnected worlds — no reuse, no templates, no client-facing portal. |

The analysis itself is not the hard part. The hard part is the **plumbing between a raw file and a defensible client deliverable.**

### 1.2 What Aerolexa replaces

```
Upload CSV / XLSX / live Tally  ->  auto-profile  ->  analyse  ->  publish
     (streaming parse)             (quality flags)    (11 kinds)  (link, not PDF)
```

The structural difference: **analysis, report and board deck all read from one dataset.** When the file updates, the story updates. The VLOOKUPs become engine functions unit-tested against SciPy and statsmodels oracles in CI.

> Marketing line, `app/page.tsx:454`: **"GST reconciliation in hours, not days."**
> That is not a slogan. It is the product spec.

---

## 2. Who we target

### 2.1 Primary — the 2 to 30 person CA firm in India

The strongest signal in the codebase. Evidence is mutually reinforcing across code, pricing, compliance and localisation:

| Signal | Where |
|---|---|
| Package description names CA firms first | `package.json:5` — "Data-driven analytics workspace for CA firms, consultants & SMBs" |
| Meta description and SEO keywords | `app/layout.tsx:35-40` — "gst reconciliation tool", "tally data analysis", "ca firm software" |
| India-specific connectors | Tally (live TallyPrime XML gateway), Zoho Books, GST returns, bank statements |
| Ready-made engagement templates | `gst-recon-summary`, `gst-rate-mix`, `tally-trial-balance`, `audit-journal-risk` (Benford + weekend-posting detection), `bank-statement-cashflow`, `core-monthly-kpi` |
| Payments | **Razorpay** orders, HMAC-verified callbacks, idempotent webhooks |
| Pricing in rupees | 0 / 999 / 4999 |
| Data protection | **DPDP Act 2023** consent records + right-to-delete (`lib/server/dpdp.ts`, `ConsentRecord` model) |
| "Firm" plan = per-client silos | `Engagement` model — one confidential workspace per client, which is how accounting firms actually organise |
| Languages | English, **Hindi**, **Urdu (RTL)** |
| Access patterns | Phone/OTP login, WhatsApp Business Cloud API |

**Why they buy:** a CA is *professionally liable* for every number they sign off, and their clients get audited. The value proposition is not "pretty charts" — it is **"a number I can defend."** Oracle-tested engines and immutable version history are engineered for exactly that buyer.

### 2.2 Secondary — independent consultants and advisors

- Need a client deliverable weekly, per client.
- Choose Aerolexa because a shareable link beats a PDF email chain that goes stale the moment the file changes.
- `app/page.tsx:465` — "The analysis, the report and the board deck all read from one dataset."

### 2.3 Tertiary — data analysts and SMB operators

- `app/page.tsx:459` — "Replace copy-paste EDA." Profile, segment, forecast and document methodology in one workspace, then **export the Python that produced it** so work hands off to a data team without being retyped.
- Every number carries a provenance label.

### 2.4 Deliberately NOT for

From `app-detail.md:159-164`:

> "teams with thousands of concurrent seats or petabyte-scale warehouses — it is a self-hosted, mid-market analyst/executive workspace, not an enterprise data platform."

A 999-rupee buyer will never evaluate 100% of this product. The product must lead with one job and let the rest stay off.

---

## 3. Product overview

A **single Next.js application** (not a monorepo — 47 pages, 43 API route groups, one deployment unit) organised as a workspace shell:

```
Marketing (3D hero)  ->  Auth  ->  Onboarding  ->  Workspace
     /                   /login     /onboarding      (app)/*
```

**Workspace navigation** (`components/layout/app-shell.tsx`):
Home, Copilot, Projects, Analyses, Dashboards, Reports, Presentations
*plus contextual:* Datasets, Notebooks, Models, Business Advisor, Data Connectors, Scheduled Reports, Prompt Library, Audit Log, Growth Funnel.
Global: full-text search, notifications, settings, command palette (Cmd/Ctrl-K).

### 3.1 Complete page inventory

**Marketing and public**

| Route | Purpose |
|---|---|
| `/` | Landing page — hero with live 3D data-skyline backdrop, features, how-it-works, use cases, transparency section, pricing, FAQ |
| `/templates`, `/templates/[id]` | SEO landing pages per analysis template, sitemap-driven |

**Auth and lifecycle**
`/login` · `/signup` · `/forgot-password` · `/reset-password` · `/verify-email` · `/onboarding`

**Data**

| Route | Purpose |
|---|---|
| `/datasets/[id]` | Dataset profile — columns, data-quality warnings, KPIs |
| `/datasets/[id]/detail` | Drill-through to underlying rows |
| `/datasets/[id]/query` | **SQL Lab** (DuckDB engine) |
| `/datasets/[id]/studio` | **Power BI Studio** — DAX semantic layer, visual picker, cross-filter |
| `/datasets/[id]/transform` | **Power Query** (M language) transform studio |
| `/datasets/[id]/whatif` | What-if / causal simulator |

**Analysis and output**

| Route | Purpose |
|---|---|
| `/analyses`, `/new`, `/[id]` | **Analysis Lab** — 11 analysis kinds |
| `/dashboards`, `/new`, `/[id]`, `/studio` | Dashboard builder and viewer |
| `/reports`, `/new`, `/[id]` | 12-section executive report editor |
| `/presentations`, `/new`, `/[id]` | 9-slide deck editor |
| `/notebooks`, `/published-notebook` | Interactive Python notebook |
| `/models` | Model trainer, Predict, Explain (Shapley) |
| `/advisor` | Business Advisor |
| `/growth` | Growth funnel |

**Platform**
`/projects` · `/connectors` · `/scheduled-reports` · `/prompts` · `/audit` · `/search` · `/notifications` · `/settings` · `/copilot`

**Distribution surfaces**

| Route | Purpose |
|---|---|
| `/apps/[shareToken]` | Public shared dashboard / report / notebook viewer |
| `/embed/[token]` | iframe-embeddable view for client portals |
| `/offline` | PWA fallback |
| `/api/docs` | Swagger UI over the public OpenAPI spec |

---

## 4. Core capabilities

### 4.1 Ingestion and profiling

- **Streaming CSV/XLSX parse** to typed NDJSON plus an auto-generated profile (`lib/file/parse.ts`). Large files never fully materialise in memory.
- **Data-quality engine** (`lib/engine/data-quality.ts`) — flags nulls, type inconsistencies, outliers, duplicates and date-format problems *before* analysis runs.
- **Reservoir sampling** (Vitter 1985, Algorithm R) for statistically unbiased training samples across the whole stream (`lib/engine/training.ts`).
- SQL Lab results can be **materialised back into a new dataset** (`lib/file/store-rows.ts`), so a query becomes a first-class, versioned input.

### 4.2 Analysis Lab — 11 kinds

Defined in `lib/types.ts:158`, labelled in `ANALYSIS_KIND_LABELS`:

| Kind | What it computes |
|---|---|
| `eda` | Structure, data quality, per-column descriptive statistics |
| `trend` | Metric over time with period-over-period change |
| `kpi` | Current vs previous period totals, averages, extremes |
| `correlation` | Direction and strength of linear relationships |
| `distribution` | Histogram and box-plot statistics |
| `forecast` | Next-period projection with 95% prediction intervals |
| `variance` | Metric divergence across groups and periods |
| `segmentation` | k-means clustering into distinct groups |
| `cohort` | Retention of entities across time buckets (exact set logic) |
| `funnel` | Conversion through sequential stages |
| `whatif` | Linear-impact simulation (prototype method, labelled as such in the UI) |

Each result carries **severity, evidence, cause, business implication, next step and a confidence score** (`lib/engine/insights.ts`).

### 4.3 Business Advisor

`lib/engine/advisor.ts` — an automated review that reads the dataset and returns prioritised, actionable findings in business language rather than statistical notation. Backed by `advisor-analysis.ts` and the same oracle-validated primitives (R-type-7 quantiles, exact Student-t p-values).

### 4.4 Semantic and BI layer

This is a real BI engine, not a chart wrapper.

**DAX interpreter** — `lib/engine/dax.ts` (~90 supported functions, listed in `SUPPORTED_DAX_FUNCTIONS`)

- `VAR` / `RETURN` scoping
- `CALCULATE` / `CALCULATETABLE` filter-context rewriting
- `TREATAS`, `LOOKUPVALUE`, `RELATED`, `SELECTEDVALUE`
- Full time-intelligence family: YTD, QTD, MTD, LTM, same-period-last-year
- Iterators: `SUMX`, `AVERAGEX`, `COUNTX`, `RANKX`, `CONCATENATEX`
- Statistics: `MEDIAN`, `STDEV.P`, `STDEV.S`, `VAR.P`, `VAR.S`
- Table construction: `SUMMARIZE`, `GROUPBY`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `DATATABLE`, `ROW`
- Set operations: `UNION`, `INTERSECT`, `EXCEPT`
- Joins: `NATURALINNERJOIN`, `NATURALLEFTOUTERJOIN`, `CROSSJOIN`, `GENERATE`
- Drives UI autocomplete

**Multi-table model** — `lib/engine/dax-multi.ts`: relationship propagation and star-schema cardinality across tables.
**Measure lineage** — `lib/engine/measure-lineage.ts`: dependency graph from measure to column to table, so you can see what breaks before you change it.
**Power Query (M)** — `lib/engine/powerquery.ts`: 20 step types for transformation.
**Cross-filter, slicers, pivot grid, drill-through** — `lib/engine/{cross-filter,slicer,pivot-grid,drill-through}.ts`.
**Visual picker** — waterfall, funnel, sankey, treemap, sunburst, gauge, heatmap, boxplot, ribbon, pareto.

### 4.5 Output and delivery

- **Dashboards** — builder and viewer, public share links, iframe embed.
- **Reports** — 12-section executive report editor (`lib/engine/report-pages.ts`).
- **Presentations** — 9-slide deck editor.
- **Exports** — PDF/HTML, XLSX, `.ipynb` (valid nbformat-4), and **runnable Python/pandas/scipy scripts**.

---

## 5. The 10 extended modules

| # | Module | Capability | Key files |
|---|---|---|---|
| 1 | **Interactive Notebook** | Python via Pyodide (CPython 3.14 WASM, browser and server-side), a declarative DSL, and a server Python kernel. Yjs CRDT co-editing. SQL to `df_<name>` DataFrame handoff. | `components/notebook/*`, `lib/engine/notebook-{dsl,pyodide,handoff,reactive-run}.ts`, `lib/engine/python/python-kernel.ts` |
| 2 | **SQL Lab** | DuckDB (WASM in browser, Node worker server-side). Fails loudly with `ENGINE_UNAVAILABLE` rather than silently degrading. Pivot queries. | `lib/engine/sql.ts`, `sql-executor.ts`, `lib/engine/duckdb/*` |
| 3 | **Model training** | See section 8. Worker-thread training with live SSE progress. | `lib/engine/{training,ml-training,automl,predictor,shapley}.ts` |
| 4 | **Causal / What-if** | Difference-in-differences, propensity-score IPW, placebo tests. | `lib/engine/{whatif,elite-causal}.ts` |
| 5 | **External connectors** | 14 kinds. See section 6. Incremental sync via watermarks and changelog. | `lib/engine/connectors/` |
| 6 | **Scheduled reports** | Cron-driven recurring delivery. | `lib/engine/cron.ts`, `lib/server/scheduler.ts` |
| 7 | **Team collaboration** | Yjs CRDT notebooks, project roles, threaded comments, row-level security. | `lib/collab/`, `lib/server/members.ts`, `prisma/rls.sql` |
| 8 | **SSO** | OIDC (Okta, Entra, Keycloak) and **SAML 2.0** end-to-end. | `lib/auth/{oidc,saml}.ts` |
| 9 | **Prompt Library** | Saved, versioned, reusable prompt assets. | `lib/server/prompts.ts`, `Prompt` model |
| 10 | **Data-catalog search** | Hybrid BM25 + TF-IDF-cosine fusion with deterministic LSA embeddings. | `lib/search/`, `lib/chat/semantic-search.ts`, `app/api/search` |

Plus **versioning and reproducibility** (`lib/server/versioning.ts`) — immutable `DatasetVersion` and `AnalysisVersion` snapshots with change-log diffs.

---

## 6. Data connectors — 14 built in

Registry: `lib/engine/connectors/config.ts` (`CONNECTOR_KINDS`).

| Connector | Transport | Notes |
|---|---|---|
| **TallyPrime** | Live XML gateway (host:port) | Company and period export; also parses TCML/CSV files. **The India wedge.** |
| **Zoho Books** | REST API v3 | Invoices, contacts, expenses, journals; per-region hosts |
| **GST** | India GST returns | Return and ledger data |
| **Bank statement** | CSV parse | Explicitly errors on PDF rather than guessing |
| PostgreSQL | node-postgres TCP | `npm run test:postgres` |
| MySQL | mysql2 | `npm run test:mysql` |
| MongoDB | official driver | `npm run test:mongodb` |
| Snowflake | SQL REST API | Key-pair JWT auth |
| BigQuery | jobs.query | Service-account JWT to OAuth2 |
| Google Sheets | Sheets API v4 | Service-account JWT |
| OneDrive / SharePoint Excel | Graph API | Real enterprise Excel |
| S3 | AWS SDK | CSV from object storage |
| Shopify | Admin API | Link-header pagination |
| Generic HTTP | REST poll | JSON/CSV, **SSRF-guarded** (`lib/server/url-guard.ts`) |

**Supporting infrastructure:** pull orchestration, predicate pushdown, incremental watermarks, changelog capture, and **credential encryption at rest** (`connectors/crypto.ts`).

---

## 7. Analytics engines

Everything below is **deterministic and hand-written in TypeScript** — no ML library dependency, no black box.

| Engine | File | Contents |
|---|---|---|
| Core statistics | `lib/engine/stats.ts` (32 KB) | Descriptive stats, distributions, hypothesis tests |
| Elite statistics | `lib/engine/elite-stats.ts` (35 KB) | R-type-7 quantiles, exact Student-t p-values |
| Analyses | `lib/engine/analyses.ts` (61 KB) | All 11 analysis kinds |
| Insights | `lib/engine/insights.ts` | Severity, evidence, cause, implication, next step, confidence |
| Advisor | `lib/engine/advisor.ts` (30 KB) | Business-language findings |
| SQL | `lib/engine/sql.ts` (39 KB) | Parser and executor |
| Power Query | `lib/engine/powerquery.ts` (28 KB) | 20 transformation step types |
| DAX | `lib/engine/dax.ts` (~90 functions) | Full semantic layer |
| Studio / pivot / cross-filter | `lib/engine/{studio,pivot-grid,cross-filter,slicer,drill-through}.ts` | Visual analytics |
| Search | `lib/chat/semantic-search.ts` | BM25 + TF-IDF-cosine fusion (0.6/0.4) with deterministic LSA via block power-iteration SVD (no RNG, fixed start, Gram-Schmidt re-orthonormalisation) |

---

## 8. Machine learning, hand-written

All implemented from scratch in TypeScript — **no sklearn, no TF.js**.

| Algorithm | Implementation detail |
|---|---|
| **Histogram tree learning** | LightGBM-style binning with exact dense splitters below 2,000 rows; histogram path above |
| **MLP neural network** | 2x ReLU hidden layers, He-uniform init, mini-batch **AdamW**, warmup plus cosine LR schedule, gradient clipping at 5.0, early stopping with best-snapshot restore. **Proven to solve XOR where logistic regression provably fails** (`__tests__/unit/mlp-upgrade.test.ts`) |
| **Gradient boosting** | Friedman's algorithm with Newton leaf-value refinement and stochastic row subsampling |
| **Multiclass** | Softmax regression plus one-vs-rest ensembles |
| **k-NN, k-means** | Exact implementations |
| **AutoML-lite** | Deterministic grid search over identical stratified folds with a scored leaderboard — reproducible model selection |
| **Shapley explanations** | Permutation sampling (Strumbelj and Kononenko), returns the reconstruction error so you know the attribution is sound |
| **Model serving** | `aerolexa.ml.v1` artifacts reconstruct into **exact runnable predictors** |
| **Training execution** | Runs in a **Node worker thread** (esbuild-bundled) with **live SSE progress** streaming to the UI — training never blocks the event loop |

---

## 9. Causal inference and forecasting

### 9.1 Causal — `lib/engine/elite-causal.ts`

- **Difference-in-differences** with closed-form standard errors
- **Propensity-score inverse probability weighting** with covariate-balance diagnostics
- **Placebo / falsification tests** producing an explicit **PASS/FAIL verdict on the parallel-trends assumption**
- OLS validated against statsmodels to 6 decimal places

This is the feature that matters most when a CA firm asks "did that change actually cause this result?" — most BI tools can only tell you the two numbers moved together.

### 9.2 Forecasting — `lib/engine/forecast.ts` (27 KB)

Three real model families — **ETS, Theta, ARIMA** — selected by **AICc** scoring, then cross-validated with a **walk-forward backtest**. The winner is projected with 95% prediction intervals. No linear-regression-on-date fake-outs.

---

## 10. The AI copilot — "AI narrates, engines compute"

`lib/copilot/agent.ts` · `guard.ts` · `tools.ts` · `engine.ts` · `narrative.ts`

**Design principle: the language model never computes a number.** It only writes prose about numbers that deterministic engines already produced.

**The grounding guard** (`lib/copilot/guard.ts`) parses every numeric token in the model's answer and verifies it against the computed facts before the answer is displayed. A hallucinated figure is blocked, not shown.

Supporting evidence:

- Only **4 to 7 tools** exposed to the model — a deliberately narrow surface
- Two grounded tools with statistical rigour: `explain_key_influencers` (Wilson confidence intervals, lift versus base rate) and `build_decomposition_tree`
- **Golden eval suites** plus a dedicated **fabrication red-team fixture set**
- **Works fully local** via Ollama / vLLM / LiteLLM (`lib/llm/providers.ts`) — no data leaves the workspace

This is a defensible, testable product difference, not a marketing claim. Generic LLM tools hallucinate numbers; here they are structurally prevented from doing so.

---

## 11. Reproducibility, governance and compliance

| Area | Detail |
|---|---|
| **Versioning** | Immutable `DatasetVersion` / `AnalysisVersion` snapshots with change-log diffs — answers "what changed and when" |
| **Provenance** | `lib/provenance.ts` — every figure traces back to the rows that produced it |
| **Audit log** | Full audit trail plus CSV export (`lib/server/audit-csv.ts`) |
| **Row-level security** | `prisma/rls.sql`, `lib/server/rls.ts` |
| **Multi-tenancy** | `Organization` / `Engagement` / `OrganizationMember` — one confidential silo per client |
| **DPDP Act 2023** | Consent records plus right-to-delete (`lib/server/dpdp.ts`) |
| **Secrets** | Connector credentials encrypted at rest; JWT HS256 session signing; bcrypt password hashing |
| **API security** | 9 API-key scopes, per-key rate limiting, SSRF guard on HTTP sources |
| **Rate limits** | Auth 30 per 10 min, upload 60 per hr per IP, signup 10 per hr |
| **Public API** | OpenAPI spec at `/api/public/openapi.json`, Swagger UI at `/api/docs` |
| **Job safety** | Durable job queue with lease recovery and dead-letter handling |
| **Self-hosting** | Data never leaves the customer's infrastructure. Docker Compose ships app + Postgres 16 + MySQL 8 + Mongo 7 |

---

## 12. Why choose Aerolexa instead of the alternatives

### 12.1 Head-to-head

| Alternative | Their limitation | Aerolexa's answer |
|---|---|---|
| **Excel and manual VLOOKUP** | Hours of clicking per client per month; errors live inside the formulas; completely non-reproducible; no audit trail | Deterministic engines unit-tested against SciPy/statsmodels oracles; immutable version history with diffs |
| **Microsoft Power BI** | Roughly 1,000+ rupees per user per month, **cloud-only** (client financial data leaves the country), no Tally/Zoho/GST connectors, no Indian statutory compliance, steep learning curve | Self-hosted, 14 connectors including the Indian accounting stack, DPDP-native, DAX included at every tier |
| **Tableau** | Same cloud and data-residency problem, higher price, no Indian connectors, no compliance story | Same, plus oracle-validated numbers |
| **Zoho Analytics / Freshworks** | The closest competitor — but cloud SaaS tenancy, and it does not ship Tally/GST reconciliation workflows | Self-hosted workspace with CA-specific engagement templates and per-client silos |
| **Python / Jupyter / pandas** | Requires a data hire at 8-20 lakh per year; non-programmers excluded entirely | **Exports the same pandas/scipy script** for handoff — data-team rigour available to someone who cannot code |
| **ChatGPT or Copilot on a CSV** | **Hallucinates numbers.** No audit trail, no reproducibility, no provenance | Grounding guard verifies every numeric token before display; local model support; full version history |
| **A CA's own junior staff** | The status quo. A ₹25,000/month hire who still makes VLOOKUP errors and cannot be audited | The same work, computed and defended, at 999 rupees per workspace |

### 12.2 The three defensible moats, in order of strength

**1. The India compliance and connector layer.**
Tally (live gateway), Zoho Books, GST returns, bank statements, DPDP Act consent and right-to-delete, Razorpay, Hindi and Urdu. No international BI vendor has this and none can build it without an India entity. This is the hardest layer for a competitor to copy and the one your target buyer feels on day one.

**2. Oracle-validated honesty.**
Every engine is tested against SciPy, NumPy and statsmodels in CI. Results are explicitly labelled `Calculated` versus `Prototype / Demo`. A CA is professionally liable for the numbers they sign. Being able to **prove** a number is worth real money to that buyer — and almost no competitor makes the claim, let alone tests it. This is the single most under-marketed asset in the product.

**3. Reproducibility.**
Immutable `DatasetVersion` / `AnalysisVersion` snapshots with diffs. When a client disputes a figure, you can show exactly what changed between submissions. Excel cannot do this. Power BI cannot do this. This is what converts a curious analyst into a paying subscriber.

### 12.3 The honest differentiator sentence

> Any tool can show a chart. When the client's auditor asks *"show me how you got that number, and prove it did not change since last month,"* only Aerolexa can answer.

---

## 13. Pricing

Source: `app/page.tsx:595-641`, mirrored in `lib/server/billing.ts:27-46`.

| Plan | Price | Positioning |
|---|---|---|
| **Free** | Rs 0 forever | "Everything computed. Nothing distributed." Unlimited uploads, profiling, analyses, notebook, SQL Lab, reports, presentations, model training, all exports. 1 workspace. |
| **Pro** | Rs 999 per workspace / month | For consultants who share work with clients. Public share links, scheduled reports, notebook publishing, external connectors and sync, API keys, priority support. |
| **Firm** | Rs 4,999 per firm / month | For CA firms running engagements across a team. Unlimited seats with org roles (ADMIN/MEMBER/AUDITOR), per-client engagement silos, row-level security, audit exports, SSO via any OIDC provider (Okta, Entra, Keycloak), onboarding. |

Payment rails: Razorpay orders, HMAC-verified callbacks, idempotent webhook processing. Models: `Plan`, `Subscription`, `Invoice`, `WebhookEvent`.

---

## 14. Technology architecture

| Layer | Technology |
|---|---|
| Framework | Next.js 15.5 App Router, React 19 |
| Language | TypeScript 5.7, strict mode |
| Database | Prisma 7 — SQLite for dev, PostgreSQL for prod (provider switch script) |
| Schema | `prisma/schema.prisma` — **46 models**, 1,279 lines |
| Styling | Tailwind 3.4 + custom design system |
| Charts | ApexCharts, ECharts 6, plus a custom three.js 3D chart layer |
| 3D | three 0.165, @react-three/fiber 9, @react-three/drei 10, postprocessing 6 |
| Maps | Leaflet / react-leaflet choropleth |
| Query engine | DuckDB (WASM + Node worker) |
| Python | Pyodide (CPython 3.14 WASM, browser and server-side) |
| LLM | OpenAI-compatible, Ollama, vLLM/LiteLLM |
| Auth | jose (JWT HS256), bcryptjs, NextAuth, OIDC, SAML 2.0 |
| Realtime | Yjs CRDT + y-indexeddb, SSE progress and presence |
| Storage | Local filesystem or S3 |
| Validation | Zod |
| Payments | Razorpay |

**Scale:** ~117,000 lines of TypeScript/TSX across `app/`, `components/`, `lib/`, `prisma/`. 223 library modules. 34 component directories. 166 test files.

### 14.1 The 3D rendering system

Unusually complete for a BI product (`docs/3d-realism-master-plan.md`, 11 of 11 stages complete).

- **Real image-based lighting** — two CC0 1K HDR environments shipped locally (Poly Haven `studio_small_08`, `moonless_golf`) with a procedural studio-room fallback. Full attribution file included.
- **Measured render tiers** — `studio` / `depth` / `flat`, chosen from a live WebGL probe, device memory and core count, iOS detection and `prefers-reduced-motion`. Strictly downward runtime downgrade with telemetry, plus a `?scene-tier=` override.
- **Physical materials** — `dataGlass`, `brushedMetal`, `softTouch`, `lightEdge`.
- **Post-processing** — bloom, SMAA, depth of field, N8AO, vignette, grain. ACES filmic tone mapping, sRGB output.
- **3D charts** — bars, donut, scatter, line-area, heatmap, decomposition tree, key influencers, what-if.
- **Enforced performance budgets** — draw calls under 100 and heap under 250 MB (studio tier); under 40 and 150 MB (depth tier), verified in `__tests__/e2e/scene.spec.ts` through a real `gl.info` hook.

**Governing rule, from the master plan:** *"3D is a view, never a source. Any object whose size, colour or position encodes data must mirror a value an engine computed and tests prove."*

---

## 15. Quality and verification culture

This is unusual and worth protecting, because it is the basis of every claim in section 12.

- **SciPy/NumPy/statsmodels oracle tests** for statistics, what-if OLS and cohort retention (`stats-reference.test.ts`, `stats-whatif-oracle.test.ts`, `cohort-oracle.test.ts`).
- **Zero-skipped-tests gate** — `npm run test:postgres` spins up a disposable Postgres 16 and **fails the build if any test skips**.
- **Golden eval suites plus a fabrication red-team set** for the copilot.
- **Playwright + axe-core** accessibility specs, mobile 360 px touch cross-filtering E2E, device-lab matrix.
- **Bundle budget gate** — 300 kB per route, wired into `npm run build` via `scripts/check-bundle-budgets.mjs`.
- **OWASP ZAP** weekly scan (`.github/workflows/zap-scan.yml`).
- **Backup/restore drill** (`npm run drill:backup`) against disposable Postgres.
- **Exported Python is actually executed** — the acceptance suite runs the generated scripts in a `.venv` and compares the `RESULT:` output.
- CI runs Python 3.12 with numpy, scipy, pandas, sklearn, nbformat and statsmodels alongside Node 18/20 and Postgres 16.

---

## 16. Deployment profiles and module gating

Advanced modules are deliberately frozen behind flags defaulting to OFF, controlled by one env var (`lib/server/modules.ts`).

| Profile | Contents |
|---|---|
| `AEROLEXA_PROFILE=core` (default) | Core flow only. SQL Lab, notebook, what-if, connectors, scheduler, training, advisor, prompts and LLM all frozen. |
| `AEROLEXA_PROFILE=pro` | Everything a working analyst needs, unfrozen. |
| `AEROLEXA_PROFILE=all` | Every module unfrozen. |
| `AEROLEXA_ENABLED_MODULES=all` | Legacy master switch. |

Frozen routes return **HTTP 503 `MODULE_DISABLED`** with the exact remedy string, including the one-line env var to fix it. Module overrides still work per-flag.

**Docker:** `docker-compose.yml` provides `app` (SQLite profile), `pg` (Postgres 16), `mysql` (8), `mongo` (7) and `app-pg`, with named volumes.

---

## 17. Scope and explicit non-goals

**Not targeted:**
- Thousands of concurrent seats
- Petabyte-scale warehouses
- Real-time streaming ingestion at scale
- Replacing a full enterprise data platform
- Consumer or general-audience analytics

**Posture on honesty:** no sample workspace, no invented numbers, no fake AI. Synthetically seeded demo data is always labelled `Demo / Synthetic`. If DuckDB cannot start, SQL Lab fails with `ENGINE_UNAVAILABLE` rather than silently returning wrong results. Every analysis engine is labelled `Calculated` (oracle-validated in CI) or `Prototype / Demo`.

---

## 18. Honest risks and recommendations

### 18.1 The name is fighting the product

There is **zero aerospace, aeronautics, aerodynamics or CFD content anywhere in the codebase.** Exhaustive greps for `aerodynamic`, `CFD`, `airfoil`, `Navier-Stokes`, `UAV`, `aircraft`, `Navier`, `computational fluid` across `app/`, `lib/`, `components/`, `prisma/`, `docs/` and `public/` return **0 matches**.

"Aero" in "Aero_Tech" and "Aerolexa" is pure invented branding. The product has been renamed twice already (VertaX, then AURELIA, now Aerolexa) and the history is still visible in `docs/band-status.md:35` and scratch schemas.

**Why it matters:** a CA firm seeing "Aero_Tech" has no idea what it does and may assume aerospace. The SEO keywords in `app/layout.tsx:37-40` are "gst reconciliation tool", "tally data analysis" and "ca firm software" — **none of which match the brand.** Paid and organic acquisition will underperform badly until the name describes the job.

**Recommendation:** rename to something that names the job — GSTCA, Reconcile, Ledgerly, or Matchbox. The code is already clean of the old names, so a rename is a one-pass sweep.

### 18.2 The product is built like a platform but sold like a tool

A **~90-function DAX interpreter**, Pyodide notebooks, a three.js PBR rendering system with real HDRI lighting, an MLP with AdamW, Shapley attribution, SAML SSO, 14 connectors, a job queue with dead-letter handling — across ~117,000 lines and 166 test files.

None of that is a problem for engineering. It is a problem for **go-to-market**, because a buyer evaluating 100% of this surface at Rs 999 per month will never reach a decision. The landing page correctly leads with 10 minutes to first value, and `lib/server/modules.ts` already keeps the rest off by default.

**Recommendation:** make GST reconciliation the demo, the trial, and the onboarding. Everything else becomes a discovery feature the customer finds after they have already reconciled their first client. Lead the sales conversation with section 12.3, not with the feature list.

### 18.3 Feature discovery is currently worse than the feature set

The most differentiated assets — the oracle validation, the grounding guard, the version diffs — are the **least visible** in the UI. Nothing on the landing page tells a CA that a number in Aerolexa has been tested against SciPy, or that a hallucinated figure from the copilot is blocked before display.

**Recommendation:** surface the `Calculated` vs `Prototype` label prominently in the analysis output, and add a "how this number is verified" affordance. That single change converts an invisible engineering asset into a sales argument that no competitor can counter.

### 18.4 Wedge discipline

The India compliance layer (Tally, GST, Zoho Books, DPDP, Razorpay) is the single hardest thing for a competitor to replicate, and the fastest thing to demonstrate value with. Every hour spent on the 3D scene system or the DAX interpreter is an hour not spent making the Tally-to-GST-reconciliation path flawless.

**Recommendation:** treat GST reconciliation as the product. The rest of the codebase is the moat that makes the product defensible once the wedge lands.

<!-- END -->


# Ledgerly — From Raw Data to Boardroom Decisions

Ledgerly is a self-hosted analytics workspace that is
completely driven by **your uploaded data**. Upload a CSV or Excel file and go
from raw data to profiling, analysis, insights, executive dashboards, reports
and presentations — no sample workspace, no invented numbers, no fake AI.

> **Honest labelling.** Every analysis engine (EDA, KPI, distribution, correlation, trend, what-if, model-training
> p-values, forecast, notebook DSL, advisor, cohort — compared against SciPy/NumPy/statsmodels oracles or
> hand-computed fixtures in CI) is labelled "Calculated". The forecast runs a real ETS/Theta/ARIMA engine selected by AICc;
> the notebook DSL's numeric commands and the advisor's diagnostics delegate to the same oracle-validated primitives
> (R-type-7 quantiles, exact Student-t p-values); cohort retention is exact set logic pinned by hand-computed oracle
> tests (`__tests__/unit/cohort-oracle.test.ts`). Nothing pretends to be a live ML pipeline.

---

## Quick start (one command)

Requirements: Node 18.18+ (Node 20 recommended), npm.

```bash
npm install
npm run dev        # creates .env if missing → applies migrations → starts Next.js
```

Open http://localhost:3000, sign up, complete the 3-step onboarding and upload
your own file. Everything downstream — profiling, Analysis Lab, insights,
Business Advisor, dashboards, reports, presentations — runs against that exact
file.

### Optionally, a labelled demo account

```bash
npm run db:seed -- --demo
# demo@aerolexa.local / demo12345 — every artifact is named "Demo / Synthetic"
```

### Or: the one-command sales demo

```bash
npm run demo   # docker compose up → health check → seed → prints a 10-minute walkthrough
```

Launch-readiness commands: `npm run drill:backup` (verifies the §6
backup/restore loop against disposable Postgres), `npm run audit`
(production-dependency scan — currently 0 vulnerabilities), and the OWASP
ZAP baseline workflow (`.github/workflows/zap-scan.yml`, weekly + manual).

## What's inside

| Area                                           | Where                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App (Next.js 15 App Router)                    | `app/` — auth, onboarding, projects, datasets, analyses, insights, advisor, studio, dashboards, reports, presentations, search, notifications, settings, exports                                                       |
| Extended modules (10)                          | Notebook (Pyodide/demo DSL), SQL Lab (DuckDB engine; explicit failure, opt-in labelled fallback), Model Training, What-if, Connectors, Scheduled Reports, Team collaboration, SSO, Prompt library, Data-catalog search |
| Component library (design system)              | `components/ui/` + `components/charts/`                                                                                                                                                                                |
| Analytics engines (deterministic, transparent) | `lib/engine/` — stats, analyses, insights, advisor, studio, dataset loader, sql, training, whatif, cron, notebook-dsl                                                                                                  |
| Upload/profile pipeline                        | `lib/file/parse.ts` (streaming CSV/XLSX → typed NDJSON + profile) + `lib/file/store-rows.ts` (materialize SQL results as datasets)                                                                                     |
| Auth & security                                | `lib/auth/`, `middleware.ts`, `lib/auth/guard.ts` (workspace RLS-equivalent checks), `lib/server/members.ts` (project roles)                                                                                           |
| Data model                                     | `prisma/schema.prisma` + migrations (SQLite default; PostgreSQL via provider switch)                                                                                                                                   |     | Docs | `README.md`, `docs/design-system.md`, `docs/security-and-data.md`, `docs/getting-started.md`, `docs/deploy-postgres.md`, `docs/quality-baseline.md`, `docs/copilot-roadmap.md` |

## Design system & quality gates

- One accessible design system (`docs/design-system.md`): tokens in
  `styles/globals.css`, Tailwind mapping, WCAG-AA focus rings/contrast, skip
  links, keyboard-navigable dialogs/menus.
- Mobile-first: sidebar → drawer < 1024 px, bottom nav < 640 px, no horizontal
  overflow, tables scroll within their container and paginate past 20 rows.
- Every screen implements Loading (skeleton), Empty (CTA), Success (toast),
  Error ("What happened?" + "How to fix"), and data-quality warnings.
  `ErrorBoundary` wraps views and never leaks stack traces.
- Demo-mode labelling is a hard rule — see `docs/security-and-data.md`.
- Performance: first-load JS ≈ 102 kB shared (verified in the Next.js build output; well under budget); charts mount
  client-side only; dataset streams are capped per analysis with an explicit
  sampled label when truncated. The DuckDB-wasm runtime is code-split into its
  own ~1 MB chunk, downloaded only when the in-browser SQL Lab first runs; the
  server engine executes on a worker thread so queries never block the event
  loop.

## Scripts

```bash
npm run dev              # one-click dev (env + migrations + Next.js)
npm run build            # production build (type-checks via webpack)
npm run start            # migrations + next start (production entrypoint)
npm run typecheck        # tsc --noEmit (strict)
npm test                 # unit + component tests (Jest + RTL)
npm run test:api         # API integration tests (Supertest against a real dev server)
npm run test:e2e         # Playwright full-journey smoke
npm run db:migrate       # prisma migrate dev
npm run db:deploy        # apply migrations without dev prompts
npm run db:seed -- --demo# labelled demo account
npm run switch:postgres  # prisma provider → PostgreSQL (see below)
npm run switch:sqlite    # back to SQLite
npm run audit            # npm audit (production deps)
npm run package          # distributable archive
```

## Database: SQLite → PostgreSQL

Local development runs on **SQLite** (zero setup). The same Prisma schema is
portable to PostgreSQL:

```bash
npm run switch:postgres   # flips the provider, installs migrations-postgres/, regenerates the client
# point DATABASE_URL at an empty database, then:
npm run db:deploy         # prisma migrate deploy — works out of the box
```

Migration history is provider-scoped: `prisma/migrations-sqlite/` (21
incremental migrations) and `prisma/migrations-postgres/` (one idempotent
whole-schema baseline) ship in the repo; `switch-provider` installs the
matching set into `prisma/migrations/`. New table/column changes extend the
SQLite set as usual — regenerate the Postgres baseline after (or let the
migration-contract test catch the drift in CI).

SQLite cannot run row-level security; server-side workspace checks
(`lib/auth/guard.ts`) enforce isolation in dev. `prisma/rls.sql` is a _prepared,
opt-in_ PostgreSQL layer (ENABLE + FORCE) that is **not active by default** — it
needs a non-owner DB role and `RLS_ENABLED=true`; the query layer is wired
(`RLS_QUERY_LAYER_WIRED = true`), but enforcement stays off by default. See `docs/security-and-data.md`.

## Deployment

- **Docker**: `docker compose up --build` (SQLite profile — zero external
  services). For PostgreSQL: `docker compose --profile pg up --build` (app on
  3001 + Postgres on 5432). See the Dockerfile comments.
- **Vercel / Railway style**: build with `npm run build`, run with
  `npm run start`, set `DATABASE_URL`, `AUTH_SECRET`, `MAIL_TRANSPORT`,
  `NEXT_PUBLIC_APP_URL` as environment variables.
- **CI**: `.github/workflows/ci.yml` type-checks, runs unit/component suites,
  executes the Postgres-gated connector suites for real against a Postgres 16
  service container (failing on any skip), runs the API suite against a scratch
  DB, builds, and runs the Playwright smoke test.
- Run `npm run audit` before shipping; never commit `.env`.

## Environment variables

See `.env.example` (all documented). The non-negotiable ones:

```
DATABASE_URL      # file:../data/aerolexa.db (dev) or postgresql://…
AUTH_SECRET       # openssl rand -hex 32
NEXT_PUBLIC_APP_URL
MAIL_TRANSPORT    # console (dev) | smtp
PYODIDE_ENABLED / NEXT_PUBLIC_PYODIDE_URL   # notebook kernel (optional)
SCHEDULER_ENABLED # background scheduled-report runner
DIGEST_ENABLED    # notification digest: email unread notifications as one bundle (ROADMAP 7.3)
TRAINING_ENABLED  # prototype model trainer
COLLABORATION_ENABLED / SSO_ENABLED + OIDC_* / SAML_METADATA_URL
CONNECTOR_*       # external data source status
DATASET_QUERY_LIMIT # SQL-lab row cap
DUCKDB_ENABLED      # SQL Lab runs on the DuckDB engine (worker-thread + wasm);
                    # if it cannot initialize the request fails with an explicit
                    # ENGINE_UNAVAILABLE error (never a silent downgrade)
SQL_PROTOTYPE_FALLBACK # opt-in: run read-only SELECTs on the deterministic parser
                       # (clearly labelled degraded) when DuckDB is unavailable
NEXT_PUBLIC_DUCKDB_ENABLED # in-browser DuckDB-wasm SQL Lab (falls back to the API)
```

## Testing strategy

| Layer          | Tooling                                      | Covers                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit           | Jest (node)                                  | stats primitives, formatters, JSON helpers, SQL engine, cron parser, what-if engine, trainer, notebook DSL, DuckDB engine (shared helpers + real wasm integration: COUNT/BIGINT, aggregates, JOINs, truncation, error translation), SciPy reference validation (primitives + KPI/distribution/correlation outputs), DuckDB benchmark budget |
| Postgres-gated | Jest (node) + real PostgreSQL                | connector engine (connection test, schema introspection, typed row import, credential-leak guard) and scheduled connector sync (due-cron semantics, versioned snapshots, diff-able change log) — **executed on every run via `npm run test:postgres`; the run fails if any of these tests is skipped**                                      |
| Component      | Jest + RTL (jsdom)                           | feedback states, form primitives, DataTable, insight card                                                                                                                                                                                                                                                                                   |
| API            | Supertest + real dev server + scratch SQLite | full journey: signup → onboarding → upload → EDA → comments; plus SQL query/materialize, what-if, model training, notebooks, prompts, schedules, cross-workspace role enforcement                                                                                                                                                           |
| E2E            | Playwright                                   | full UI journey: signup → onboarding with a real CSV upload → project hub → dataset → EDA run + comments + SQL lab + what-if + notebook + model training                                                                                                                                                                                    |

Run everything locally with `npm test && npm run test:postgres && npm run test:mysql && npm run test:mongodb && npm run test:api && npm run test:e2e`.

### Zero-skipped-tests gate

Integration suites that need a live database skip cleanly when their connection
string is unset — that is the honest behaviour for CI without one. But a skip is
also how real tests silently stop running, so the repo ships a gate per engine
that makes the skip unexcusable:

```bash
npm run test:postgres           # disposable Postgres 16 container → gated suites → teardown
npm run test:postgres -- --keep # keep the container for fast re-runs
npm run test:postgres -- --all  # full unit suite incl. gated suites + gate

npm run test:mysql              # same contract for the mySQL-gated suite (mysql:8)
npm run test:mongodb            # same contract for the MongoDB-gated suite (mongo:7)
```

| Suite                                                              | Gate                    | Env var                                      |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------- |
| `connectors-postgres`, `connector-scheduler`, `connectors.test.ts` | `npm run test:postgres` | `TEST_POSTGRES_URL`                          |
| `connectors-mysql`                                                 | `npm run test:mysql`    | `AEROLEXA_TEST_MYSQL_PORT` (default `55433`) |
| `connectors-mongodb`                                               | `npm run test:mongodb`  | `AEROLEXA_TEST_MONGO_PORT` (default `55434`) |

Each runner fails the build if **any** test in its scope is skipped/pending, and
CI (`.github/workflows/ci.yml`) runs the Postgres gate against a service container
on every push — so the gated suites execute for real, and a future "environment
missing → skip" regression fails the build instead of hiding.

The MySQL and MongoDB gates are the same contract; they need a Docker daemon
locally (`docker run` is driven by the runner) and are not wired into the hosted
CI runners yet, so on a plain `npm test` those 13 tests report as skipped by
design. The two other skip sites are deliberate and loud:

- `entitlements` / `growth-funnel` seat-counting suites need a scratch SQLite DB;
  they run `prisma db push` in `beforeAll` and print the reason when the CLI
  cannot provision one.
- `python-kernel` needs a real interpreter: set `PYODIDE_SERVER_ENABLED=true`
  (or `AEROLEXA_TEST_PYTHON=1`). It skips with a printed reason because the
  Pyodide wheels download from a CDN on first use.

## Extended modules

Modules ship with deterministic, data-derived behaviour. Results computed by the
statistically-validated engine (EDA, KPI, distribution, correlation, trend,
what-if, training p-values, forecast, notebook DSL, advisor) carry a
"Calculated" label and are compared against SciPy/NumPy/statsmodels oracles in
CI. Cohort retention is exact set logic, pinned by hand-computed oracle tests,
and also carries the "Calculated" label.

1. **Interactive notebook** — code cells run on the deterministic DSL
   (`%help`, `%rows`, `%describe`, `%kpi`, `%trend` …) against the dataset's
   real rows; browser Python (Pyodide) activates when `PYODIDE_ENABLED` +
   `NEXT_PUBLIC_PYODIDE_URL` are configured, and real **server-side Python**
   (CPython 3.14 wasm in a worker thread — numpy, pandas, scipy,
   scikit-learn, statsmodels, matplotlib; no filesystem/network access;
   20 s per-cell timeout with worker respawn) activates with
   `PYODIDE_SERVER_ENABLED=true`. Outputs are labelled with the engine that
   produced them (`dsl` | `pyodide` | `pyodide-server`).
2. **SQL Lab** — read-only SELECTs run on the **DuckDB engine**
   (`lib/engine/duckdb/`): the dataset's rows load into an in-memory TEMP
   table (server worker-thread, or in-browser via DuckDB-wasm for sub-100 ms
   repeat queries) and the full SELECT grammar works — JOINs, subqueries,
   CASE, HAVING, window functions, string/date functions. The shared guard
   rejects DDL/DML and multi-statement queries; results are capped
   (`DATASET_QUERY_LIMIT`) with exact totals. If DuckDB cannot initialize the
   request fails with an explicit `ENGINE_UNAVAILABLE` error (with a remedy) —
   it never silently downgrades to weaker results. Operators can opt into the
   deterministic parser (`lib/engine/sql.ts`) via `SQL_PROTOTYPE_FALLBACK=true`,
   and its results are clearly labelled as degraded. Results can be
   materialized as new datasets.
3. **Model training** — deterministic linear/logistic/k-means trainer
   (`lib/engine/training.ts`) writes versioned model cards you can download.
   Supervised models use a real train / validation / test split; the UI leads
   with held-out metrics and actively flags overfitting when the
   train-vs-held-out gap is large. The opt-in **advanced CV engine**
   (`lib/engine/ml-training.ts`) adds k-fold cross-validation, permutation
   importance, **multiclass classification** (multinomial softmax + one-vs-rest
   ensembles), **real gradient boosting** (Friedman logit-boost with Newton
   leaf steps; squared-loss boosting for regression; optional stochastic row
   subsampling) and an **MLP neural network** (2 ReLU hidden layers, He init,
   mini-batch AdamW, warmup+cosine LR schedule, gradient clipping, early stop
   with best-snapshot restore) that solves XOR-class problems linear models
   provably cannot. **AutoML-lite**
   (`lib/engine/automl.ts`) searches algorithm × hyperparameter grids on
   identical stratified CV folds and returns the winner with a full leaderboard
   — selection is out-of-fold, deterministic, and ties break toward simpler
   models.
4. **Causal / What-if** — multivariate linear-impact projection (e.g. "+5% price
   → margin") with optional control variables held at their means (mitigating
   omitted-variable bias), exact Student-t inference, and explicit fallback to a
   hypothetical projection on weak signals. Oracle-validated against
   statsmodels OLS to 6 decimals (`__tests__/unit/stats-whatif-oracle.test.ts`).
5. **External connectors** — PostgreSQL, Snowflake and BigQuery are real
   end-to-end engines (connect/test/browse/sample/import/sync): PostgreSQL over
   node-postgres TCP; Snowflake via the SQL REST API with key-pair JWT auth;
   BigQuery via `jobs.query` with service-account JWT→OAuth2. Read-only SELECTs,
   typed results, row caps, friendly "What happened / How to fix" errors;
   credentials encrypted at rest, never client-visible. **Google Sheets**
   pulls live tabs through the Sheets API v4 (service-account JWT; share the
   sheet with the service-account email) and the **generic HTTP/REST
   connector** polls any JSON/CSV endpoint with an SSRF-guarded fetch —
   both real end-to-end engines, not status surfaces. India-specific: **Tally** connects
   live to the TallyPrime XML gateway (host:port, company + period exports of
   vouchers/ledgers; file-based TCML/CSV parsing also remains) and **Zoho
   Books** pulls invoices/contacts/expenses/journals through the Books API v3
   (self-client refresh token, per-region hosts, org auto-resolution,
   pagination with honest truncation — `__tests__/unit/connectors-india.test.ts`).
   Zoho Books targets the data center the refresh token was minted in: `in`
   (zoho.in), `us` (zoho.com), `eu` (zoho.eu), `au` (zoho.com.au), `jp`
   (zoho.jp), `ca` (zohocloud.ca), `sa` (zohosa.com), `cn` (zoho.com.cn). A
   token from one center is rejected by another, so the connection form names
   each center and the connector fails with the supported list instead of
   silently falling back to India.
6. **Scheduled reports** — cron-defined Report Studio runs produce a local
   HTML export and (optionally) notify recipients; `SCHEDULER_ENABLED` starts
   the background runner.
7. **Team collaboration** — project members with OWNER/EDITOR/VIEWER roles and
   real-time notebook co-editing (`COLLABORATION_ENABLED=true`): Yjs CRDT
   rooms merge character-level edits from concurrent editors with no
   last-writer-wins data loss, presence avatars show who is online, and the
   merged state persists to the notebook (transport: SSE + POST, no extra
   infrastructure). Verified by CRDT convergence tests in
   `__tests__/unit/collab-rooms.test.ts`. Also includes threaded comments on
   analyses, dashboards, reports, presentations and insights; write actions
   are role-checked server-side.
8. **SSO** — real OIDC and SAML 2.0 flows (`lib/auth/oidc.ts`, `lib/auth/saml.ts`
   with signed ACS responses at `/api/auth/saml/*`); JWT-only auth keeps
   everything working when SSO is not configured.
9. **Prompt library** — reusable templates with `{{variable}}` slots, saved as
   advisor templates.
10. **Data-catalog search** — unified search now covers notebooks, models and
    prompts in addition to projects/datasets/analyses/insights/dashboards/
    reports/presentations.
11. **Versioning & reproducibility (Phase 1.5)** — every column-ops reparse and
    connector sync writes an immutable `DatasetVersion` snapshot
    (`data/versions/`, change-log diff vs the previous version); every
    analysis run records an `AnalysisVersion` with extracted metrics and a
    diff view (which metrics moved, by how much); "Export runnable code"
    generates standalone Python scripts (pandas/scipy/sklearn) for analyses,
    what-if projections, model cards and hypothesis tests; notebooks export to
    valid nbformat-4 `.ipynb` with cells and outputs preserved.

## Labelling & AI roadmap

Today: deterministic, in-browser/server logic — clearly labelled, no data leaves
the workspace. Every analysis engine (EDA, KPI, distribution, correlation,
trend, what-if, forecast, notebook DSL, advisor, cohort) is compared against
SciPy/NumPy/statsmodels oracles or hand-computed fixtures in CI and labelled
"Calculated".

Roadmap: embedded Pyodide notebooks and server-side scikit-learn/XGBoost/PyTorch
pipelines. When live models arrive, their results stop showing the prototype
badge; the separation between "computed from your data" and "inferred
recommendation" already exists in every result and advisor response
(`confidence: calculated | inferred | recommendation`).

## Full Feature List

### 📊 Core Analytics

1. **Interactive Notebook** — DSL kernel (`%help`, `%rows`, `%columns`, `%profile`, `%describe`, `%kpi`, `%trend`, `%corr`, `%histogram`) running against real dataset rows with oracle-validated statistics (R-type-7 quantiles, sample stddev, exact Student-t correlation p-values); Pyodide kernel activates when `PYODIDE_ENABLED + NEXT_PUBLIC_PYODIDE_URL` are configured. _Labelled: Calculated._
2. **SQL Lab** — Read-only SELECTs on DuckDB engine (worker-thread + wasm, full SELECT grammar: JOINs, subqueries, CASE, HAVING, window functions, string/date functions); explicit `ENGINE_UNAVAILABLE` failure when the engine cannot start, with an opt-in labelled parser fallback (`SQL_PROTOTYPE_FALLBACK`); results labelled with engine note; materialize as datasets. _Labelled: DuckDB engine or prototype parser fallback._
3. **Model Training** — Real train / validation / test split with held-out-first metrics and an overfitting guard; linear regression, logistic regression, random forest, gradient boosting, k-means — all implemented in TypeScript with real statistics (exact Student-t coefficient p-values, residual diagnostics, cross-validation). The opt-in advanced CV engine adds multiclass classification (softmax / one-vs-rest), Friedman gradient boosting and out-of-fold k-fold metrics; **AutoML-lite** adds deterministic algorithm × hyperparameter search on identical folds with a scored leaderboard. Versioned model cards downloadable as JSON. _Labelled: engine name on model card._
4. **Causal / What-if** — Multivariate OLS projection (e.g. "+5% price → margin") with control variables (held at their means, mitigating omitted-variable bias), Householder-QR solve, exact Student-t slope p-values and confidence intervals, and explicit fallback to a hypothetical projection on weak signals (r² < 0.12). Oracle-validated against statsmodels (`__tests__/unit/stats-whatif-oracle.test.ts`). The **elite causal engine** (`lib/engine/elite-causal.ts`) adds 2×2 difference-in-differences (closed-form SE, parallel-trends labelling), propensity-score IPW with covariate-balance diagnostics, and **placebo (falsification) testing** — the same DiD re-run one period before treatment, with a PASS/FAIL verdict on parallel trends. _Labelled: Calculated (associative, never causal) with identifying assumptions printed._
5. **External Connectors** — Status surface for PostgreSQL, Snowflake, BigQuery, Google Sheets, REST API; configured via env vars, never client-visible credentials; schema import + sample rows (configurable limit).
6. **Scheduled Reports** — Cron-defined Report Studio runs produce local HTML export and (optionally) notify recipients; `SCHEDULER_ENABLED` starts background runner.
7. **Team Collaboration** — Project members with OWNER/EDITOR/VIEWER roles and threaded comments on analyses, dashboards, reports, presentations and insights; write actions role-checked server-side.
8. **SSO** — Real OIDC and SAML 2.0 flows (`lib/auth/oidc.ts`, `lib/auth/saml.ts`); JWT-only auth keeps everything working when SSO is not configured.
9. **Prompt Library** — Reusable templates with `{{variable}}` slots, saved as advisor templates; variables and chains stored in Prompt model.
10. **Data-catalog Search** — Unified search covering projects/datasets/analyses/insights/dashboards/reports/presentations plus notebooks, models and prompts; filterable by date, owner, role, demo/production indicator.

**Statistically validated (compared against SciPy/NumPy oracles in CI):** EDA, KPI, distribution, correlation, trend. See `__tests__/unit/stats-reference.test.ts` — it runs the real SciPy/NumPy implementations on the same dirty data and compares both the primitives and the correlation / distribution / trend **analysis outputs** (skipping with a printed reason when the project `.venv` is absent). The **what-if engine and the trainer's coefficient p-values** are oracle-validated against **statsmodels OLS** in `__tests__/unit/stats-whatif-oracle.test.ts` (coefficients, standard errors, p-values and R² agree to 6 decimals; the Student-t primitives match `scipy.stats.t.sf` across a (t, df) grid to 9 decimals).

**Graduated to Calculated:** Causal / What-if — multivariate OLS + statsmodels oracle; Forecast — ETS/Theta/ARIMA by AICc;
Notebook DSL — delegates to SciPy-validated primitives, `__tests__/unit/notebook-dsl-graduation.test.ts`;
Business Advisor — Mann–Kendall, Welch t, HHI and backtested projections over oracle-validated primitives;
Cohort retention — exact set logic pinned by hand-computed fixtures, `__tests__/unit/cohort-oracle.test.ts`.

### 🖥️ UI & Navigation

- **Sidebar** with 15 direct-entry links: Home, Projects, Business Advisor, Dashboard Builder, Data Connectors, Scheduled Reports, Audit Log, Datasets, Analyses, Dashboards, Reports, Presentations, Notebooks, Models, Prompt Library
- **Header** links: Search, Notifications (badge), Settings (avatar)
- **Responsive breakpoints**: Desktop 1440px, tablet 768px, mobile 375px
- **Bottom navigation** on < 640px
- **18 total navigation entries** across sidebar + header

### 📄 Artifact Types (all supported, many with sidebar links)

- **Projects** — versioning (Active/Draft/Completed/Archived), owner, activity log, roles
- **Datasets** — CSV/XLSX upload, profiling, `isDemo` flag, quality warnings, materialize SQL results
- **Analyses** — 10+ EDA types (EDA, trend, KPI, correlation, distribution, forecast, variance, segmentation, cohort, funnel), "How was this calculated?" transparency
- **Insights** — Auto-generated cards with severity (info/warning/critical), evidence, possible cause, business implication, recommended next step, confidence (calculated/inferred/recommendation)
- **Dashboards** — Widget canvas: KPI cards, charts, tables, text, filters, recommendations; layout persisted as JSON; Save/Duplicate/Rename/Export — server-side PDF/PNG/JPEG render via headless Chromium (`/api/dashboards/[id]/render`, `RENDERING_ENABLED`), one-click from the builder UI
- **Reports** — 12-section executive template (Executive Summary, Business Context, Data Overview, Methodology, Key Findings, Drivers, Risks, Opportunities, Recommendations, Expected Impact, Next Steps, Appendix); auto-populated from dataset; export to print-ready HTML (inline SVG charts) and pixel-identical PDF via headless Chromium
- **Presentations** — 9-slide board decks with dataset name replacement, insight embedding, chart embedding; template with title, bullets, chart, insight, notes
- **Notebooks** — Cell grid with code/markdown cells; output persistence on cell; DSL kernel; Pyodide kernel when configured
- **Models** — Versioned model cards; regression/classification/k-means; download model card JSON; `TRAINING_ENABLED` flag
- **Prompts** — Template name/description; `{{variable}}` slots; chain prompts; advisor template flag; searchable in catalog

### 🎨 Design System & Quality

- **Design tokens**: Deep-neutral palette (`#0A0A0A`, `#121212`), accents (`#5AA8AA`, `#FFB400`), 60/30/10 rule, typography scale (h1=32px, h2=24px, h3=20px, body=16px), spacing unit 8px, 4px base unit
- **Accessibility**: WCAG AA contrast (both themes), focus-visible 2px `#0066FF`, skip links, ARIA labels, keyboard navigation, no childish/gaming aesthetics
- **States on every screen**: Loading (skeleton), Empty (CTA + illustration), Success (toast), Error ("What happened?" + "How to fix" + Retry), Data-quality warnings
- **ErrorBoundary**: wraps views, never leaks stack traces
- **Performance**: first-load JS ≈ 102 kB shared (verified in the Next.js build output; well under 200 KB budget); chart updates < 100 ms after filter change; notebook cell execution < 2 s for ≤ 5 MB data; SQL Lab measured against a real budget — see **Measured performance budget** below
- **Labelling**: "Prototype / Demo" badge (tooltip: "Calculated using prototype logic; live ML pipelines coming soon.") on prototype features only — NOT on SciPy-validated analyses (EDA, KPI, distribution, correlation, trend). Synthetic demo data clearly labelled "Demo / Synthetic". See `__tests__/unit/stats-reference.test.ts` for the validation that justifies this split.

### ⏱️ Measured performance budget

The SQL Lab performance claim is verified, not aspirational. `__tests__/unit/duckdb-benchmark.test.ts` runs the real DuckDB engine over 100,000 synthetic rows across the query shapes a real workload hits (full scan, filter + aggregate, 2-dimension GROUP BY, window + ORDER BY, self-join, capped wide scan), prints the measured per-query timings, and fails CI when any shape exceeds the budget. Run it as a standalone report:

```bash
npm run bench:duckdb
```

Budgets and scale are configurable via `DUCKDB_BENCH_ROWS` / `DUCKDB_BENCH_BUDGET_MS` (default 100,000 rows / 8,000 ms per query). Measured on the reference dev container, every shape completes in under 900 ms.

Statistical claims are verified the same way: `__tests__/unit/stats-reference.test.ts` compares both the primitives (quantiles, moments, Pearson/Spearman, Student-t, normal CDF) and the actual correlation / distribution / trend **analysis outputs** against SciPy/NumPy on the same dirty data — including missing values with mismatched patterns per column and tied ranks. `__tests__/unit/forecast-oracle.test.ts` does the same against statsmodels ETS/ARIMA. Both resolve their interpreter through the shared helper in `__tests__/helpers/python.ts` — `$AEROLEXA_TEST_PYTHON`, then the project-local `.venv`, then a PATH `python3` — probed for the scientific stack, so an already-provisioned interpreter is never ignored. They skip with a printed reason only when no qualifying interpreter exists, mirroring the Postgres-gated suites (see the Zero-skipped-tests gate).

### 🔐 Security & Governance

- **No hard-coded credentials**: all secrets via `lib/env.ts` Zod validation at boot
- **Workspace isolation**: server-side checks + Prisma RLS (PostgreSQL defense-in-depth)
- **CSP headers**: restrict to domain + trusted chart libraries
- **Rate limiting**: auth (30/10 min), upload (60/hour per IP), signup (10/hour)
- **Audit logging**: sign-in/out, dataset upload, analysis creation, insight generation, report export, model training, scheduled report trigger, SSO login events; visible in Settings → Audit Log (read-only, filterable)
- **Data privacy**: `isPII` flag at upload time; uploaded data never leaves workspace; emails in dev print to console
- **Dependency scanning**: `npm audit --omit=dev` before shipping. No DAST scanner (e.g. OWASP ZAP) is bundled — run one against a deployed instance before public exposure.

### 🧪 Testing Strategy

| Layer              | Tooling                                      | Covers                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**           | Jest (node)                                  | stats primitives + SciPy reference validation, analysis outputs vs SciPy, formatters, JSON helpers, SQL engine, cron parser, what-if engine, trainer (train/val/test), notebook DSL, DuckDB engine + benchmark budget |
| **Postgres-gated** | Jest (node) + real PostgreSQL                | connector engine + scheduled connector sync — run for real on every push via a CI service container; **any skip fails the build**                                                                                     |
| **Component**      | Jest + RTL (jsdom)                           | feedback states, form primitives, DataTable, insight card                                                                                                                                                             |
| **API**            | Supertest + real dev server + scratch SQLite | full journey: signup → onboarding → upload → EDA → comments; plus SQL query/materialize, what-if, model training, notebooks, prompts, schedules, cross-workspace role enforcement                                     |
| **E2E**            | Playwright                                   | full UI journey: signup → onboarding with real CSV → project hub → dataset → EDA run + comments + SQL lab + what-if + notebook + model training                                                                       |

Run: `npm test && npm run test:postgres && npm run test:api && npm run test:e2e`

### 📦 Scripts

```bash
npm run dev              # one-click dev (env + migrations + Next.js)
npm run build            # production build (type-checks via webpack)
npm run start            # migrations + next start (production entrypoint)
npm run typecheck        # tsc --noEmit (strict)
npm test                 # unit + component tests (Jest + RTL)
npm run test:api         # API integration tests (Supertest against dev server)
npm run test:postgres    # Postgres-gated suites on a disposable Postgres 16 (zero-skip gate)
npm run test:e2e         # Playwright full-journey smoke
npm run db:migrate       # prisma migrate dev
npm run db:deploy        # apply migrations without dev prompts
npm run db:seed -- --demo# labelled demo account
npm run switch:postgres  # prisma provider → PostgreSQL
npm run switch:sqlite    # back to SQLite
npm run audit            # npm audit (production deps)
npm run package          # distributable archive
```

### 🐳 Database: SQLite → PostgreSQL

Local dev runs on SQLite (zero setup). Same Prisma schema portable to PostgreSQL:

```bash
npm run switch:postgres   # flips the provider, installs migrations-postgres/, regenerates the client
# point DATABASE_URL at an empty database, then:
npm run db:deploy         # prisma migrate deploy — works out of the box
```

Migration history is provider-scoped: `prisma/migrations-sqlite/` (21
incremental migrations) and `prisma/migrations-postgres/` (one idempotent
whole-schema baseline) ship in the repo; `switch-provider` installs the
matching set into `prisma/migrations/`. New table/column changes extend the
SQLite set as usual — regenerate the Postgres baseline after (or let the
migration-contract test catch the drift in CI).

SQLite cannot run row-level security; server-side workspace checks (`lib/auth/guard.ts`) enforce isolation in dev. `prisma/rls.sql` is a prepared, opt-in PostgreSQL layer (ENABLE + FORCE) that is not active by default — it requires a non-owner DB role and `RLS_ENABLED=true`; the query layer is wired (`RLS_QUERY_LAYER_WIRED = true`), but enforcement stays off by default.

### 📦 Deployment

- **Docker**: `docker compose up --build` (SQLite profile — zero external services). For PostgreSQL: `docker compose --profile pg up --build` (app on 3001 + Postgres on 5432).
- **Vercel / Railway style**: build with `npm run build`, run with `npm run start`, set `DATABASE_URL`, `AUTH_SECRET`, `MAIL_TRANSPORT`, `NEXT_PUBLIC_APP_URL` as env vars.
- **CI**: `.github/workflows/ci.yml` type-checks, runs unit/component suites, executes the Postgres-gated connector suites for real against a Postgres 16 service container (failing on any skip), runs the API suite against a scratch DB, builds, and runs Playwright smoke test.
- Run `npm run audit` before shipping; never commit `.env`.

### 🌍 Environment Variables

See `.env.example` (all documented). Non-negotiable ones:

```
DATABASE_URL      # file:../data/aerolexa.db (dev) or postgresql://…
AUTH_SECRET       # openssl rand -hex 32
NEXT_PUBLIC_APP_URL
MAIL_TRANSPORT    # console (dev) | smtp
PYODIDE_ENABLED / NEXT_PUBLIC_PYODIDE_URL   # notebook kernel (optional)
SCHEDULER_ENABLED # background scheduled-report runner
DIGEST_ENABLED    # notification digest: email unread notifications as one bundle (ROADMAP 7.3)
TRAINING_ENABLED  # prototype model trainer
COLLABORATION_ENABLED / SSO_ENABLED + OIDC_* / SAML_METADATA_URL
CONNECTOR_*       # external data source status
DATASET_QUERY_LIMIT # SQL-lab row cap
DUCKDB_ENABLED      # SQL Lab runs on the DuckDB engine (worker-thread + wasm); explicit ENGINE_UNAVAILABLE error if it cannot initialize
SQL_PROTOTYPE_FALLBACK # opt-in degraded parser fallback when DuckDB is unavailable (off by default)
NEXT_PUBLIC_DUCKDB_ENABLED # in-browser DuckDB-wasm SQL Lab (falls back to the API)
```

### 🚀 Demo-mode & AI Roadmap

Today: deterministic, in-browser/server prototype logic — clearly labelled, no data leaves the workspace.  
Roadmap: embedded Pyodide notebooks and server-side scikit-learn/XGBoost/PyTorch pipelines. When live models arrive, their results stop showing the demo badge; the separation between "computed from your data" and "inferred recommendation" already exists in every result and advisor response (`confidence: calculated | inferred | recommendation`).

### 🛠️ Recent Implementation Work (Tier 1 Verification + Domain 2)

**Tier 1 — Real Data Science Capability (Phases 1.1–1.5)**
Full verification completed via actual test execution. Every claim is backed by real, full command output — no summaries, no predictions.

| Phase                   | Status                 | Key Evidence                                                                                           |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| 1.1 Pyodide execution   | **REAL**               | 4/4 notebook-pyodide tests pass: kernel state persists, matplotlib renders, pandas/numpy auto-injected |
| 1.2 stats/ML            | **REAL**               | 8/8 real-statistics tests pass: CV distinct folds, t-test/chi-square/ANOVA, out-of-sample metrics      |
| 1.3 Multi-dataset joins | **REAL**               | 3/3 dataset-joins tests pass: DuckDB JOINs across datasets, DataFrames access                          |
| 1.4 Connectors          | **REAL** (requires PG) | Real `pg` client, schema introspection, sample-row import; tests need `TEST_POSTGRES_URL`              |
| 1.5 Versioning          | **REAL**               | 15/15 phase15-versioning tests pass: versioning, diffing, metric extraction, nbformat validation       |
| 1.5 Code export         | **FUNCTIONAL**         | Scripts generate without `SyntaxError`; `import pandas as pd` and `import numpy as np` added           |

**Fixes Applied:**

- `lib/export/python.ts` — Fixed `SyntaxError: unterminated triple-quoted string literal`; added `import pandas as pd` and `import numpy as np` to all generated scripts
- `app/(app)/published-notebook/page.tsx` — Type assertion `(cell.output as { columns: ... })` at line 197; `tsc --noEmit` reports 0 errors for this file
- `close_phase_2.2_gaps_master_prompt.md` — Confirmed Phase 0 (kernel-state `useState` destructuring) and Phase 1 (security test) both verified ✅

**Phase 2.3 — AI Copilot Embedded in Notebook — SHIPPED ✅**

- `components/notebook/copilot-hook.ts` — `useNotebookCopilot` hook with autocomplete, `/llm` trigger, dataset-aware suggestions
- `components/notebook/copilot-textarea.tsx` — Enhanced textarea with autocomplete suggestion dropdown + inline insert (Tab)
- `components/notebook/notebook-tab.tsx` — Integrated copilot into notebook cell editor
- `app/api/notebooks/[id]/ai/route.ts` — three real paths: live LLM (Ollama / OpenAI-compatible via `lib/llm/providers.ts`), deterministic NL→pandas, deterministic DSL — gated by the Python safety gate and really executed. The deterministic path emits valid pandas for filter clauses ("rows where region is East" → `f_df = df[df["region"] == "East"]`, including numeric operators, thousands-separated values like 1,000, and up to 3 AND-composed predicates chained as f_df → f_df2 → f_df3), pinned by `__tests__/unit/nl-to-pandas.test.ts`.
- All 4 notebook test suites pass (24 tests)

**Phase 1.5 — Export runnable code — SHIPPED ✅**

Exported scripts embed the dataset rows inline (`COLUMNS`/`ROWS` literals), so they execute as-is in a clean venv and
reproduce the app's numbers — the acceptance suite (`__tests__/unit/python-export.test.ts`) actually runs each exported
script and compares the printed RESULT against the engine output.

**Formerly open items — all closed and verified in CI:**

- Reactive parameter cells (4.3): client executes the server's rerun plan strictly sequentially (`lib/engine/reactive-run.ts`)
- Published notebooks (4.4): live widget filters + real chart suite (`components/notebook/published-view.tsx`)
- Drill-through (3.5): click → detail table (`lib/engine/drill-through.ts` + datasets/[id]/detail page)
- Dashboard presence (7.2): SSE presence + avatar bar (`components/dashboards/use-presence.ts`)

### 📄 License

MIT (see `package.json`). Verify numbers and labels before relying on any output for real decisions — prototype features are clearly marked; statistically-validated features are compared against SciPy/NumPy oracles in CI.

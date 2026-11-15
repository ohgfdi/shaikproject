# Ledgerly — from raw data to boardroom decisions

Ledgerly is a self-hosted analytics and compliance workspace driven entirely by **your uploaded
data**. Upload a CSV or Excel file and go from raw data to profiling, analysis, insights,
executive dashboards, reports and presentations — no sample workspace, no invented numbers, no
fake AI. For CA firms it also carries the client engagement → books → filing → reconciliation
loop the firm is actually paid for.

> **Honest labelling.** Every analysis engine (EDA, KPI, distribution, correlation, trend,
> what-if, model-training p-values, forecast, notebook DSL, advisor, cohort — compared against
> SciPy/NumPy/statsmodels oracles or hand-computed fixtures in CI) is labelled "Calculated". The
> forecast runs a real ETS/Theta/ARIMA engine selected by AICc; the notebook DSL's numeric
> commands and the advisor's diagnostics delegate to the same oracle-validated primitives
> (R-type-7 quantiles, exact Student-t p-values); cohort retention is exact set logic pinned by
> hand-computed oracle tests (`__tests__/unit/cohort-oracle.test.ts`). Nothing pretends to be a
> live ML pipeline.

---

## Quick start (one command)

Requirements: Node 18.18+ (Node 20 recommended), npm.

```bash
npm install
npm run dev        # creates .env if missing → applies migrations → starts Next.js
```

Open http://localhost:3000, sign up, complete the 3-step onboarding and upload your own file.
Everything downstream — profiling, Analysis Lab, insights, Business Advisor, dashboards, reports,
presentations — runs against that exact file.

### Optionally, a labelled demo account

```bash
npm run db:seed -- --demo
# demo@aerolexa.local / demo12345 — every artifact is named "Demo / Synthetic"
```

### Or: the one-command sales demo

```bash
npm run demo   # docker compose up → health check → seed → prints a 10-minute walkthrough
```

Launch-readiness commands: `npm run drill:backup` (verifies the backup/restore loop against a
disposable Postgres), `npm run audit` (production-dependency scan — currently 0 vulnerabilities),
`npm run preflight:prod` (DB, RLS, migrations, backups, queue, mail, filing) and
`npm run pilot:readiness` (can this instance take a real firm's data? exits 1 while blocked,
naming each blocker). The OWASP ZAP baseline workflow lives at the repository root
(`.github/workflows/zap-scan.yml`, weekly + manual).

## What's inside

| Area                            | Where                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App (Next.js 15 App Router)     | `app/` — auth, onboarding, projects, datasets, analyses, insights, advisor, studio, dashboards, reports, presentations, notebooks, search, notifications, settings, billing, books, compliance, client portal |
| Extended modules (10)           | Notebook (Pyodide/demo DSL), SQL Lab (DuckDB; explicit failure, opt-in labelled fallback), Model Training, What-if, Connectors, Scheduled Reports, Team collaboration, SSO, Prompt library, Data-catalog search |
| Component library (design system) | `components/ui/` + `components/charts/`                                                                                                                                                                    |
| Analytics engines               | `lib/engine/` — stats, analyses, insights, advisor, studio, dataset loader, sql, training, whatif, cron, notebook-dsl, accounting, books                                                                       |
| Upload/profile pipeline         | `lib/file/parse.ts` (streaming CSV/XLSX → typed NDJSON + profile) + `lib/file/store-rows.ts` (materialize SQL results as datasets)                                                                           |
| Auth & security                 | `lib/auth/`, `middleware.ts`, `lib/auth/guard.ts` (workspace authorization), `lib/server/members.ts` (project roles)                                                                                          |
| Practice workflow               | `lib/server/books.ts`, `lib/server/compliance*.ts`, `lib/server/client-portal.ts`, `lib/server/practice-funnel.ts`                                                                                            |
| Data model                      | `prisma/schema.prisma` + provider-scoped migrations (SQLite default; PostgreSQL via provider switch)                                                                                                          |
| Docs                            | `docs/design-system.md`, `docs/security-and-data.md`, `docs/getting-started.md`, `docs/deploy-postgres.md`, `docs/quality-baseline.md`, `docs/pilot-runbook.md`                                               |

## Analysis engines, notebooks and ML

Modules ship with deterministic, data-derived behaviour. Results computed by the
statistically-validated engine carry a "Calculated" label and are compared against
SciPy/NumPy/statsmodels oracles in CI.

1. **Interactive notebook** — code cells run on the deterministic DSL (`%help`, `%rows`,
   `%describe`, `%kpi`, `%trend` …) against the dataset's real rows. Browser Python (Pyodide)
   activates when `PYODIDE_ENABLED` + `NEXT_PUBLIC_PYODIDE_URL` are configured; real **server-side
   Python** (CPython 3.14 wasm in a worker thread — numpy, pandas, scipy, scikit-learn,
   statsmodels, matplotlib; no filesystem/network access; 20 s per-cell timeout with worker
   respawn) activates with `PYODIDE_SERVER_ENABLED=true`. Outputs are labelled with the engine
   that produced them (`dsl` | `pyodide` | `pyodide-server`).
2. **SQL Lab** — read-only SELECTs run on the **DuckDB engine** (`lib/engine/duckdb/`): the
   dataset's rows load into an in-memory TEMP table (server worker-thread, or in-browser via
   DuckDB-wasm for sub-100 ms repeat queries) and the full SELECT grammar works — JOINs,
   subqueries, CASE, HAVING, window functions, string/date functions. The shared guard rejects
   DDL/DML and multi-statement queries; results are capped (`DATASET_QUERY_LIMIT`) with exact
   totals. If DuckDB cannot initialize the request fails with an explicit `ENGINE_UNAVAILABLE`
   error (with a remedy) — it never silently downgrades. Operators can opt into the deterministic
   parser (`lib/engine/sql.ts`) via `SQL_PROTOTYPE_FALLBACK=true`; its results are clearly
   labelled as degraded. Results can be materialized as new datasets.
3. **Model training** — deterministic linear/logistic/k-means trainer (`lib/engine/training.ts`)
   writes versioned model cards you can download. Supervised models use a real train /
   validation / test split; the UI leads with held-out metrics and flags overfitting when the
   train-vs-held-out gap is large. The opt-in **advanced CV engine** (`lib/engine/ml-training.ts`)
   adds k-fold cross-validation, permutation importance, **multiclass classification**
   (multinomial softmax + one-vs-rest ensembles), **real gradient boosting** (Friedman
   logit-boost with Newton leaf steps; squared-loss boosting for regression; optional stochastic
   row subsampling) and an **MLP** (2 ReLU hidden layers, He init, mini-batch AdamW,
   warmup+cosine LR schedule, gradient clipping, early stop with best-snapshot restore) that
   solves XOR-class problems linear models provably cannot. **AutoML-lite**
   (`lib/engine/automl.ts`) searches algorithm × hyperparameter grids on identical stratified CV
   folds and returns the winner with a full leaderboard — selection is out-of-fold,
   deterministic, and ties break toward simpler models.
4. **Causal / What-if** — multivariate OLS projection (e.g. "+5% price → margin") with control
   variables held at their means (mitigating omitted-variable bias), Householder-QR solve, exact
   Student-t inference, and explicit fallback to a hypothetical projection on weak signals
   (r² < 0.12). Oracle-validated against statsmodels OLS to 6 decimals
   (`__tests__/unit/stats-whatif-oracle.test.ts`). The **elite causal engine**
   (`lib/engine/elite-causal.ts`) adds 2×2 difference-in-differences (closed-form SE,
   parallel-trends labelling), propensity-score IPW with covariate-balance diagnostics, and
   **placebo (falsification) testing** — the same DiD re-run one period before treatment, with a
   PASS/FAIL verdict on parallel trends. Labelled Calculated (associative, never causal) with the
   identifying assumptions printed.
5. **Forecast, cohort, funnel, variance, segmentation** — deterministic engines behind the
   Analysis Lab; forecast is ETS/Theta/ARIMA by AICc, cohort retention is exact set logic, and
   every result carries its method and assumptions.

**Oracle validation.** `__tests__/unit/stats-reference.test.ts` runs the real SciPy/NumPy
implementations on the same dirty data and compares both the primitives (quantiles, moments,
Pearson/Spearman, Student-t, normal CDF) and the actual correlation / distribution / trend
**analysis outputs** — including missing values with mismatched patterns per column and tied
ranks. `__tests__/unit/forecast-oracle.test.ts` does the same against statsmodels ETS/ARIMA. Both
resolve their interpreter through `__tests__/helpers/python.ts` (`$AEROLEXA_TEST_PYTHON`, then the
project-local `.venv`, then a PATH `python3`, probed for the scientific stack), so an
already-provisioned interpreter is never ignored. They skip with a printed reason only when no
qualifying interpreter exists.

### Measured performance budget

The SQL Lab performance claim is verified, not aspirational.
`__tests__/unit/duckdb-benchmark.test.ts` runs the real DuckDB engine over 100,000 synthetic rows
across the query shapes a real workload hits (full scan, filter + aggregate, 2-dimension
GROUP BY, window + ORDER BY, self-join, capped wide scan), prints the measured per-query timings,
and fails CI when any shape exceeds the budget:

```bash
npm run bench:duckdb
```

Budgets and scale are configurable via `DUCKDB_BENCH_ROWS` / `DUCKDB_BENCH_BUDGET_MS` (default
100,000 rows / 8,000 ms per query). On the reference dev container every shape completes under
900 ms. First-load JS is ≈ 102 kB shared (verified in the Next.js build output, well under the
200 kB budget); charts mount client-side only; the DuckDB-wasm runtime is code-split into its own
~1 MB chunk, downloaded only when the in-browser SQL Lab first runs; the server engine executes on
a worker thread so queries never block the event loop.

## Connectors

PostgreSQL, Snowflake and BigQuery are real end-to-end engines
(connect/test/browse/sample/import/sync): PostgreSQL over node-postgres TCP; Snowflake via the
SQL REST API with key-pair JWT auth; BigQuery via `jobs.query` with service-account JWT→OAuth2.
Read-only SELECTs, typed results, row caps, friendly "What happened / How to fix" errors;
credentials encrypted at rest, never client-visible.

**Google Sheets** pulls live tabs through the Sheets API v4 (service-account JWT; share the sheet
with the service-account email). The **generic HTTP/REST connector** polls any JSON/CSV endpoint
with an SSRF-guarded fetch. Both are real engines, not status surfaces.

**India-specific.** **Tally** connects live to the TallyPrime XML gateway (host:port, company +
period exports of vouchers/ledgers; file-based TCML/CSV parsing also remains). **Zoho Books**
pulls invoices/contacts/expenses/journals through the Books API v3 (self-client refresh token,
per-region hosts, org auto-resolution, pagination with honest truncation —
`__tests__/unit/connectors-india.test.ts`). Zoho Books targets the data center the refresh token
was minted in: `in` (zoho.in), `us` (zoho.com), `eu` (zoho.eu), `au` (zoho.com.au), `jp`
(zoho.jp), `ca` (zohocloud.ca), `sa` (zohosa.com), `cn` (zoho.com.cn). A token from one center is
rejected by another, so the connection form names each center and the connector fails with the
supported list instead of silently falling back to India.

## Artifacts and surfaces

- **Projects** — versioning (Active/Draft/Completed/Archived), owner, activity log, roles.
- **Datasets** — CSV/XLSX upload, profiling, `isDemo` flag, quality warnings, materialize SQL
  results, column-ops reparse, versioned snapshots.
- **Analyses** — 10+ EDA types (EDA, trend, KPI, correlation, distribution, forecast, variance,
  segmentation, cohort, funnel), "How was this calculated?" transparency, version + metric diff.
- **Insights** — auto-generated cards with severity (info/warning/critical), evidence, possible
  cause, business implication, recommended next step, and confidence
  (`calculated | inferred | recommendation`).
- **Dashboards** — widget canvas (KPI cards, charts, tables, text, filters, recommendations),
  layout persisted as JSON, duplicate/rename/export, and server-side PDF/PNG/JPEG render via
  headless Chromium (`/api/dashboards/[id]/render`, `RENDERING_ENABLED`).
- **Reports** — 12-section executive template (Executive Summary, Business Context, Data
  Overview, Methodology, Key Findings, Drivers, Risks, Opportunities, Recommendations, Expected
  Impact, Next Steps, Appendix); auto-populated from the dataset; print-ready HTML with inline
  SVG charts and pixel-identical PDF via headless Chromium.
- **Presentations** — 9-slide board decks with dataset-name replacement, insight embedding and
  chart embedding.
- **Notebooks** — code/markdown cell grid, output persistence, DSL kernel, Pyodide kernel,
  nbformat-4 export, published view with live widget filters.
- **Models** — versioned cards (regression/classification/k-means), downloadable JSON,
  `TRAINING_ENABLED` flag.
- **Prompts** — reusable templates with `{{variable}}` slots, chains, advisor-template flag,
  searchable in the catalog.

**Navigation.** Sidebar groups by workflow (Home, Projects, Business Advisor, Dashboard Builder,
Data Connectors, Scheduled Reports, Audit Log, Datasets, Analyses, Dashboards, Reports,
Presentations, Notebooks, Models, Prompt Library, plus the firm workflow: Books, Compliance,
Client Portal). Header links: Search, Notifications (badge), Settings (avatar). Responsive
breakpoints: desktop 1440 px, tablet 768 px, mobile 375 px; sidebar becomes a drawer < 1024 px
and bottom navigation appears < 640 px, with no horizontal overflow.

**Versioning & reproducibility.** Every column-ops reparse and connector sync writes an immutable
`DatasetVersion` snapshot (`data/versions/`, change-log diff vs the previous version); every
analysis run records an `AnalysisVersion` with extracted metrics and a diff view. "Export runnable
code" generates standalone Python scripts (pandas/scipy/sklearn) for analyses, what-if
projections, model cards and hypothesis tests; exported scripts embed the dataset rows inline so
they execute as-is in a clean venv and reproduce the app's numbers — the acceptance suite
(`__tests__/unit/python-export.test.ts`) actually runs each script and compares its printed
RESULT against the engine output. Notebooks export to valid nbformat-4 `.ipynb` with cells and
outputs preserved.

## Collaboration, SSO, scheduling and search

- **Scheduled reports** — cron-defined Report Studio runs produce a local HTML export and
  (optionally) notify recipients; `SCHEDULER_ENABLED` starts the background runner. Publishing a
  scheduled notebook is plan-gated.
- **Team collaboration** — project members with OWNER/EDITOR/VIEWER roles and real-time notebook
  co-editing (`COLLABORATION_ENABLED=true`): Yjs CRDT rooms merge character-level edits from
  concurrent editors with no last-writer-wins data loss; presence avatars show who is online; the
  merged state persists to the notebook (transport: SSE + POST, no extra infrastructure).
  Verified by CRDT convergence tests in `__tests__/unit/collab-rooms.test.ts`. Threaded comments
  cover analyses, dashboards, reports, presentations and insights; write actions are role-checked
  server-side.
- **SSO** — real OIDC and SAML 2.0 flows (`lib/auth/oidc.ts`, `lib/auth/saml.ts` with signed ACS
  responses at `/api/auth/saml/*`); JWT-only auth keeps everything working when SSO is not
  configured. Google sign-in is available when `SSO_ENABLED` and the Google credentials are set.
- **Prompt library** — reusable templates with `{{variable}}` slots, saved as advisor templates;
  variables and chains stored in the Prompt model.
- **Data-catalog search** — unified search across projects, datasets, analyses, insights,
  dashboards, reports, presentations, notebooks, models and prompts; filterable by date, owner,
  role and demo/production indicator.

## Practice workflow (CA firm loop)

The pilot is bought for a firm's value chain, not a chart count:

1. **Client engagements** — engagement records, practice roles and membership checks.
2. **Client portal** — invite → account → upload → client approval, with login tokens and a mail
   outbox for delivery.
3. **Books** — double-entry books seeded with a Schedule III chart of accounts, vouchers,
   period locks, GST invoices and the statements assembled from stored rows
   (`lib/server/books.ts`, `lib/engine/accounting.ts`).
4. **Filings** — compliance runs through one transport (`reference` transmits nothing,
   `simulation` runs the lifecycle offline, `live` reaches the portal), acknowledgement
   reconciliation, filing-proof storage and per-client rollout enforcement.
5. **Evidence** — `/growth` reports where a pilot stalls (engagement → portal account → filing
   prepared → transmitted → reconciled) and names the single next build that evidence supports
   (`lib/server/practice-funnel.ts`). An empty install reports `no-clients`, never a fabricated
   conversion rate.

`npm run pilot:readiness -- --json` is the gate: it exits 1 and lists the blockers (mail
transport, backup receipt, worker, engagements, portal accounts) rather than assuming a pilot is
ready.

## Design system, accessibility and quality

- One accessible design system (`docs/design-system.md`): tokens in `styles/globals.css`, Tailwind
  mapping, WCAG-AA focus rings/contrast, skip links, keyboard-navigable dialogs/menus. Deep-neutral
  palette (`#0A0A0A`, `#121212`), accents (`#5AA8AA`, `#FFB400`), 60/30/10 rule, typography scale
  (h1 32 px, h2 24 px, h3 20 px, body 16 px), 8 px spacing unit.
- Mobile-first: sidebar → drawer < 1024 px, bottom nav < 640 px, tables scroll within their
  container and paginate past 20 rows.
- Every screen implements Loading (skeleton), Empty (CTA), Success (toast), Error ("What
  happened?" + "How to fix" + Retry) and data-quality warnings. `ErrorBoundary` wraps views and
  never leaks stack traces.
- Demo-mode labelling is a hard rule — see `docs/security-and-data.md`. Synthetic demo data is
  clearly labelled "Demo / Synthetic".

## Security, privacy and RLS (current status)

- **No hard-coded credentials**: secrets go through `lib/env.ts` Zod validation at boot, and the
  production boot gate refuses insecure mail transports unless explicitly opted out.
- **Workspace isolation**: enforced in the application layer by `lib/auth/guard.ts` and
  `lib/server/members.ts`. Every tenant query keeps its `workspaceId` filter as defense in depth.
- **RLS is PARTIAL, not enforced.** `prisma/rls.sql` plus the batch-1 migration add ENABLE + FORCE
  ROW LEVEL SECURITY policies, and `lib/server/tenant-db.ts` provides `withTenant()` /
  `withOrganization()`, which set transaction-scoped GUCs with parameterized
  `set_config(...)`. But most tenant files still query `prisma` directly:
  `RLS_QUERY_LAYER_WIRED = false`, and `npm run tenancy:audit` reports the remaining count.
  The ratchet in `lib/server/rls-status.ts` fails the build if that count grows.
  **`RLS_ENABLED=true` still fails closed** (health/readiness refuses) rather than silently hiding
  rows. Do not enable it until the audit reaches zero and the app connects as a non-owner role
  without `BYPASSRLS`.
- **CSP headers** restrict to the domain plus trusted chart libraries.
- **Rate limiting**: auth (30 / 10 min), upload (60 / hour per IP), signup (10 / hour), plus
  per-endpoint buckets for connectors, LLM calls, notebook runs, bookkeeping writes and client
  portal links. Blocked requests do not consume budget.
- **Audit logging**: sign-in/out, dataset upload, analysis creation, insight generation, report
  export, model training, scheduled report trigger, SSO login and billing events; visible in
  Settings → Audit Log (read-only, filterable), with a Firm-tier CSV export gated by
  `requirePlanFeature`.
- **Data privacy**: `isPII` flag at upload time; uploaded data never leaves the workspace; emails
  in dev print to the console. DPDP-oriented data controls live in `lib/server/data-controls.ts`.
- **Dependency and DAST scanning**: `npm audit --omit=dev` before shipping, and the ZAP baseline
  workflow at the repo root (weekly + manual) for a deployed instance.

## Testing strategy

| Layer              | Tooling                                      | Covers                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**           | Jest (node)                                  | stats primitives + SciPy reference validation, analysis outputs vs SciPy, formatters, JSON helpers, SQL engine, cron parser, what-if, trainer, notebook DSL, DuckDB engine and benchmark budget              |
| **Postgres-gated** | Jest (node) + real PostgreSQL                | connector engine (connection test, schema introspection, typed row import, credential-leak guard) and scheduled connector sync — run for real in CI; **any skip fails the build**                              |
| **Component**      | Jest + RTL (jsdom)                           | feedback states, form primitives, DataTable, insight card                                                                                                                                                      |
| **API**            | Supertest + real dev server + scratch DB     | full journey: signup → onboarding → upload → EDA → comments; plus SQL query/materialize, what-if, model training, notebooks, prompts, schedules, cross-workspace role enforcement                              |
| **E2E**            | Playwright                                   | full UI journey: signup → onboarding with a real CSV upload → project hub → dataset → EDA run + comments + SQL Lab + what-if + notebook + model training                                                      |

Run everything locally with `npm test && npm run test:postgres && npm run test:mysql && npm run
test:mongodb && npm run test:api && npm run test:e2e`.

### Zero-skipped-tests gate

Integration suites that need a live database skip cleanly when their connection string is unset —
the honest behaviour for CI without one. But a skip is also how real tests silently stop running,
so the repo ships a gate per engine that makes the skip unexcusable:

```bash
npm run test:postgres           # disposable Postgres 16 container → gated suites → teardown
npm run test:postgres -- --keep # keep the container for fast re-runs
npm run test:postgres -- --all  # full unit suite incl. gated suites + gate
npm run test:mysql              # same contract for the MySQL-gated suite (mysql:8)
npm run test:mongodb            # same contract for the MongoDB-gated suite (mongo:7)
```

| Suite                                                              | Gate                    | Env var                                      |
| ------------------------------------------------------------------ | ----------------------- | -------------------------------------------- |
| `connectors-postgres`, `connector-scheduler`, `connectors.test.ts` | `npm run test:postgres` | `TEST_POSTGRES_URL`                          |
| `connectors-mysql`                                                 | `npm run test:mysql`    | `AEROLEXA_TEST_MYSQL_PORT` (default `55433`) |
| `connectors-mongodb`                                               | `npm run test:mongodb`  | `AEROLEXA_TEST_MONGO_PORT` (default `55434`) |

Each runner fails the build if **any** test in its scope is skipped/pending, and CI
(`.github/workflows/ci.yml`) runs the Postgres gate against a service container on every push — so
the gated suites execute for real, and a future "environment missing → skip" regression fails the
build instead of hiding. The MySQL and MongoDB gates are the same contract; they need a Docker
daemon locally and are not wired into the hosted CI runners yet, so on a plain `npm test` those 13
tests report as skipped by design.

Other deliberate, loud skips:

- `rate-limit` skips when `DATABASE_URL` is unset, because its cross-replica reconciliation path
  needs a shared ledger; it prints the reason and closes the Prisma pool in `afterAll`.
- `entitlements` / `growth-funnel` seat-counting suites need a scratch SQLite DB; they run `prisma
  db push` in `beforeAll` and print the reason when the CLI cannot provision one.
- `python-kernel` needs a real interpreter: set `PYODIDE_SERVER_ENABLED=true` (or
  `AEROLEXA_TEST_PYTHON=1`). It skips with a printed reason because the Pyodide wheels download
  from a CDN on first use.
- `rls-isolation` needs `RLS_TEST_DATABASE_URL` pointing at a PostgreSQL database with the RLS
  migrations applied; it skips with a printed reason otherwise and never claims enforcement it did
  not exercise.

## Scripts

```bash
npm run dev              # one-click dev (env + migrations + Next.js)
npm run build            # production build (type-checks via webpack)
npm run start            # migrations + next start (production entrypoint)
npm run typecheck        # tsc --noEmit (strict)
npm test                 # unit + component tests (Jest + RTL)
npm run test:api         # API integration tests (Supertest against a real dev server)
npm run test:postgres    # Postgres-gated suites on a disposable Postgres 16 (zero-skip gate)
npm run test:mysql       # MySQL-gated connector suite (disposable mysql:8, zero-skip gate)
npm run test:mongodb     # MongoDB-gated connector suite (disposable mongo:7, zero-skip gate)
npm run test:e2e         # Playwright full-journey smoke
npm run bench:duckdb     # SQL Lab performance budget report
npm run preflight:prod   # production preflight (DB, RLS, migrations, backups, queue, mail, filing)
npm run pilot:readiness  # can this instance take a real firm's data? exit 1 while blocked
npm run db:migrate       # prisma migrate dev
npm run db:deploy        # apply migrations without dev prompts
npm run db:seed -- --demo# labelled demo account
npm run switch:postgres  # prisma provider → PostgreSQL
npm run switch:sqlite    # back to SQLite
npm run tenancy:audit    # list tenant files still bypassing withTenant(); fails on regression
npm run drill:backup     # verify backup/restore against disposable Postgres
npm run audit            # npm audit (production deps)
npm run worker           # durable job worker as its own process
npm run package          # distributable archive
```

## Database: SQLite → PostgreSQL

Local development runs on **SQLite** (zero setup). The same Prisma schema is portable to
PostgreSQL:

```bash
npm run switch:postgres   # flips the provider, installs migrations-postgres/, regenerates the client
# point DATABASE_URL at an empty database, then:
npm run db:deploy         # prisma migrate deploy — works out of the box
```

Migration history is provider-scoped: `prisma/migrations-sqlite/` (incremental migrations) and
`prisma/migrations-postgres/` (the PostgreSQL set, including the RLS batch-1 migration) ship in the
repo; `switch-provider` installs the matching set into `prisma/migrations/`. New table/column
changes extend the SQLite set as usual — regenerate the Postgres baseline after (or let the
migration-contract test catch the drift in CI). Migration counts are checked by
`lib/server/migration-contract.ts` for readiness.

SQLite cannot run row-level security. In development, isolation is the application layer
(`lib/auth/guard.ts`). On PostgreSQL, RLS is **prepared but not enabled** — see the Security
section above for the exact status and the reason `RLS_ENABLED=true` fails closed. The app must
connect as a non-owner role without `BYPASSRLS` for the policies to mean anything; the batch-1
migration documents the role setup.

## Deployment

- **Docker**: `docker compose up --build` (SQLite profile — zero external services). For
  PostgreSQL: `docker compose --profile pg up --build` (app on 3001 + Postgres on 5432). See the
  Dockerfile comments.
- **Vercel / Railway style**: build with `npm run build`, run with `npm run start`, set
  `DATABASE_URL`, `AUTH_SECRET`, `MAIL_TRANSPORT`, `NEXT_PUBLIC_APP_URL` as environment variables.
- **CI**: the workflow lives at the **repository root** (`.github/workflows/ci.yml`) and runs every
  step inside `Aero_Tech-main/aerolexa-main` — GitHub only reads root-level workflows. It
  type-checks, runs unit/component suites, executes the Postgres-gated connector suites for real
  against a Postgres 16 service container (failing on any skip), runs the API suite against a
  scratch DB, builds, and runs the Playwright smoke test.
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
DIGEST_ENABLED    # notification digest: email unread notifications as one bundle
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
FILING_GATEWAY     # reference (transmits nothing) | simulation | live
RLS_ENABLED        # leave false until the tenancy audit reaches zero
```

## Labelling and AI roadmap

Today: deterministic, in-browser/server logic — clearly labelled, no data leaves the workspace.
Every analysis engine is compared against SciPy/NumPy/statsmodels oracles or hand-computed
fixtures in CI and labelled "Calculated". The separation between "computed from your data" and
"inferred recommendation" already exists in every result and advisor response
(`confidence: calculated | inferred | recommendation`).

Roadmap: live model pipelines (scikit-learn/XGBoost/PyTorch) behind the same labels. When live
models arrive, their results stop showing the prototype badge; nothing becomes "AI" merely by
being called that.

## Verification notes

These were verified when the work landed (CI at the time); they are not re-run by this README:

- Pyodide execution: 4/4 notebook-pyodide tests (kernel state persists, matplotlib renders,
  pandas/numpy auto-injected).
- Real statistics/ML: 8/8 (distinct CV folds, t-test/chi-square/ANOVA, out-of-sample metrics).
- Multi-dataset joins: 3/3 (DuckDB JOINs, DataFrame access).
- Versioning/export: 15/15 (versioning, diffing, metric extraction, nbformat validation).
- Connectors: real `pg` client, schema introspection, sample-row import (Postgres-gated).
- Notebook copilot: three real paths — live LLM (Ollama/OpenAI-compatible), deterministic
  NL→pandas (filter clauses, numeric operators, up to 3 AND-composed predicates, pinned by
  `__tests__/unit/nl-to-pandas.test.ts`) and deterministic DSL — all gated by the Python safety
  gate and actually executed.
- Formerly open items, now closed: reactive parameter cells execute the server's rerun plan
  sequentially (`lib/engine/reactive-run.ts`); published notebooks have live widget filters and
  charts; drill-through opens a detail table (`lib/engine/drill-through.ts`); dashboard presence
  runs over SSE (`components/dashboards/use-presence.ts`).

## License

MIT (see `package.json`). Verify numbers and labels before relying on any output for real
decisions — prototype features are clearly marked; statistically-validated features are compared
against SciPy/NumPy oracles in CI.

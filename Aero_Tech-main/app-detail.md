# AURELIA — App Detail

**Name:** AURELIA
**Tagline:** From Raw Data to Boardroom Decisions
**Type:** Self-hosted data analytics workspace (full-stack web app)
**Stack:** Next.js 14 (App Router / RSC) · React 18 · TypeScript (strict) · Prisma (SQLite dev / PostgreSQL for production) · Tailwind CSS + custom design system · ApexCharts · DuckDB-wasm + Node worker thread · Pyodide · JWT sessions (jose) · Zod env validation
**Version:** 0.1.0
**License:** MIT
**Repository location:** `/workspaces/Aero_Tech/aerolexa-main`

---

## 1. What the App Does

AURELIA is a self-hosted analytics workspace that is **completely driven by your
uploaded data**. You upload a CSV or Excel file and it takes you from raw data to:

- Data profiling
- Analysis (10+ Exploratory Data Analysis types)
- Auto-generated insights
- Business advisor recommendations
- Executive dashboards
- 12-section boardroom reports
- 9-slide presentations
- Exports (PDF/HTML shells, runnable Python scripts, valid `.ipynb` notebooks)

There is **no sample workspace, no invented numbers, and no fake AI**. Every
result is computed deterministically from your exact file. Results are honestly
labelled:

- **"Calculated"** — statistically validated engine (EDA, KPI, distribution,
  correlation, trend) verified against SciPy/NumPy oracles in CI.
- **"Prototype / Demo"** — forecast, what-if, notebook DSL, and advisor.

## 2. Core Loop (the product in one sentence)

Upload CSV/XLSX → streaming parse + profile → Analysis Lab (10 EDA kinds) →
deterministic insights + Business Advisor → dashboards, reports, presentations →
exports.

## 3. Main Screens / Modules

**Onboarding & auth:** signup, login, verify email, password reset, and a 3-step
onboarding flow.

**Core analytics screens (15 sidebar entries + 3 header entries — 18 total):**

| Area | Modules | Main Capabilities |
|---|---|---|
| Home | Landing/hub | Workspace overview, quick access |
| Projects | Project hub | Versioned projects (Active/Draft/Completed/Archived), owner, activity log, roles |
| Datasets | Data hub | CSV/XLSX upload, profiling, `isDemo` flag, quality warnings, materialize SQL results as datasets, version snapshots with change-logs |
| Analyses | Analysis Lab | 10+ EDA types: EDA, trend, KPI, correlation, distribution, forecast, variance, segmentation, cohort, funnel; "How was this calculated?" transparency |
| Insights | Auto cards | Severity (info/warning/critical), evidence, possible cause, business implication, recommended next step, confidence (calculated/inferred/recommendation) |
| Studio | Dashboard builder | Widget canvas: KPI cards, charts, tables, text, filters, recommendations; layout persisted; Save/Duplicate/Rename/Export |
| Dashboards | Reports | 12-section executive template auto-populated from dataset; PDF/HTML export |
| Reports | Presentations | 9-slide board decks with dataset name replacement, insight embedding, chart embedding |
| Notebooks | Notebook | Cell grid (code/markdown), DSL kernel + optional Pyodide (Python) kernel, output persistence, versioning |
| Models | Model trainer | Linear/logistic regression, random forest, gradient boosting, k-means in TypeScript; real train/validation/test split; overfitting guard; downloadable model-card JSON |
| Advisor | Business advisor | Deterministic recommendations with confidence levels |
| Connectors | External data | PostgreSQL, Snowflake, BigQuery, Google Sheets, REST API status; schema import + sample rows; credentials server-side only |
| Scheduled Reports | Scheduler | Cron-defined Report Studio runs → local HTML export + recipient notifications |
| Audit Log | Governance | Read-only, filterable audit trail of key events |
| Prompt Library | Templates | Reusable `{{variable}}` slot templates saved as advisor templates |
| Search | Catalog | Unified search across projects, datasets, analyses, insights, dashboards, reports, presentations, notebooks, models, prompts |
| Notifications | User | In-app notification preferences |
| Settings | Config | Profile, data sources, security, audit log |

**Also present:** SQL Lab (in-browser and server DuckDB engine with
`materialize as dataset`), what-if causal projections, team collaboration
(OWNER/EDITOR/VIEWER roles + threaded comments), SSO (OIDC/SAML) status surface,
dataset/analysis versioning with diff views, and Python code export.

## 4. Tech Stack & Architecture

- **Frontend:** Next.js 14 App Router with React Server Components, mobile-first
  responsive design (desktop 1440, tablet 768, mobile 375), bottom nav < 640px.
- **Design system:** deep-neutral palette (`#0A0A0A`/`#121212`), accents
  (`#5AA8AA`, `#FFB400`), WCAG-AA contrast, focus rings, skip links, keyboard
  navigation, and Loading/Empty/Success/Error states on every screen.
- **Analytics engines** (`lib/engine/`): stats, analyses, insights, advisor,
  studio, dataset loader, SQL, training, what-if, cron, notebook-DSL — all
  deterministic and transparent.
- **Upload pipeline:** streaming CSV/XLSX parse → typed NDJSON + profile
  (`lib/file/parse.ts`), SQL results materialized as datasets.
- **Database:** Prisma + SQLite (zero-setup dev) or PostgreSQL via provider
  switch; server-side workspace isolation (`lib/auth/guard.ts`) plus Prisma RLS
  (`prisma/rls.sql`) as defense-in-depth in production.
- **Security:** no hard-coded credentials (Zod env validation), CSP headers,
  rate limiting (auth 30/10 min, upload 60/hour/IP, signup 10/hour), JWT
  sessions, audit logging, `isPII` flag at upload, OWASP ZAP scan in CI.

## 5. Key Extended Modules (10)

1. Interactive Notebook (DSL + optional Pyodide/Python)
2. SQL Lab (DuckDB engine, worker thread + wasm, materialize results)
3. Model Training (prototype, real statistics, versioned model cards)
4. Causal / What-if projections
5. External Connectors (Postgres, Snowflake, BigQuery, Sheets, REST)
6. Scheduled Reports (cron runner)
7. Team Collaboration (roles + threaded comments)
8. SSO (OIDC/SAML status)
9. Prompt Library (`{{variable}}` slot templates)
10. Data-catalog search + versioning/reproducibility (immutable dataset &
    analysis snapshots, Python script + `.ipynb` exports)

## 6. Quality & Testing

- **Tests:** Jest unit + component (33 suites, 255+ tests passing), Supertest API
  suites, Playwright E2E full-journey smoke, and SciPy/NumPy oracle reference
  tests for stats correctness.
- **Gates (green as checked in):** `npm run typecheck` clean, `npm run lint`
  0 errors, `npm run build` 56/56 static pages.
- **Performance:** first-load JS ≈ 87 kB shared; SQL Lab benchmarked against a
  real budget over 100k synthetic rows; DuckDB-wasm code-split into a ~1 MB chunk.
- **4 optional suites** are intentionally skipped until runtimes exist
  (a real PostgreSQL for connector/scheduler tests, and `.venv` Python with
  numpy/scipy/pandas/sklearn/nbformat for exported-script execution tests).
  See the `progress` runbook.

## 7. Run It Yourself

```bash
npm install
npm run dev            # one-click: creates .env → applies migrations → Next.js
# open http://localhost:3000, sign up, finish onboarding, upload a CSV/XLSX
```

Docker: `docker compose up --build` (SQLite profile), or
`docker compose --profile pg up --build` for PostgreSQL.

## 8. Target Users — Who Can Benefit

AURELIA is built for people who need to turn their own data into decisions
without depending on a data-science team or a paid cloud BI license:

1. **Business analysts & data analysts** — profile and explore raw data,
   run 10+ analysis types, validate numbers with a deterministic,
   statistically-checked engine (SciPy-verified), and publish analyses — no
   spreadsheet gymnastics needed.
2. **Executives, founders & decision-makers** — one upload produces KPI cards,
   executive dashboards, a 12-section boardroom report, and a 9-slide
   presentation, so raw data becomes boardroom-ready material.
3. **Small-to-medium businesses (SMBs) and startups** — a self-hosted,
   zero-subscription analytics workspace that runs on their own infrastructure;
   data never leaves the workspace (privacy-friendly, `isPII` flag at upload).
4. **Consultants & agencies** — analyze client datasets and produce polished
   reports/presentations per client, all tied to the client's real data with
   clearly labelled methodology.
5. **Teams needing collaboration & governance** — project roles
   (OWNER/EDITOR/VIEWER), threaded comments, audit logs, versioning with
   diffs — useful for regulated or quality-conscious workflows.
6. **Analysts who want reproducibility** — dataset/analysis versioning and
   "Export runnable code" (standalone Python scripts validated in CI, plus
   valid `.ipynb` notebooks) keep every result auditable and re-runnable.
7. **Privacy-conscious organizations** — SSO support, workspace-level
   isolation/RLS, and a no-fake-AI "Calculated vs Prototype" labelling policy.

**What this app is NOT for:** teams with thousands of concurrent seats or
petabyte-scale warehouses — it is a self-hosted, mid-market analyst/executive
workspace, not an enterprise data platform. Prototype features (forecast,
what-if, notebook DSL, advisor) are honest stand-ins until real ML pipelines are
added on the roadmap (Pyodide notebooks, server-side scikit-learn/XGBoost/
PyTorch).

---

*Generated from the repository at `/workspaces/Aero_Tech/aerolexa-main`*
*(primary source: `README.md`, `package.json`, `docs/hex-gap-analysis.md`, and the `progress` runbook).*
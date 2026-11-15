# Ledgerly — Security & Data Handling

## Secrets and environment

- Every secret (DB URL, auth secret, SMTP) is read from the environment through
  `lib/env.ts` (validated with Zod at boot). **Never** commit a real `.env`.
- `.env.example` documents every variable; `npm run dev` generates a local
  `.env` with a fresh `AUTH_SECRET` when missing.
- No hard-coded credentials or API keys exist anywhere in the codebase —
  verified by the `audit` script and CI.
- Client bundles only ever contain `NEXT_PUBLIC_*` (non-secret) values.

## Authentication & sessions

- Passwords: bcrypt (bcryptjs, 12 rounds) in `lib/auth/password.ts`.
- Sessions: signed JWT cookies (`jose`, HS256) with issuer/audience claims,
  verified by both `middleware.ts` (route gating) and `lib/auth/session.ts`
  (data access). Cookie is httpOnly by default.
- Verification/reset tokens are stored hashed, single-use, expiring.
- `AUTH_REQUIRE_EMAIL_VERIFY` is on by default in production guidance; in dev
  (console mail transport) it stays off so one-command onboarding works.

## Authorization (workspace isolation)

The prototype models one personal workspace per account. Every workspace-
scoped table carries `workspaceId`, and **every** route handler:

1. resolves the authenticated user + workspace server-side
   (`requireAuth` / `requirePageAuth`), and
2. asserts the requested row belongs to that workspace
   (`assertWorkspaceAccess` in `lib/auth/guard.ts`) before reading or writing.

Ownership IDs from the client are never trusted. The API integration suite
proves cross-workspace access is refused (403 on another account's resource).

**Row-level security** (`prisma/rls.sql`, PostgreSQL only) is prepared as an
_additional_ layer but is **not active by default**, though the query layer is now wired
(`RLS_QUERY_LAYER_WIRED = false` in `lib/server/rls-status.ts`: the query layer is **not** wrapped yet, and `npm run tenancy:audit` reports the gap). The file enables and FORCEs policies on the
org/workspace tables, so it is real — but it only protects a deployment that
also (a) connects as a dedicated non-owner, non-`BYPASSRLS` role and (b) runs
tenant queries through `withTenantContext()` (which sets the `app.current_*`
GUCs). Enforcement therefore still needs (a), (b) **and** `RLS_ENABLED=true`; turning
it on without the non-owner role hides every row. The primary isolation boundary remains the application layer
above; the `/api/health` probe reports the live RLS status.

### Shared projects (collaboration)

Sharing is explicit and role-gated. Every project may carry `ProjectMember`
rows granting another account OWNER/EDITOR/VIEWER. All role checks funnel
through **one resolver** (`artifactRole` in `lib/server/members.ts`):

- the project's owner → OWNER,
- a matching `ProjectMember` row → that row's role,
- any artifact in the user's own workspace (legacy single-owner model) → OWNER,
- otherwise → no access (403).

Writes (analyses, dashboards, reports, presentations, materialize, training)
require EDITOR+; comments and reads require VIEWER. Owner email addresses are
masked from non-owners in team listings. Write routes that pre-date sharing
were retrofitted to `requireRowRole` so a shared viewer can never mutate
someone else's artifact.

## Upload & data pipeline

- Uploads: CSV/XLSX only, validated by extension + MIME; size cap
  (`MAX_UPLOAD_BYTES`, default 100 MB); streamed to disk under `data/uploads`
  which is git-ignored and never publicly served.
- Parsing streams rows to a normalized NDJSON store under `data/parsed` —
  never inlined into the database.
- Files are typed (number/date/boolean/string), profiled for missing values,
  duplicates, near-constant columns and outliers; findings surface as
  `qualityWarnings` banners and dataset-profile chips.
- Deleting a dataset removes its row and deletes the stored files.

## Extended-module security notes

- **SQL Lab** — queries run on the **DuckDB engine** (`lib/engine/duckdb/`)
  by default: a real read-only database, but never connected to your data
  store. The dataset's rows are loaded into an in-memory TEMP table on a
  worker thread (or, when enabled, in the browser via DuckDB-wasm) and
  executed with `enable_external_access=false` — no ATTACH, file or HTTP
  access. A shared read-only guard (`assertReadOnlySql`) requires the query to
  start with SELECT and rejects DDL/DML keywords and multiple statements; the
  route caps result rows (`DATASET_QUERY_LIMIT`). If DuckDB cannot initialize
  (e.g. a serverless runtime without wasm/worker support), the request fails
  with an explicit 503 `ENGINE_UNAVAILABLE` error and a remedy — the lab never
  silently downgrades to weaker results. Operators can opt into the
  deterministic parser (`lib/engine/sql.ts`, `SQL_PROTOTYPE_FALLBACK=true`),
  whose results are clearly labelled as degraded. Engine validation failures
  map to 400 (SQL_INPUT), never 500s.
- **Model training** — deterministic local trainer; no external service, no
  data leaves the workspace. `TRAINING_ENABLED=false` disables the endpoint
  (503). Supervised models use a train / validation / test split; the UI leads
  with held-out metrics and warns when the train-vs-held-out gap signals
  overfitting.
- **Notebook** — prototype DSL executes over the dataset's row store server-side;
  Python (Pyodide) only loads from an operator-configured public URL. Outputs
  are persisted on the notebook row, never executed client-side.
- **Scheduled reports** — generation runs server-side with the same export
  renderer as the report pages; recipients are validated email addresses and
  mail transport is the console in dev (no credentials needed).
- **Connectors & SSO** — only _booleans and labels_ reach the client
  (`lib/server/features.ts`); connection strings and OIDC/SAML secrets stay in
  server-only env vars.

## Demo-mode labelling policy

Ledgerly's current intelligence is deterministic prototype logic (no hidden
LLM/ML service). The UI is transparent about this:

- `components/ui/feedback.tsx` → `DemoBadge` with tooltip "Calculated using
  prototype logic; live ML pipelines coming soon." is rendered on:
  - forecast & cohort analysis results,
  - advisor responses assembled from prototype rules,
  - the labelled demo dataset generator (`Dataset.isDemo = true`),
  - exports (footer: "Charts were rendered deterministically for export…").
- Synthetic demo data is named and badged "Demo / Synthetic" everywhere
  (dataset name prefix, project names, `isDemo` flag, list badges).
- **Never** fake a live integration: if a feature needs a pipeline that isn't
  there, it falls back to labelled deterministic logic rather than a spinner
  that silently fails.
- `Settings → AI preferences` toggles badge visibility; toggling it never
  changes the underlying (still deterministic) logic.

## Privacy

- Your uploaded data never leaves your workspace in this prototype: parsing,
  profiling, analyses, insights and exports all run in-process. No third-party
  analytics or model providers receive your rows.
- Emails in development print to the server console (`MAIL_TRANSPORT=console`).
- Deleting your data = removing the dataset row + files on disk. (Account
  deletion is a listed next step on the roadmap.)

## Rate limiting

Auth and upload endpoints are rate-limited by client IP with a fixed-window,
memory-bounded in-memory limiter (`lib/server/rate-limit.ts`), returning HTTP
429 + `Retry-After` when exceeded:

- signup 10/hour, login 30/10 min, verify/resend/forgot/reset 10–20/10 min,
  upload 60/hour per IP.

The limiter is deliberately single-process; a multi-instance deployment should
swap the store for a shared one (Redis/Upstash) — call sites stay identical
because enforcement is behind `enforceRateLimit`. Unit tests in
`__tests__/unit/rate-limit.test.ts`.

## Supply-chain audit (npm audit)

`npm run audit` (`npm audit --omit=dev`) is the documented pre-shipping check
(not part of CI, so an upstream advisory can't break unrelated merges). Run it
before any release. Current residual findings and their disposition:

- **`next@14.2.35` + bundled `postcss`** (high). The advisories against the
  Next.js runtime and its bundled PostCSS are only resolved upstream in
  **Next 16**, a major release that requires React 19 and a breaking migration.
  Ledgerly deliberately pins Next 14 (specified stack); 14.2.35 is the final
  14.x patch. **Action:** track the Next 16 upgrade as a dedicated, tested
  migration before any public launch, and re-run `npm audit` after it.
- **`deepmerge-ts <8.0.0` via `@prisma/client`/`@prisma/config`** (high).
  Stack-exhaustion DoS when merging untrusted recursive graphs; not an
  exploitable path in Ledgerly's Prisma usage (no user-controlled recursive
  merges). **Action:** re-run `npm audit` when a fixed Prisma release that
  allows `deepmerge-ts@8` is published.

No fix is forced because every available resolution (`next@16`, upstream
`eslint-config-next@16`, newer Prisma majors) is a breaking upgrade that would
require re-verifying the whole build.

## Threat notes / hardening roadmap

- `SESSION_TTL_DAYS` is configurable; production should use secure cookies over
  HTTPS and a short TTL.
- Brute-force lockout beyond IP rate limiting (per-account backoff) is a
  natural next step.
- Audit logging of security events is on the roadmap (sign-in/out events are
  recorded today via `lib/server/activity.ts`).
- The demo seed account (`db:seed --demo`) exists only for evaluation; remove
  it or disable it before a public launch.

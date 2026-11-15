# Changelog

All notable changes to Ledgerly will be documented in this file.

## [Unreleased]

### Added (next stage: live-filing pilot, client identity, company-law exposure, operations)

Four workstreams that move the product from provable prototype to a controlled live pilot. Each
keeps the repo's honesty rule: configuration is never presented as proof.

- **Filing pilot ledger** (`lib/server/filing-pilot.ts`, `/api/organization/compliance/filing-pilot`,
  `/compliance/pilot`): shows the gateway provider, per-channel credential gaps, live vs simulated
  submissions, reconciled filings and the exact next action. A configured gateway with no reconciled
  filing is still a pilot. Pinned by `__tests__/unit/filing-pilot.test.ts`.
- **Client portal identity** (migration, `lib/server/portal-auth.ts`, portal sign-in pages, firm-side
  invite panel): a firm can invite a named client email; the client signs in with a single-use,
  15-minute magic link and an httpOnly session scoped to the engagement. Approval receipts are now
  version 2 and record `identity: magic-link | portal-link` plus the account id; version 1 receipts
  still verify. Approval identity comes from the session cookie, never the request body.
- **Effective-dated penalty schedules** (`lib/engine/penalty-schedule.ts`): AOC-4, MGT-7, LLP-8,
  LLP-11 and DIR-3 KYC are now priced from cited, window-scoped schedules (₹100/day, with the
  post-180-day figure labelled an upper bound; ₹5,000 flat for DIR-3 KYC). The monthly client report
  prices them and still reports professional tax as unpriced because its schedule is state-specific.
- **Operations**: token-guarded Prometheus metrics at `/api/metrics` (queue depth, dead jobs, oldest
  pending age, backup age/verification, filing readiness), env-overridable queue thresholds, and a
  standalone worker process (`npm run worker`) so web replicas need not drain the queue.
- **Invite delivery evidence**: every portal login token records `deliveryStatus` (pending/sent/failed)
  and the failure reason; the firm's invite panel shows it, while the public request endpoint stays
  non-enumerating. `preflight:prod` now warns when mail is still the console transport.
- **Professional-tax late fees**: `lib/engine/pt-late-fee.ts` encodes effective-dated rules for
  Maharashtra (graded 1.25/1.5/2% + 10%), Karnataka (1.5% + 10%), Gujarat (18% p.a.), and West Bengal
  (1%, discretionary penalty excluded). Tamil Nadu is explicitly `conflicting` because published
  sources quote both 1% and 2%; no figure is invented. The report passes the client's state through.
- **Signed approval receipts**: receipt v3 attaches a detached `SHA256withRSA` signature over the v2
  digest using the existing external `FILING_SIGNING_*` service. No service configured → v2 as
  before; signing configured but failing → the approval is refused, never silently downgraded.
- **Durable mail outbox**: notifications are queued in `MailOutbox` and delivered by the worker with
  exponential backoff (30s → 1h, 5 attempts), so an SMTP outage or crash retries instead of losing the
  message. `preflight:prod` reports failed deliveries and `/api/metrics` exposes the posture.
- **Receipt trust chain**: `POST /api/verify/approval-receipt` verifies a pasted receipt without an
  account (digest recomputation, structural checks, and RSA verification when
  `FILING_SIGNING_CERT_PEM` is set). `GET …/filings/:id/audit-bundle` packages the run, receipt and
  append-only event trail into a downloadable JSON artifact for a client or auditor.
- **Shadow filing**: `GET …/filings/:id/shadow` returns exactly what a live submission would send and
  every blocker (payload digest, idempotency token, credentials, signing) without a network call. It is
  labelled `willTransmit: false`.
- **ITC match confidence**: `/api/gst/itc-recon` now returns a derived confidence score, band counts and
  a lowest-score-first exception worklist alongside the unchanged reconciliation and Table 4 figures.
- **Per-tenant operational posture**: `/api/metrics` adds tenant attention levels and outstanding
  overdue filings, so one firm's backlog is visible instead of hidden in a deployment-wide total.
- **Coverage**: the client calendar now generates monthly EPF ECR and ESI contribution obligations for
  employers, alongside GST, TDS, income-tax, ROC, PT and audit dates. Firm-triggered nudge digests are
  rendered from the same tasks and queued through the outbox.
- **Per-client filing rollout**: `FilingRollout` keeps each client in `shadow` or `live`. With
  `FILING_ROLLOUT_ENFORCED=true`, a submit for a shadow client is refused (`409 FILING_SHADOW_ONLY`)
  while the shadow preview still works; simulation/reference providers are unaffected. Managers promote
  or demote via `GET/PATCH /api/organization/engagements/:id/filing-rollout`.
- **Receipt PDF + public verification page**: `/api/organization/compliance/filings/:id/audit-bundle?format=pdf`
  renders the bundle with a dependency-free PDF writer, and `/verify/receipt` lets a client or auditor
  paste a receipt and see each check without an account.
- **Bulk client onboarding**: `POST /api/organization/engagements/import` accepts a CSV client list,
  validates every row (name, GSTIN, constitution, FY, duplicate codes) and writes engagements plus
  compliance profiles in one transaction — all-or-nothing, with line-numbered errors.
- **Evidence-backed go-live**: `GET …/engagements/:id/filing-go-live` assesses the live gateway, channel
  credentials and required DSC signing before promotion. Promotion refuses unresolved blockers (with the
  assessment in the error) unless a manager overrides with a written note; both rollout endpoints share
  the gate.
- **Operator alerts**: `GET /api/ops/alerts` (METRICS_TOKEN) turns queue, outbox, backup, tenant and
  filing-credential posture into ranked critical/warning alerts with remedies. `/api/metrics` exposes the
  counts as `ledgerly_ops_alert`.
- **Statute review queue**: `GET /api/statutes/review-queue` lists the ingested notifications still
  awaiting a decision, flagging missing effective dates and parser warnings before a rule version is
  drafted or published.
- **Canary rehearsal**: `npm run filing:canary -- --payload file.json` writes one evidence file with
  readiness, the shadow plan, the live credential preflight and (only with `--submit`) the portal
  receipt. Live submission additionally requires `--confirm-live` and `CANARY_ALLOW_LIVE=true`;
  nothing is written to the database.
- **Tenancy honesty + audit**: `RLS_QUERY_LAYER_WIRED` is now correctly `false` (it was hard-coded
  `true` while `withTenantContext()` had zero call sites, so enabling RLS would have hidden every row).
  `npm run tenancy:audit` measures unwrapped tenant files and exits 1 if RLS is requested anyway.
  Prepared policies now cover the filing, client-portal, compliance and outbox tables.

### Fixed / Hardened (accounting write path — validated money, atomic postings, honest errors)

The books write path silently repaired bad input and could double-post under concurrency. It now
refuses what it cannot represent and makes the lifecycle transitions atomic.

- **One boundary validator for money and dates.** New `lib/server/finance-validation.ts` rejects
  fractional paise (`1.5` used to be `Math.round`-ed away), non-calendar dates (`2026-02-31` used to
  pass the `yyyy-mm-dd` regex) and malformed journal lines. Applied to vouchers, account opening
  balances, adjustment journals and closing entries on both create and update, so the database can
  no longer hold an entry the engine would refuse. Update paths that rebuild lines (closing entries)
  now re-run `validateEntry` — an edit could previously write an unbalanced journal.
- **Post/approve are compare-and-swap transactions.** Approving claims `status = draft`; posting
  claims `status = approved` (via `updateMany`, asserting exactly one row) and creates the voucher,
  flips status and writes the audit row in one transaction. Two concurrent posts can no longer both
  create a voucher, and a crash cannot leave a voucher without its posted journal. Reversal is also
  a single transaction and refuses a second reversal.
- **Voucher creation is race-safe.** The duplicate-number check moved into the write transaction;
  the unique index remains the final arbiter and the new Prisma error mapping turns a lost race into
  `409 CONFLICT` instead of `500`.
- **Request bodies are validated before the store.** `POST /api/books` and
  `POST /api/books/[id]/vouchers` parse zod schemas (required strings, ISO dates, integer paise,
  at least two voucher lines) rather than trusting TypeScript generics.
- **Prisma constraint errors are client-actionable.** `P2002` → `409 CONFLICT`, `P2025` → `404
NOT_FOUND`, `P2003` → `409 CONFLICT`, instead of every unique/FK violation leaking a generic 500.
- **Job-queue idempotency survives the unique-index race.** Two replicas passing the pre-check no
  longer make the loser fail: a `P2002` on `idempotencyKey` is re-read and returned as deduplicated.
- **Webhook dedupe keys are stable across retries.** The Razorpay webhook no longer falls back to
  `crypto.randomUUID()` (which made every provider retry look like a new event); it uses the payment
  id, then order id, then a SHA-256 of the raw body.

Pinned by `__tests__/unit/finance-validation.test.ts` (12 oracles) and
`__tests__/unit/finance-hardening.test.ts` (source-gated lifecycle/error contracts).

### Added / Changed (tenancy, reconciliation, exports, query shape)

- **Explicit active organization.** `getAuth()` no longer takes
  `organizationMemberships[0]`: the active firm is an httpOnly cookie validated
  against the user's memberships (`lib/auth/active-org.ts`), with
  `GET/POST /api/me/active-organization` to list and switch. A stale/revoked
  selection falls back to the first membership instead of touching another
  tenant. `requireOrganizationRole()` adds a role-list gate alongside the
  existing `requireOrgRole()` rank check for org-scoped writes.
- **GST register ↔ ledger reconciliation.** New
  `GET /api/books/[id]/gst-invoices?action=ledger-reconciliation&period=…`
  reports register totals, whether posted invoices have a `GST:<invoiceId>`
  voucher, and the exact missing invoice numbers. Posting mode is explicitly
  `register-only` rather than pretending the two books agree.
- **Write-path rate limiting.** Added the `books_write` bucket (240/min per
  user) and applied it to book, voucher, closing-entry, adjustment-journal and
  GST-invoice writes.
- **Typed output guards everywhere.** Scheduled-notebook HTML export, notebook
  handoff and nbformat export now narrow through
  `isTableOutput`/`isConditionalTableOutput`/`isTabularOutput` instead of
  casting persisted JSON.
- **Day book queries push the date range into SQL.** `getDayBook` no longer
  materialises the client's entire voucher history, and `getBookSnapshot`
  reads only accounts. GST invoice create/update validate ISO dates and
  integer paise.
- **Root duplicates removed.** The untested root copies of `india-tax.ts`,
  `gst-rate-validation.ts`, `india-chart-of-accounts.ts`, `msme-samadhaan.ts`,
  `professional-tax.ts` and `form-3cd.ts` were deleted (five had already
  drifted from the tested `lib/engine/*` versions).

### Added (CA firm work — CA computation workspace + direct-tax API wiring)

The direct-tax engines existed, were unit-tested, and were reachable from **no live API and
no UI** — the app computed GST books but could not compute a client's income-tax position. This
closes the biggest of those wiring gaps.

- **Six new kinds on `POST /api/ca/compute`.** `income-head-salary`, `house-property`,
  `capital-gains`, `itr`, `advance-tax` and `advance-tax-advisory` now dispatch `income-head-salary.ts`,
  `income-head-house-property.ts`, `income-head-capital-gains.ts`, `ca-itr-computation.ts`,
  `ca-advance-tax.ts` and `advance-tax.ts` respectively — all previously importable only by their
  own tests. The API boundary is RUPEES for every kind; each engine's own money unit is converted
  explicitly (integer paise for the income heads and the advisory, whole rupees for the ITR and the
  projection), so the 100× class of bug the GST-filing bridge had to fix cannot recur here.
- **A real CA Compute workspace (`/ca-compute`).** `components/ca/ca-compute-workspace.tsx` is the
  caller those engines never had: an ITR computation (income heads + Chapter VI-A deductions) that
  bridges its rupee liability straight into the paise advance-tax advisory, plus salary u/s 17
  (with the old-vs-new regime grader), house property and capital gains panels. Every panel renders
  the engine's own methodology trace. Wired into the nav, the ⌘K command palette and the auth
  middleware's protected prefixes.
- **Oracle coverage.** `__tests__/unit/ca-direct-tax-route.test.ts` (10 hand-computed route oracles,
  including the ITR→advisory bridge) and `__tests__/components/ca-compute-workspace.test.tsx`
  (3 component tests asserting the exact posted payloads).

### Added (CA firm work — TDS suite API + workspace)

- **Three TDS engines wired to `POST /api/ca/compute`:** `tds-section` (the applicability matrix),
  `tds-challan-recon` (challan ↔ bank-credit reconciliation) and `tds-penalty-exposure` (interest
  u/s 201(1A) and fees u/s 234E/271Q) — all previously reachable only from their own tests. All money
  crosses the boundary in rupees and is converted to integer paise.
- **A TDS tab in the CA Compute workspace** covering the section matrix, challan reconciliation and
  penalty/interest exposure.

### Added / Fixed (CA firm work — orphan TDS/CA engines wired; two unit defects fixed)

Six more engines that were complete and unit-tested but importable only by their own test now run
behind `POST /api/ca/compute` and a workspace panel. Two carried a money-unit defect that had to be
fixed before they could cross the rupee boundary at all — both are now pinned at their corrected
values, so the class of bug cannot return unnoticed.

- **Fixed — `tds-threshold-engine`'s threshold table was a factor of ten low.** `getThresholdForSection`
  carried bare literals (e.g. `30_00_00` = 30,000) where true paise for 194J's ₹30,000 trigger is
  `3_000_000`, while `tds-sections.ts` stored the correct `30000 * 100`; a true-paise caller would have
  over-triggered TDS. Thresholds are now declared in WHOLE RUPEES through a single `inPaise()` helper
  (`inPaise(30_000)`), so the unit is explicit at the point of declaration. `processTdsPayments` also
  accepts a brought-forward `carryOver` aggregate, so a year-to-date position round-trips into the next
  batch. The earlier "deliberately NOT exposed" note is **superseded**: `tds-threshold` is now a live
  kind (route + workspace panel).
- **Fixed — `tds-form16-generator` worked in deci-rupees** (rupees × 10) while documenting paise, so
  every figure it returned was a factor of ten below the minor-unit contract the rest of the CA engines
  use — understating Form 16 Part B tax 10×. It is now rupees × 100 true paise throughout (standard
  deduction, 87A ceiling/rebate, slab tax in and out).
- **New kinds wired:** `tds-threshold`, `tds-computation` (`ca-tds-computation`), `tax-audit`
  (`ca-tax-audit`), `tds-ldc` (`tds-ldc-form15g`), `tds-form16` (`tds-form16-generator`) and
  `itr-schedules`. Rupee-native engines (`ca-tds-computation`, `ca-tax-audit`) are fed rupees; the
  paise engines convert at the boundary. Pinned by `__tests__/unit/ca-orphan-engines-route.test.ts`.

### Added / Fixed (launch readiness — production safety, request caps, durable DPDP proof, RLS honesty)

- **Production transport gate.** `next start`, the shipped Docker images and the hosted runbook all run
  `NODE_ENV=production`, yet nothing stopped a half-configured instance from booting with the dev
  transports: `MAIL_TRANSPORT=console` prints email-verification and password-reset links to the server
  log, and console OTP prints live sign-in codes. The env schema now REFUSES to boot a production
  instance unless `MAIL_TRANSPORT=smtp` and `AUTH_REQUIRE_EMAIL_VERIFY=true`, failing fast with a
  readable message; `lib/auth/phone-otp.ts` likewise refuses to print a production OTP (503). A
  deliberate `ALLOW_INSECURE_PROD_TRANSPORTS=true` opt-out exists for staging / internal demos / the
  zero-config `docker compose up` profile. Pinned by `__tests__/unit/prod-safety.test.ts`.
- **Bounded JSON request bodies.** `readJsonBody` buffered the entire request into memory with no cap.
  It now enforces `MAX_JSON_BODY_BYTES` (default 5 MB) from the declared Content-Length AND while
  streaming — a chunked body or a lying/absent header cannot make the server buffer an unbounded
  payload — answering 413. Pinned by `__tests__/unit/read-json-body.test.ts`.
- **Durable DPDP proof-of-erasure.** The erasure audit row lived in `Activity`, which is
  workspace-scoped with `onDelete: Cascade`: erasure deletes the personal workspace, so the proof was
  being cascade-deleted by the very operation it documented. A new `ComplianceEvent` model (no FK, no
  cascade, append-only) holds the DPDP proof; `eraseUser()` writes it LAST, so evidence only exists if
  every erasure step committed. The same change fixes a latent bug where deleting a Workspace cascaded
  to its owning `User` (FK `onDelete: Cascade`), leaving a half-erased account and a 500 — the owner FK
  is now detached (in a transaction) before the workspace delete. Pinned by
  `__tests__/unit/dpdp-erasure.test.ts`.
- **Schema-drift gate + reconciled migrations.** Prisma delegates (`prisma.gstInvoice`, …) were called
  for models no migration ever created, so a freshly migrated database was missing 35 tables and those
  requests died with P2021. Because CI mocks Prisma (and the API suite booted against an accumulated
  DB), nothing failed. New migrations reconcile both shipped sets, and
  `__tests__/unit/schema-drift.test.ts` asserts every schema model has a `CREATE TABLE` in BOTH the
  SQLite and PostgreSQL sets and that the active `prisma/migrations` directory stays in sync with its
  source set (a switch-provider round-trip had silently deleted a hand-added FK fix).
- **RLS honesty.** `prisma/rls.sql` gains `FORCE ROW LEVEL SECURITY` — without it a table owner is
  exempt from its own policies, so RLS is a silent no-op. Because the query layer is still not wrapped
  in `withTenantContext()` (ROADMAP 2.5), enabling RLS today would hide every row; `lib/server/tenancy.ts`
  now exposes `RLS_QUERY_LAYER_WIRED` and `rlsConfigError()`, and the health endpoint reports both the
  requested/effective status and live enforcement (role, superuser/bypassrls, tables with/without
  FORCE), so a deployment can see whether isolation is genuine. Application-level isolation
  (`lib/auth/guard.ts`, `lib/server/members.ts`) remains the boundary until then.
- **Rate-limit fail-open is now observable.** If the shared replica ledger is unreachable, each replica
  enforces only its own budget, so the effective cluster limit can rise to `limit × replicas` for the
  outage. This remains a deliberate availability trade-off, but it now warns (at most once a minute)
  instead of degrading silently. Pinned by `__tests__/unit/rate-limit-failopen.test.ts`.

### Added / Fixed (CA firm work — GST portal filing UI + gst-filing boundary)

- **GST filing workspace (UI).** `components/books/gst-filing-panel.tsx` is the caller the filing route never had:
  GSTR-3B computed from the book's validated/posted invoices, GSTR-9 from annual caller-supplied aggregates, and the
  filing-campaign lifecycle (create → update → submit through `resolveFilingGateway()`) — with the active provider
  (reference / simulation / live) and missing credentials shown **before** anything is filed. Wired into the Books
  workspace as a **GST filing** tab.
- **Fixed — gst-filing money units.** The route fed caller-supplied rupees straight into the integer-paise engines, so
  GSTR-9 (and the GSTR-3B ITC add-back) were 100× wrong. All money now crosses the API in **rupees** and is converted in
  `lib/engine/gst-filing.ts`, matching `/api/ca/compute` and `/api/gst/itc-recon`; pinned by
  `__tests__/unit/gst-filing-bridge.test.ts` (hand-computed oracle).
- **Fixed — unreachable GSTR-9 endpoint.** `action=gstr9` was handled by the GET handler but read a JSON body, which a GET
  cannot carry. It is now `POST action=gstr9`.
- **Fixed — `update-campaign` read `body.urn`** instead of `body.irn`, so an IRN update was silently dropped.
- **Removed the stray `Aero_Techmain/` tree** — a duplicate directory holding an unimplemented skeleton of the filing
  panel and its barrel. The canonical implementation lives under `Aero_Tech-main/aerolexa-main/`.

### Added (CA firm work — Phase A: India computation core)

Three advanced, India-first computation engines with hand-computed oracle tests. They sit on top of the existing
`accounting.ts` / `ca-india.ts` layers and fill the biggest gaps I found in the CA domain: direct tax, depreciation and
the GST return layer (the old code computed a GSTR-3B-shaped liability but had no GSTR-1, reconciliation or e-invoice).
Every rate, slab, threshold and useful life is **caller-supplied data** with labelled defaults — the `ca-india.ts`
rule that a hardcoded table is how compliance software produces confidently wrong returns the month a Finance Act
lands. These engines COMPUTE liability; they do not file, and they do not read portal upload schemas.

- **`lib/engine/india-tax.ts` — direct tax.** Slab tax for the new and old regimes (AY 2025-26 defaults),
  section 87A rebate with the new-regime marginal relief that removes the ₹7L cliff, surcharge with marginal relief at
  every band, and 4% health & education cess — all as an exact surcharge→cess chain in integer paise. Also: HRA exemption
  u/s 10(13A), the advance-tax schedule with interest u/s 234B/234C, corporate tax under the normal / 115BAA / 115BAB
  regimes with MAT u/s 115JB (payable = higher of normal and MAT), and listed-equity capital gains (111A/112A).
  Gated by `__tests__/unit/india-tax.test.ts` (20 tests).
- **`lib/engine/depreciation.ts` — depreciation.** Companies Act 2013 Schedule II SLM and WDV (WDV rate derived from the
  residual value, with the 5% ceiling enforced), and Income-tax block-of-asset WDV with the **half-year rule** (an asset
  used under 180 days earns half the block rate), 32(1)(iia) additional depreciation, sale proceeds reducing the block,
  and the u/s 50 short-term capital gain when the block goes negative. Gated by `__tests__/unit/depreciation.test.ts`
  (10 tests).
- **`lib/engine/gst-returns.ts` — GST returns.** GSTR-1 classification into B2B / B2CL / B2CS / exports / nil (with the
  rule that an inter-state B2C invoice above the ₹2.5L threshold is reported invoice-wise, not consolidated), rate-wise
  and HSN summaries, GSTR-3B ↔ GSTR-1 reconciliation with a rupee tolerance, interest u/s 50, late fee, and an e-invoice
  payload builder + structural validator (intra-state CGST/SGST split, inter-state IGST, notified-rate and GSTIN checks).
  It builds the document the IRP accepts; it does not issue an IRN. Gated by `__tests__/unit/gst-returns.test.ts` (12 tests).

### Added (Phase 5 — Customer Attraction)

- **Security response headers (5.3).** The app shipped with **no** security headers at all: no CSP, no HSTS, no frame
  protection, no MIME-sniffing protection. `lib/server/security-headers.ts` adds the full set, applied by the middleware
  on every response. CSP is **nonce-based, not `'unsafe-inline'`** — a 16-byte nonce from `crypto.getRandomValues`
  (not `Math.random`: a predictable nonce is equivalent to no CSP) passed to the render via `x-csp-nonce`.
  `'unsafe-eval'` is development-only, for React Refresh.

  The statically-generated JSON-LD blocks on `app/templates/[id]` cannot receive a per-request nonce, so they are
  authorised by **SHA-256 hash** instead — strictly stronger than `'unsafe-inline'`, because the hash matches only that
  exact byte sequence. The hashes are generated (`npm run generate:jsonld-hashes`) from the same `templateJsonLd` helper
  the page renders, so policy cannot drift from markup.

- **HSTS, gated to production (5.3).** Sending HSTS over plain HTTP in development pins `localhost` to HTTPS in the
  developer's browser for a year — a genuinely painful self-inflicted foot-gun.

- **Middleware now matches every route (5.3).** The old matcher listed only the authenticated prefixes, so `curl -I
/templates/...` returned **no security headers at all**: the middleware never ran. A login page without a CSP is still
  an XSS target, and the public surfaces are exactly where an attacker would aim. `_next/static`, the favicon and the
  manifest are excluded — immutable assets where a CSP nonce is meaningless. Note the matcher must stay a **static
  literal**: Next.js reads `config.matcher` at build time and silently ignores a computed array.

- **Live CSP verification (`npm run verify:csp`).** `scripts/verify-csp-live.mts` boots the production server and asserts
  what no unit test can: that public surfaces carry the headers, that the nonce in the served CSP is present in the served
  HTML _from the same response_, and that the JSON-LD hash is **quoted** in `script-src`. The quoting check exists because
  a bare `sha256-…` token renders unquoted and browsers ignore it — silently killing structured data on the template pages.

- **Storage limitation — a real retention sweeper (5.3).** Consent and erasure were implemented, but **nothing deleted
  anything on its own**, so an account that never logged in again kept its error reports, search log, delivery logs and
  expired auth tokens forever. `lib/server/retention.ts` declares eight policies with a stated `basis` for each, runs
  daily from the scheduler tick, and isolates failures per policy. Each policy is an idempotent `deleteMany`, so several
  replicas racing is harmless.

  `Activity` and `ConsentRecord` are **deliberately never swept**: the first is the statutory audit trail for a firm doing
  books, the second is the proof of what a user consented to. A generic "delete old rows" pass would quietly destroy the
  compliance record this product exists to produce. Asserted by test rather than left to convention.

- **Real data portability (5.3).** The DPDP right to access returned _metadata stubs_ — `{ id, name, rowCount }` for
  datasets, `{ id, title }` for notebooks. That is an index of the subject's data, not a copy of it: notebook cells, chat
  transcripts, report sections, DAX measures and analysis configs were all absent. `lib/server/portability.ts` exports 35
  sections covering every personal-data model, plus a manifest recording per-section row counts and any failures, so a
  subject can see what was included.

  **Credentials are withheld, and the withholding is disclosed** in the manifest. `passwordHash`, OTP/token hashes, the
  encrypted `Connector.config` blob (which decrypts to a live database password) and server filesystem paths are all
  excluded — a portability bundle is a file that gets emailed to a subject and lives in their Downloads folder forever.
  DPDP §11 is about data, not secrets.

- **Free trial (5.1).** The free tier and paid tiers existed but the gap between them was the conversion moment: a new
  user could never experience what they would be paying for. A new workspace now gets a 14-day Pro trial
  (`TRIAL_DAYS`-tunable) — share links, scheduled delivery and API keys, which is exactly what a consultant needs to feel
  the difference. Best-effort by design: a trial must never be able to fail a signup.

  A trial is modelled as a **paid entitlement on a timer**, with its own `Subscription.trialEndsAt` column rather than
  being inferred from `currentPeriodEnd`. The two look identical if you only have a period end, and they must be treated
  differently: a lapsed _trial_ stops granting Pro immediately, while a genuinely paid subscription whose period has
  slipped is still entitled — the payment rail, not a local clock read, decides whether money arrived. Reading the period
  end would downgrade paying customers every time a webhook lagged.

- **Internal links to the template landing pages (5.1).** The per-template SEO pages in `app/templates/[id]` existed to be
  found by search but were **orphaned** — nothing in the app linked to them, so they had no internal inbound links at all.
  The gallery now links to each one from both the collapsed and expanded card states.

- **Self-hosted error tracking (5.2).** No third-party analytics and no Sentry — a hosted tracker sees every stack frame,
  every URL (including `/apps/<shareToken>` and `/embed/<token>`, which _are_ the share capability) and every user's data
  shape. `lib/server/error-tracking.ts` captures errors in-app instead: emails, bearer tokens, query-string secrets, cuids
  and UUIDs are redacted **at capture**, paths are stored without query strings, and reports are grouped by a fingerprint
  so 10,000 distinct errors collapse into a handful of rows. `ErrorReport` + `Feedback` models, `/api/errors` and
  `/api/feedback` APIs (rate-limited), `components/error-reporter.tsx` and `components/feedback-button.tsx`.

- **Privacy & compliance documentation (`docs/privacy-and-compliance.md`).** Records of processing (GDPR Art. 30), lawful
  basis per data category, the retention schedule with justifications, data-subject rights mapping to code, a copy-paste
  nginx configuration for HTTPS termination — and an explicit "honest gaps" section listing what is _not_ covered.

### Fixed (Phase 5)

- **The portability export leaked every tenant's data (5.3).** Every workspace-scoped section was originally
  `where: workspaceId ? { workspaceId } : {}`, and an empty Prisma `where` means **every row in the table**. A user
  without a personal workspace therefore received every dataset, analysis, report and notebook in the entire
  installation — on an endpoint that is authenticated, meant to look trustworthy, and exactly what an attacker would try.
  Replaced with `wsScope()`, which matches nothing in that case. The regression test was verified to fail without the fix.

- **The billing panel told a trial user they were subscribed, and hid the upgrade.** During a trial the "current plan" is
  Pro, which marked the Pro card `Current` and removed every purchase button — leaving a user on an expiring trial with no
  way to convert. Trials now render an `On trial` badge and keep the purchase actions.

### Removed (Phase 5)

- **`exportUserData()`.** The stub export had no callers left once `buildPortabilityBundle` took over. Two competing
  export paths is how a compliance control quietly stops being one.

### Changed

- **The analyst toolkit now ships enabled by default (Phase 3.1).** The default deployment profile is now `pro`,
  so SQL Lab, the notebook, what-if, training, advisor, connectors, scheduled reports, prompts and LLM-backed
  features are unfrozen on a cold install instead of hidden behind default-OFF flags. `LEDGERLY_PROFILE=core`
  restores the minimal core flow; per-module flags still force an individual module on for surgical control, and
  SSO/team-collaboration stay opt-in (org/IT decisions). Gated by `__tests__/unit/modules-profile.test.ts`.

- **Scheduler activation now follows the deployment profile.** `maybeStartScheduler()` and the `/api/health`
  scheduler status use `moduleEnabled("SCHEDULER_ENABLED")` instead of the raw env read, so a profile-unfrozen
  scheduler actually starts its poller (and a frozen one stays off) — matching the nav and the API gate.

### Fixed

- **ECharts (~1 MB) was on the critical path of both public viewer routes.** `components/pbi/power-bi-studio-panel.tsx`
  already lazy-loaded `PbiVisual` through `next/dynamic`, but `components/dashboards/published-view.tsx` and
  `components/dashboards/dashboard-builder.tsx` imported it eagerly — and `pbi-visual.tsx` does
  `import * as echarts`. Every viewer of a shared dashboard therefore downloaded the whole ECharts runtime on first
  paint, for a dashboard that may contain no chart at all. `published-view.tsx` is what renders `/apps/[shareToken]`
  and `/embed/[token]`, the routes a client's customers actually hit:

  | Route                    | Before | After  |
  | ------------------------ | ------ | ------ |
  | `/apps/[shareToken]`     | 549 kB | 159 kB |
  | `/embed/[token]`         | 539 kB | 150 kB |
  | `/(app)/dashboards/[id]` | 597 kB | 217 kB |

  The bundle-budget ratchet did not catch this because those routes were already under a stale baseline.
  `__tests__/unit/bundle-heavy-imports.test.ts` now enforces it structurally: it computes the modules reachable from
  a dynamic entry point (following static _and_ dynamic imports) and the modules reachable from any `app/` route
  following static imports only, and asserts no heavy runtime is in both.

- **Postgres connections were effectively unmanaged.** `lib/db.ts` passed only a connect timeout and the SSL flag,
  inheriting every other default. Added env-tunable `max`, `idleTimeoutMillis`, `keepAlive` (so a proxy in front of
  the DB cannot drop a connection about to be reused) and `statement_timeout` (so a runaway analytics query cannot
  hold a pooled connection forever). The pre-existing `ssl: { rejectUnauthorized }` behaviour is unchanged.

- **`@tanstack/react-query` was a declared dependency with no provider anywhere**, so the caching it was meant to
  provide did not exist: `api()` hardcoded `cache: "no-store"`, nothing was ever reused, and two components asking
  for the same GET issued two round trips. `lib/client/query-cache.ts` closes that gap without a provider tree:
  TTL freshness, in-flight request de-duplication, stale-while-revalidate, and a bounded store. It is opt-in
  (`apiCached`) so anything the user is editing keeps using `api()`, and `apiMutate()` invalidates on write — a
  mutation that does not invalidate is the one way this cache could show a wrong number. A failed request is never
  cached, and a failing _background_ revalidation is explicitly handled (it would otherwise be an unhandled
  promise rejection, which crashes a Node process).

- **Five authenticated pages were never covered by the auth middleware.** `middleware.ts` kept
  `PROTECTED_PREFIXES` and `config.matcher` as two independent hand-maintained lists, and they had drifted:
  `/connectors`, `/copilot`, `/growth`, `/published-notebook` and `/scheduled-notebooks` existed as
  authenticated pages but appeared in neither, so the middleware never ran for them. `/connectors` was the
  worst case — it had NO page-level guard either, so it relied entirely on a prefix it was not in. All five are
  now in both lists and `/connectors` calls `requirePageAuth()` like its siblings.
  `__tests__/unit/middleware-coverage.test.ts` (39 tests) enumerates every `app/(app)` page, asserts each is
  covered by a protected prefix, asserts the two lists agree, and asserts no protected page lacks its own
  page-level guard. The matcher must stay a static literal — Next.js reads it at build time and silently ignores
  a computed array — which is exactly why the lists drifted, so the test now enforces the agreement instead.

- **`/api/llm/validate` was reachable by anonymous callers.** The route parsed and evaluated attacker-supplied
  source server-side with no auth guard and no rate limit. It now requires a session and draws from a
  per-user `llm_validate` bucket.

- **Four expensive operations were unmetered.** `/api/upload` (parse + write to disk + materialize a dataset)
  had no limit at all — the `upload` bucket existed but was only ever charged by `/api/sample-data`.
  `/api/connectors/[id]/import` (opens a warehouse connection, streams rows, builds a dataset) and
  `/api/connectors/[id]/test` (opens a live outbound connection to a Postgres/Snowflake/BigQuery host — a free
  third-party request amplifier) are now capped by `connector_import` / `connector_test`. The public API-key
  surface previously trusted the per-key limit, which is operator-configurable and can be set arbitrarily high;
  `validateApiKey` now also applies an instance-wide `public_api` ceiling, and the cheaper of the two wins.

- **Four route handlers threw unhandled errors.** `/api/appearance` (a malformed body produced Next's generic
  500 HTML that the client's `api()` helper could not parse), `/api/auth/logout` (a DB hiccup while recording
  the sign-out audit event blocked the user from clearing their session), `/api/docs` and
  `/api/public/openapi.json`. All four now return the standard JSON error envelope via `toErrorResponse`.
  `/api/appearance` also derived its accent enum from `ACCENTS` instead of hardcoding a parallel list with a
  redundant re-validation branch.

- **Frozen modules were cosmetic — the flags never actually refused anything.** `requireModule()` in
  `lib/server/modules.ts` was exported, documented and unit-tested, but **no route imported it**: under
  `LEDGERLY_PROFILE=core` the nav correctly hid Advisor / Prompts / Notebooks, yet `/api/advisor`, `/api/prompts`
  and every `/api/notebooks/*` route still served requests, so the 503 an operator was told to expect never fired.
  Every route for those modules now calls `requireModule(...)` as its first statement — before `requireAuth()`, so
  the check cannot leak resource existence: SQL Lab (`/api/datasets/[id]/query`, `/materialize`, and the
  API-key public surface `/api/public/v1/datasets/[id]/sql`), What-if (`/whatif` plus both Python exports),
  Advisor, Prompts (CRUD), all 12 notebook routes and all 4 scheduled-notebook routes.
  `__tests__/unit/module-api-gates.test.ts` (9 tests) calls the real handlers and asserts the 503
  `MODULE_DISABLED` actually comes back, that the default `pro` profile does _not_ 503, and that a per-module
  flag still re-opens one module while leaving its neighbours frozen.

- **`sqlLabEnabled` and `whatifEnabled` were computed but never read.** The dataset sub-nav rendered "SQL lab" and
  "What-if" unconditionally, so the two flags controlled nothing at all. Those tabs are now built from
  `moduleEnabled()`; the `/query` and `/whatif` pages return 404 when frozen (so a bookmarked URL is not a back
  door and a frozen profile cannot be probed for which datasets exist), and the Advisor, Prompt Library and
  Notebooks pages do the same. The project hub's "Notebooks" tab hides with the module and falls back to Overview
  when `?tab=notebook` is deep-linked, and a published notebook's public `/apps/<token>` snapshot 404s too —
  freezing the module must not leave a live public share of it behind.

- **Production build was failing on the SAML authorize route.** `app/api/auth/saml/authorize/route.ts` exported a
  non-route constant (`SAML_SP_ENTITY_ID`), which Next.js rejects as "not a valid Route export field". The export
  had no consumers and is removed.

### Added

- **An explicit HTTP cache policy** (`lib/server/cache-control.ts`). The default is
  `private, no-store, max-age=0` for every authenticated response — this is multi-tenant and almost every endpoint
  returns another customer's data. The single exception is published artifacts (`/api/apps/[shareToken]`), which
  are addressed by an unguessable share token and are public _by design_: `max-age=0` keeps browsers revalidating
  while `s-maxage=60` lets a CDN absorb a burst of viewers, so unpublishing stays responsive. Previously every
  viewer of a shared dashboard hit the database.

- **Phase 4 decision record (`docs/performance-and-scale.md`).** Covers the four areas and, more usefully, the
  decisions that look like omissions but are deliberate — notably why there is no ISR anywhere: ISR caches at the
  URL, not per user, so applying it to `/dashboard` or `/datasets/[id]` would serve one customer's workspace shell
  to the next requester. That is a cross-tenant leak, not a performance win. It also records that the schema is
  already well indexed (41 of 45 models; the 4 without indexes are singletons/lookup tables), that
  `CREATE INDEX CONCURRENTLY` is required for Postgres index migrations, and the pool sizing rule
  (`DATABASE_POOL_MAX × replicas < max_connections`).

- **Route-level loading states with shape-accurate skeletons.** Only `app/(app)/loading.tsx` existed, so every
  navigation showed the same generic block. Added `loading.tsx` for the slowest routes — dataset overview and
  detail, the project hub, audit log, models, reports and notifications — backed by two new primitives,
  `TableSkeleton` (header + row grid matching an arriving table) and `GallerySkeleton` (1/2/3-column card grid
  that reflows at the same breakpoints as the real one). A placeholder that matches the final layout removes the
  perceived jump when the real rows land.

- **An accessibility gate that runs in the fast unit suite.** The only axe scan was
  `__tests__/e2e/a11y.spec.ts`, which needs a browser, a running server and a real signup — so it is slow and
  runs in the e2e job only. `__tests__/components/a11y-axe.test.tsx` scans the shared primitives every page
  composes (Button, ButtonLink, DataTable, the raw table primitives, ErrorMessage, the loading skeletons,
  EmptyState, Card) under jsdom + axe-core with the same rule as the e2e gate: no critical or serious
  violations. It also asserts the semantics the axe rules depend on — icon-only buttons expose an accessible
  name, the error state carries `role="alert"`, skeletons announce `aria-busy`, and the data table is _named_.
  `color-contrast` is disabled there (jsdom loads no CSS custom properties, so every element measures 1:1) and
  stays enabled in the real-browser gate.

- **API integration coverage for the MLOps surface (`__tests__/api/mlops.test.ts`).** The full browser journey
  against a real Next.js server: signup → onboard → upload → advanced-engine training through the REAL worker
  thread (the server process has no jest env) with a client-generated `runId`, the SSE progress stream read to
  its `done` terminal event (cv → refit → importance phases asserted), `/predict` recovering the linear truth
  within ridge shrinkage, `/explain` attributions reconstructing `prediction ≈ base + Σφ` < 1e-6 with `units`
  outranking the constant `price`, and 400 VALIDATION on incomplete feature rows. The API harness gains
  `TRAINING_ENABLED=true` (the repo `.env` ships false) and an `API_TEST_EXTERNAL_SERVER=1` mode for sandboxes
  where a jest-spawned detached server is reaped by the process supervisor — documented for CI debugging.

- **Live training progress in the UI — the last client gap is closed.** The training dialog subscribes to the
  SSE progress stream (`runId` generated client-side, EventSource opened BEFORE the POST so no early fold
  events are missed) and renders a phase-aware bar (cross-validating → refitting → importance) with exact
  done/total counts while the worker trains; the stream closes on done/error/unmount. Two real integration
  bugs found and fixed on the way: `api()` already unwraps the `{ ok, data }` envelope (the serving dialog
  read `.data` twice — predictions never rendered), and the SSE route now WAITS up to 8s for a
  late-registered run instead of fatal-404ing an EventSource that connected before the POST landed (a race
  that killed the bar every time). Wiring contract pinned in `__tests__/unit/training-progress.test.ts`.

- **Worker-thread training + live SSE progress — the event-loop and no-progress gaps are closed.**
  - **Thread offload** (`lib/engine/training-worker.ts` + `training-worker-entry.ts`): the fit runs in a
    `worker_threads` Worker — the engine module is bundled once per process to a standalone CJS file with the
    locally-installed esbuild (regenerated when the source is newer), executed on a single unref'd long-lived
    thread, and returns the full `MlTrainResult` over postMessage. Inline fallback when workers are unavailable;
    jest deliberately runs inline (esbuild's service deadlocks inside jest's worker pool) while the REAL thread
    mechanics are CI-verified by `npm run verify:worker` — a plain-node script proving bundle → spawn → progress
    forwarding → byte-identical result, error propagation and clean termination (`__tests__/unit/training-progress.test.ts`
    pins the same equivalence inline).
  - **Progress callbacks in the engine**: `trainWithCv(source, req, onProgress)` reports every completed fold,
    the refit, and every importance feature (`cv → refit → importance`, exact totals) — the same callback fires
    inline and in the worker. A no-watchdog silent hang is impossible: `runTraining` fails loudly if a run
    reports no progress within its timeout (default 120s), and retrying is safe (pure function).
  - **Live progress stream** (`lib/server/training-progress.ts` + `GET /api/training/progress?runId=…`): SSE
    with history replay on connect (a mid-run subscriber sees completed folds), `done`/`error` terminal events,
    abort-safe cleanup and TTL eviction — the training POST stays the source of truth for the result.

- **Scale wave: histogram tree learning + unbiased reservoir sampling + serving UI — the last boundaries are advanced.**
  - **Histogram tree learning** (LightGBM-style): decision-tree / random-forest / gradient-boosting dispatch to an
    exact dense splitter below 2,000 rows (byte-identical to the historical behaviour) and to a histogram
    splitter above it — per-feature quantile bins (exact midpoints when distinct values fit 32 bins, seeded
    quantile cuts over a 20k-cap subsample otherwise), per-node Σy/Σy² bin aggregates, and prefix-scan gain via
    `SSE = Σy² − (Σy)²/n` (one O(B) scan per feature instead of a double row scan). Artifacts/predictors/Shapley
    are unchanged downstream — same TreeNode format. 7 oracles (`__tests__/unit/scale-upgrades.test.ts`):
    step-function recovery at 6,000 rows, dense-path byte-identity, forest+boosting determinism at scale.
  - **Unbiased training samples**: `loadParsedDatasetSampled` streams a SEEDED reservoir (Vitter 1985, Algorithm
    R) over the WHOLE NDJSON file instead of the head — every row has probability k/n of inclusion regardless of
    position, so capped datasets no longer train on file-order-biased data. The training route stamps the
    honest label (`Trained on a seeded uniform sample of X of Y rows`) into the model card's demoNote + params.
    Oracle: statistical uniformity across stream positions (400 trials, both ends within 2 points of k/n).
  - **Serving UI**: the models tab gains Predict / Explain dialogs driven by the model card's feature list —
    predictions render with class-probability bars; explanations render ranked signed Shapley bars with the
    reconstruction-error provenance line. The browser face of `/api/models/:id/predict` and `/explain`.

- **MLOps wave: model serving + Shapley explanations — the "no serving endpoint / no SHAP" limits are closed.**
  - **Model serving** (`lib/engine/predictor.ts`, `POST /api/models/[id]/predict`): any aerolexa.ml.v1 artifact
    reconstructs into an EXACT runnable predictor — the served answer equals what the trained model computes,
    because the route replays the train-fitted preprocessor (median impute → one-hot with train-fitted levels,
    unseen levels all-zeros à la `handle_unknown='ignore'` → train-fitted standardization) and the stored
    parameters for every algorithm (ridge, logistic/softmax, trees, forests, boosting incl. OvR, kNN, MLP
    tensors). Training now embeds the raw payload on the card (`artifactPayload`), so artifacts are
    self-sufficient. Session or public-API-key auth, VIEWER role, 60 req/min rate limit, audited.
  - **Shapley attributions** (`lib/engine/shapley.ts`, `POST /api/models/[id]/explain`): permutation Shapley
    sampling (Strumbelj & Kononenko 2014 — the SHAP library's `permutation` estimator) over ANY black box, with
    a REAL-data background (caller-supplied rows or RLS-filtered rows sampled from the training dataset),
    seeded determinism, and the additive guarantee RETURNED, not assumed: `prediction ≈ baseValue + Σφ` with
    the reconstruction error in every response. Oracles pin the hand-computed φ for additive functions
    (φᵢ = slopeᵢ·(xᵢ − E[xᵢ])), the symmetric interaction case (both φ = 11.875 on the (6,6) fixture),
    seed-determinism, per-algorithm serving exactness and the end-to-end explain path. 8 tests
    (`__tests__/unit/mlops-serving.test.ts`).

- **ROADMAP 7.4 closed — mobile touch cross-filtering on dashboards.** The static 360 px viewport contract
  (`__tests__/e2e/mobile.spec.ts`) and the device-lab matrix already shipped; the missing piece was the FULL
  interactive journey: `__tests__/e2e/mobile-crossfilter.spec.ts` signs up, uploads a real CSV, creates a
  dashboard, seeds a real chart, and on a 360×740 `hasTouch` context TAPS a category chip → the "Filtered by"
  chip bar appears → Clear un-filters → zero horizontal overflow. Runs opt-in via
  `npm run test:e2e:device-lab` (`DEVICE_LAB=1`). With this, every Phase 7 item (7.1–7.5) is shipped: the digest
  (7.3) and the en/hi/ur + RTL i18n scaffold (7.5) were already in — the roadmap table now says so.

- **MLP neural network upgraded to the modern deep-learning recipe — and the XOR bug fixed.**
  - **The binary MLP never trained**: the head layer was sized with the CLASS COUNT under a sigmoid head, so the
    single-output delta left a dead second logit whose gradient was `undefined` — every binary MLP run produced
    NaN weights silently (multiclass softmax and regression identity heads aligned, so nothing else NaN'd). The
    new `__tests__/unit/mlp-upgrade.test.ts` XOR oracle pins the fix: the MLP now solves XOR (OOF AUC = 1) where
    the logistic baseline provably fails (linear models cannot separate XOR; the separable MLE degenerates and
    held-out AUC lands below the no-skill 0.5).
  - **Architecture**: 1 tanh hidden layer → **2 ReLU hidden layers** with exact **He-uniform initialization**
    (±√(6/fan_in), He et al. 2015). Full-batch Adam → **mini-batch AdamW** (Loshchilov & Hutter 2019): decoupled
    weight decay on weight matrices only (biases never decay), bias-corrected moments.
  - **Schedule + stability**: constant LR → **linear warmup + cosine decay** over the total step budget; added
    **global-norm gradient clipping at 5.0** (Pascanu et al. 2013). Early stopping now uses a RELATIVE min-delta
    (1e-6·best; the old absolute 1e-7 stopped regression runs prematurely) and the **best parameters are
    snapshotted and RESTORED** before returning, not merely frozen.
  - **New hyperparameters** (`MlTrainRequest`): `weightDecay` (default 1e-4), `batchSize` (default 32),
    `hiddenUnits` (default 32/layer), `epochs` (default 200) — all serialized on the model card, all plumbed
    through `/api/training` and the AutoML-lite grid (MLP joins the candidate pool as the interaction-capable
    dark horse). The artifact format grows `mlp.layers[ℓ][out][in]` + `mlp.biases[ℓ][out]` (aerolexa.ml.v1).
  - **Stochastic gradient boosting** (Friedman 2002): `subsample < 1` fits each tree on a seeded no-replacement
    row fraction; `subsample = 1` (the default) preserves the historical byte-for-byte deterministic full-batch
    fit. The Newton leaf refinement receives the subsampled TARGET vector so logit-boost leaves stay exact.
  - 10 oracle tests: XOR vs the failing linear baseline, parabola regression ≪ the linear baseline, concentric
    rings through the softmax head, seed-determinism down to the weight tensors, artifact shape, weight decay
    shrinks L2 mass, early-stop keeps runs snappy, and the three stochastic-boosting contracts.

- **Tier B/C capability wave — the honest mid-tier gaps are closed, with oracle tests.**
  - **AutoML-lite** (`lib/engine/automl.ts`): deterministic grid search over algorithm × hyperparameter configurations
    (ridge λ-grid, logistic, tree depth/leaf grids, forest/boosting sizes, kNN k) scored on IDENTICAL stratified CV
    folds (paired comparison — no fold lottery); winner selected by out-of-fold metric with ties toward simpler
    models, then refit through `trainWithCv` for the full artifact/importance/methodology result. A visible
    leaderboard shows every candidate's score. 9 tests (`__tests__/unit/automl.test.ts`) pin determinism,
    leaderboard ordering, linear-truth ⇒ ridge wins, non-linear truth ⇒ the linear baseline loses, the candidate
    cap and the honest tiny-dataset error.
  - **Theta forecasting** (`lib/engine/forecast.ts`): the standard Θ decomposition (Assimakopoulos & Nikolopoulos
    2000, closed-form LS trend + damped curvature line) joins the ETS/ARIMA candidate pool and competes on the same
    AICc + walk-forward-MAE contest; oracle suite extended to pin Theta(2) projecting a pure ramp with MAE < 1e-6.
  - **Placebo/falsification diagnostics for causal designs** (`lib/engine/elite-causal.ts`): `placeboDid` re-runs
    the 2×2 DiD one period BEFORE treatment — a credible design's placebo is ≈ 0 and smaller than the real
    estimate; a significant or same-size placebo fails loudly with a PASS/FAIL verdict and honest no-SD handling.
    4 hand-computed tests added to `__tests__/unit/elite-causal.test.ts`.
  - **DAX coverage wave** (`lib/engine/dax.ts`): `FIRSTDATE`/`LASTDATE`, the `STARTOFMONTH/QUARTER/YEAR` +
    `ENDOFMONTH/QUARTER/YEAR` boundary family (single-date sets that bind through CALCULATE like real DAX),
    `ISEMPTY` and `CONTAINS`; all in `SUPPORTED_DAX_FUNCTIONS` for autocomplete. 8 oracle tests
    (`__tests__/unit/dax-coverage.test.ts`) hand-computed from the standard fixture table.
  - **Hybrid semantic search** (`lib/chat/semantic-search.ts`): the chat copilot's retrieval upgrades from
    keyword-only to BM25 ⊕ TF-IDF-cosine fusion (0.6/0.4, max-normalized) — Okapi BM25 keeps identifier exactness
    ("churn_v3"), the vector half adds subtoken-aware cosine ("churn data" ↔ "churn_data.csv"). Deterministic
    LSA-style embeddings via block power-iteration SVD (no RNG, fixed start, Gram–Schmidt re-orthonormalization);
    degenerate corpora degrade honestly. Wired into the chat route via `hybridRetrieveFacts`; 12 tests
    (`__tests__/unit/semantic-search.test.ts`).
  - **Multi-filter composition in the notebook copilot** (`lib/engine/python/nl-to-pandas.ts`): up to 3 AND-ed
    predicates now chain into consecutive masks (f_df → f_df2 → f_df3) with the core aggregation reading the final
    frame; a 4th predicate fails honestly instead of being silently dropped. 3 new tests.

### Fixed

- **Notebook copilot: deterministic NL→pandas filter masks generated invalid Python.** `extractFilter`
  (`lib/engine/python/nl-to-pandas.ts`) built masks with the operator NAME (`eq`, `gt`) instead of the Python
  symbol (`==`, `>`), so "rows where region is East" produced `df["region"] eq "East"` — a `SyntaxError` at kernel
  execution. Additionally, filter values were captured with `[^,;\n]+`, truncating thousands-separated numbers:
  "revenue above 1,000" produced `> 1`. Masks now use the real Python operator, values keep internal commas, and
  clause-boundary splits only fire on a comma followed by whitespace ("East, sum of revenue" still splits; "1,000"
  survives). 6 previously failing tests in `__tests__/unit/nl-to-pandas.test.ts` now pass; full suite is green
  (147 suites / 1,678 tests, 0 failures) and `tsc --noEmit` is clean.

### Added

- **Grounded data answers — the copilot now answers "why / where" from real engines (ROADMAP 6.2 + 6.3).** Two new
  tools in the agent's registry (`lib/copilot/tools.ts`), both running the SAME deterministic engines as the
  AI-visuals route over the request's RLS-filtered rows:
  - `explain_key_influencers` — which categorical values raise/lower a boolean outcome's likelihood, with observed
    proportions, Wilson 95% intervals, lift versus the base rate and sample-size strength labels. The outcome
    column's real base rate and each influencer line become citable facts; near-unique (id-like) columns are
    skipped with the reason in the digest.
  - `build_decomposition_tree` — decompose a measure along up to 4 slice levels; children ranked by contribution
    contrast against siblings, with the total, top-level splits and the biggest branch's second-level drill
    returned as citable facts. Optional deterministic `filters` are applied before building.
  - Both tools are dispatched through `executeTool`, reject unknown columns with the real column list, and never
    throw — failures come back as `{ ok: false }` so the agent can correct itself.
  - Golden eval suite (`__tests__/unit/copilot-grounded-eval.test.ts`): 11 hand-computed fixtures pin the base rate
    (4/12 → 33.3%), group likelihoods (rep Bob 3/6 → 50.0%, lift 1.50×), decomposition totals (1470; East 420 /
    West 680 / North 370; filtered product-A total 1060), the analyzeColumns/minCount argument handling and
    engine-parity with the AI-visuals route (same numbers from both surfaces). The tool-registry test now pins the
    full 7-tool vocabulary.

- **Notebook SQL→Python handoff + reactive parameter plan (ROADMAP 4.1 + the server half of 4.3).**
  `lib/engine/notebook-handoff.ts` (pure, dependency-free, 19 unit tests in `__tests__/unit/notebook-handoff.test.ts`):
  - **SQL→Python handoff:** every ran, named tabular cell (`outputVariable`; sql-result, table and
    conditional-table outputs) becomes a `df_<name>` pandas DataFrame in the server Python worker — the same
    extras payload `worker-bootstrap.js` already materializes. Names are sanitized to legal Python identifiers
    (illegal chars → `_`, leading digit → `v` prefix, reserved `df`/`__` rejected); rows are capped at 20,000 with
    an honest truncation note appended to the cell's title; duplicate names are last-write-wins, matching Python
    assignment semantics. The run route collects the notebook's handable cells and passes them to `runServerPython`.
  - **Reactive re-run plan:** the run route response now carries `rerunCellIds` — the ordered ids of every runnable
    cell transitively downstream of a changed widget (output-variable `$var` refs, `{{variable}}` tokens and
    explicit dependencies, in deterministic document order via `downstreamOf`). Requesting `reactive: true` gets
    the plan for any cell; widget runs include it automatically. The client-side executor that consumes the plan
    is the remaining (UI) half.

### Changed

- **Cohort retention graduates to "Calculated" — the last prototype label is gone.** The engine's method (first-seen
  cohort assignment, offset-month retention, distinct-entity counting) is exact set logic over real dataset rows —
  deterministic, order-invariant, no heuristics — so it was provable all along; it just had no proof. That proof now
  exists: `__tests__/unit/cohort-oracle.test.ts` pins six hand-computed fixtures (exact per-cell percentages, M0=100%
  by definition, size-weighted average M1, earliest-month assignment under out-of-order rows, row-shuffle invariance,
  the last-12-cohorts window and the ≥2-month input requirement). README and the settings AI panel updated: no
  analysis in the product carries the "Prototype / Demo" badge today.
- **Settings AI panel honesty pass:** the "what runs on prototype logic" list still claimed DSL, what-if, forecast
  and advisor were prototype-grade — all four had already graduated with oracle suites. The section now states the
  current truth: every analysis engine is deterministic and oracle-pinned, and the live-ML roadmap line is updated.

### Fixed

- **`npm test` now works on a fresh local clone.** The jest global setup exports the repo `.env` as a FALLBACK for
  any variable not already set (CI's explicit `DATABASE_URL`/`AUTH_SECRET` still win). Before this, running the unit
  suite locally without exported env vars failed unrelated suites (e.g. mail-transport) with "Invalid server
  environment configuration" — the CI-only contract worked, the one-command local bar didn't.
- **Data-alerts / embed typecheck errors** (pre-existing from the data-alerts wave): `alert.dataset.updatedAt` was
  read without being selected, and both modules read the non-server `NEXT_PUBLIC_APP_URL` off `serverEnv()` — both
  now use the existing `appUrl()` helper (`tsc --noEmit` clean).

### Added

- **API-keys management UI (the missing half of the public API).** The backend has been complete — issue/list
  (`/api/auth/api-keys`), regenerate/revoke (`/api/auth/api-keys/[keyId]`), bcrypt-hashed storage, scoped
  permissions, per-key rate limits — but there was no surface to drive it, so keys could not be created from the
  product. Settings gains an "API keys" tab (between Security and Notifications) with the keys table (name, prefix,
  scope badges, last-used, expiry, active/expired/revoked status), a create dialog (name + scope checkboxes with
  descriptions + rate limit + optional expiry), the one-time secret display with copy-to-clipboard and the
  treat-it-like-a-password warning, and confirm-guarded regenerate/revoke actions. Free-plan workspaces see the
  server's 402 PLAN_UPGRADE_REQUIRED message verbatim in the create form — the entitlement gate stays the single
  source of truth.

- **Notebook DSL and Business Advisor graduate from "Prototype / Demo" to "Calculated" — earned, not relabelled.**
  - **DSL now delegates to the oracle-validated primitives** (`lib/engine/notebook-dsl.ts`): `%describe` reports R-type-7 linear-interpolation quantiles (the NumPy/SciPy default — the old floor() picker returned wrong quartiles on even-sized samples: Q1 980 → 1,010, median 1,200 → 1,150, Q3 1,350 → 1,312.5 on the six-row fixture) and sample stddev (ddof=1, matching `np.std`: 264.001 vs the population 240.999 it previously printed); `%corr` delegates to `stats.pearson`, gaining the exact Student-t p-value via the regularized incomplete beta (the same statistic `scipy.stats.pearsonr` reports — previously r-only, no significance); `%histogram` median/stddev use the same validated primitives. The evidence: `__tests__/unit/notebook-dsl-graduation.test.ts` (15 hand-computed known answers pinning the output strings, the ddof contract and the pearsonr degenerate-stack behavior).
  - **Advisor badge flips to Calculated** (`components/advisor/advisor-panel.tsx`): the engine's diagnostics were already oracle-backed (Mann–Kendall, Welch t via `studentTPValue`, HHI, 1.5×IQR outlier exposure, rolling-origin backtests — all over `stats.ts` primitives pinned by `advisor-engine.test.ts` and the SciPy reference suite), so the honest label was overdue. The panel now shows the green "Calculated" badge with an accurate methodology line; the prompts panel and notebook kernel notes updated to match.
  - README labelling statements and the landing-page trust section updated: Prototype / Demo now covers cohort only.

### Added

- **Growth surfaces shipped: funnel dashboard, SEO landing pages, and the hosted-deploy runbook.**
  - **In-app Growth Funnel dashboard** (`/growth`, sidebar + ⌘K): the weekly cohort table (signups → activated → collaborated → paid) rendered from `weeklyFunnel()` with stage totals across the 12-week window, the activation-verdict badge (excellent ≥ 60% / healthy ≥ 40% / fix-onboarding), the exact stage definitions, and the plan's rule of thumb inline. OWNER/ADMIN-only — other roles get an explicit no-access card, matching the API guard.
  - **Per-template SEO landing pages** (`app/templates/[id]/page.tsx`, statically generated from the catalog): every template gets a real indexed page — breadcrumb, level label, "what you need" slot table, the exact SQL/DAX/DSL steps with HowTo structured data (JSON-LD, `<` escaped), the deliverable, the honesty section (SciPy/NumPy oracle validation), and related templates in the same pack. Plus `app/sitemap.ts` (marketing routes + all template pages, auth-gated surfaces deliberately excluded) and `app/robots.ts` (index `/`+`/templates/*`, disallow `/api/`, `/apps/*` and app-shell routes; sitemap referenced).
  - **Hosted cloud VPS runbook** (`docs/deploy-hosted-vps.md`): from bare Ubuntu 24.04 to a paying customer in ~45 minutes — Node 20 + Postgres 16 + Caddy auto-TLS, the complete production `.env` (Razorpay live keys, SMTP as a launch dependency, `AEROLEXA_PROFILE=pro`, scheduler + job worker + digest on, `TRUST_PROXY_HOPS=1`), a hardened systemd unit with `ExecStartPre=prisma migrate deploy` and memory guardrails, backup cron + off-box copy + the `drill:backup` gate, a Razorpay test-mode-first payment sanity flow, the go-live checklist, and an explicit "what NOT to do" list.

- **Growth engine (GTM phases 1–3): the acquisition surface, the wedge, and the measurement loop.**
  - **Template catalog for the CA-firm wedge** (`lib/engine/template-catalog.ts` + rewritten `/templates`): complete runnable recipes — GST reconciliation (monthly tax register + nil-invoice exceptions + net-payable DAX), GST rate-slab sanity, Tally trial balance with one-sided-entry check, bank-statement cash-flow with top counterparties, journal-entry risk screen (round amounts + weekend postings + Benford eyeball), and the starter monthly-KPI board. Each template carries a slot contract (user maps their columns), read-only SQL/DAX/DSL steps, SEO keywords, and the artifact to build; the catalog is unit-gated so a template with undeclared/unused slots, non-read-only SQL, or a vanished pack fails CI. The /templates page renders packs (GST / Tally / Bank / Audit / Getting started) with search, per-step copy, and the notebook quick-commands preserved.
  - **Landing page sells the wedge with the real plan matrix**: use cases now lead with "For CA firms — GST reconciliation in hours, not days"; pricing shows the actual entitlements (Free ₹0 = everything computed, nothing distributed · Pro ₹999 = share links, scheduling, connectors, API keys · Firm ₹4,999 = unlimited seats, engagements, RLS, OIDC SSO) with the honesty line "plans gate capacity and distribution — never computed results". Root metadata keywords now target the vertical (gst reconciliation tool, tally data analysis, ca firm software…).
  - **Growth funnel engine** (`lib/server/growth-funnel.ts` + `GET /api/growth/funnel`): the weekly signup → activated (uploaded AND ran an analysis) → collaborated (member added or public link) → paid (active non-free subscription) cohort table, computed entirely from the Activity trail the app already records. Rates are null (never 0) when a denominator is zero — "no data" is distinguishable from "nobody converted"; demo accounts excluded; cohort attribution is by signup week; the activation verdict applies the GTM plan's 40%-fix-onboarding threshold. Operator-only (OWNER/ADMIN).

- **Plan entitlements — the monetization gate.** `lib/server/entitlements.ts` enforces what the plan catalog previously only promised: Free gates distribution/capacity (no public share links, no external connectors, no scheduled reports, no API keys, no scheduled-notebook publishing, no org seats), Pro unlocks all distribution but stays owner-only on org seats, Firm is unlimited. One hard rule inherited from the repo's trust bar: **plans gate capacity and distribution, never computed results** — a free user's EDA numbers are exactly as computed as a Firm user's. Enforcement points: the three publish routes (`publicShareLinks`), connector creation (`externalConnectors`), scheduled-report creation (`scheduledReports`), API-key creation (`apiKeys` + a per-plan active-key cap), org invites (`requireOrgSeatAvailable`, owner excluded from the count; the plan is the org owner's subscription). Operators can grandfather customers without a deploy via `PLAN_OVERRIDES={"pro":{"maxOrgSeats":50}}`. Rejections are `402 PLAN_UPGRADE_REQUIRED` with an upgrade remedy. Oracle tests in `__tests__/unit/entitlements.test.ts` (plan matrix pinned, override wins, owner-excluded seat math, free-tier API-key block).
- **Generic OIDC SSO (ROADMAP 8 unblocked).** `lib/auth/oidc.ts` + `app/api/auth/oidc/{authorize,callback}/route.ts` turn any standards-compliant IdP (Okta, Auth0, Azure AD/Entra, Keycloak, Google) into an SSO option from three env vars (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). Discovery is validated (HTTPS in prod, endpoint presence, issuer mix-up protection per OIDC Core §3.1.3.7); the flow uses state + PKCE S256; the callback provisions/links accounts by verified email exactly like the NextAuth bridge and mints the standard `aerolexa.session` cookie. Every failure mode returns a readable remedy on `/login?ssoError=…`, never a dead end. Oracle tests in `__tests__/unit/oidc.test.ts` (discovery parsing, mix-up rejection, RFC 7636 known-answer PKCE vector, authorize-URL contract).
- **Public API execution endpoints (ROADMAP 5.6 extension).** Three new API-key-authenticated routes on `/api/public/v1`: `GET /datasets/{id}/rows` (typed rows, RLS-filtered, `?version=` snapshots), `POST /datasets/{id}/sql` (read-only SELECT on the DuckDB engine with caps and exact totals), `POST /datasets/{id}/dax` (measure evaluation with real filter-context semantics, incl. `byCategory` series). All three flow through the shared RLS chokepoint — a restricted viewer's API key sees exactly the rows their UI sees — and the OpenAPI spec (+ Swagger UI at `/api/docs`) documents them with schemas.
- **Durable scheduling is now the default execution path when the job worker is on.** The scheduler tick (`tick()`) and `runDueConnectorSyncs()` enqueue through the `JobQueue` (idempotency keys stable per schedule/watermark — a retried tick can never double-execute) instead of running inline, so a worker killed mid-run loses nothing: restart completes it (the ROADMAP 5.4 definition of done). Inline execution remains when `JOB_WORKER_ENABLED` is unset, so existing single-instance deployments behave exactly as before.
- **Tenancy test honesty fix:** the org-admin suite now seeds a Firm subscription for the org owner — org invites are a Firm capability and the new seat gate correctly refuses invites on a default Free workspace.

- **Provider-scoped migration history — fresh Postgres installs work without `db push`.** `prisma/migrations-sqlite/` (the existing 21 incremental migrations) and `prisma/migrations-postgres/` (one idempotent whole-schema baseline generated by `prisma migrate diff` from the real schema) ship in the repo; `npm run switch:postgres` / `switch:sqlite` now install the matching set into `prisma/migrations/` (with a dirty-workspace guard that refuses to clobber a hand-maintained history) before regenerating the client. `prisma migrate deploy` therefore works for BOTH providers out of the box — the blessed docker path, the API scratch DB and the backup drill all run the same command. Proven live: a fresh Postgres 16 container reached 43 tables through `migrate deploy` alone. The migration-contract tests now pin both sets' locks, the sqlite set's 21 migrations, the baseline's idempotency, and table-coverage parity between the sets (drift fails CI); the backup drill upgraded from `db push --accept-data-loss` to the real `migrate deploy`.

- **Notifications digest (ROADMAP 7.3)** — `lib/server/notify-digest.ts` + `DIGEST_ENABLED=true` starts a background loop (same pattern as the scheduler: env-gated, idempotent, `.unref()`'d) that bundles each user's unread notifications into ONE periodic email — scheduled-report outcomes, connector errors, analysis alerts — instead of a per-event inbox storm. It reads the exact rows the in-app bell shows (single source of truth; type preferences are already enforced by `notify()`), caps the bundle at 25 entries with an explicit "… and N more" overflow line (never silently dropped), marks rows read with a conditional `readAt: null` update so a concurrent in-app read always wins, and delivers through the configured mail transport (console in dev) with per-user best-effort semantics — a transport failure is recorded, never fatal. 12 unit tests: pure render/format oracles plus source-gated wiring contracts. Contract note: @-mentions do not exist yet in the product, so they are not claimed here — the digest ships the two real event sources.

- **Power BI parity wave (round 5): slicers + report-grade formatting.**
  - **Real slicer widget (ROADMAP 2.1/3.3 complement)** — the decorative "filter" widget is replaced by a working Power BI slicer: a new widget type carrying the REAL distinct values of one dashboard column (derived from the chart/table/PBI-visual snapshots already on the canvas — `lib/engine/slicer.ts`, pure and serializable, never invented). List and dropdown styles, single- vs multi-select, click-to-toggle semantics, per-slicer contribution projected into the existing cross-filter selection set (composes with tile clicks; empty selection filters nothing). Saved slicer state survives reload via the dashboard's saved cross-filters and stale values are dropped, never silently re-applied. The published dashboard view renders the saved slicer state read-only and applies saved filters to every tile through the same `applyCrossFilters` engine. 18 hand-computed oracle tests in `__tests__/unit/slicer.test.ts`.
  - **Report-grade formatting (ROADMAP 3.4, honest subset)** — per-widget `format` (`VisualFormat`): always-on data labels, a dashed horizontal reference line (value + optional label + color) and a palette override, honored by the ECharts suite for the cartesian kinds (waterfall, pareto, ribbon, boxplot) where the renderer can actually draw them — never a silently-ignored control.

- **Power BI parity wave (round 4): DAX depth, cross-filtering, drill-through, RLS.**
  - **DAX engine expansion (39 → 90 functions)** — `lib/engine/dax.ts` gains the constructs real Power BI measures are written with: `VAR name = expr … RETURN` (sequential evaluation, nested scoping/shadowing, eager per-context binding), the `IN { … }` operator (scalar membership AND a CALCULATE filter over `[Column] IN { … }`), inline `{ … }` literal tables, `CALCULATETABLE` (evaluates the table expression in the modified filter context), `TOPN` (numeric-aware ordering with DAX tie-inclusive boundary semantics), `TREATAS` (literal or column tables applied as filters on other columns), `LOOKUPVALUE` (multi-pair search + alternate result), the statistics family (`MEDIAN`, `PRODUCT`, `COUNTBLANK`, `STDEV.P/S`, `VAR.P/S`), maths (`ROUNDUP/DOWN`, `TRUNC`, `INT`, `MOD` with divisor sign, `SIGN`, `FLOOR`/`CEILING` significance, `SQRT`, `POWER`, `EXP`, `LN`, `LOG`, `PI`), text (`LEN`, `LEFT/RIGHT/MID`, `UPPER/LOWER/TRIM`, `CONCATENATE(X)`, `SUBSTITUTE` with instance number, `CONTAINSSTRING`), logic (`XOR`, `COALESCE`, `ISNUMBER/ISTEXT/ISLOGICAL`) and time intelligence (`NEXTDAY/MONTH/QUARTER/YEAR`, `DATESBETWEEN`, `DATESINPERIOD`). Every family is pinned by hand-computed oracle tests in `__tests__/unit/dax-extensions.test.ts` (44 new tests; the pre-existing 17 still pass unchanged).
  - **Dashboard cross-filtering (ROADMAP 3.3)** — `lib/engine/cross-filter.ts` (pure, serializable): clicking a tile's category value filters every OTHER chart/table/PBI-visual tile (source tile stays unfiltered, Power BI semantics; toggle re-click clears, multi-select across clicks, AND across columns, tables filter rows by column label). Selections persist in the dashboard JSON (`widget.crossFilters`) and survive reload via the builder's "Save filters" action; a "Filtered by" chip bar lists active selections with a one-click clear. 22 oracle tests in `__tests__/unit/cross-filter.test.ts`.
  - **Drill-through (ROADMAP 3.5)** — shift-click a tile's value opens a detail dialog built by `buildDrillThrough`: table widgets return their matching real rows; chart/PBI widgets return the honest per-series breakdown for the clicked category (no fabricated row-level data), with sampled provenance when capped.
  - **Row-level security end-to-end (ROADMAP 2.5)** — declarative rules (role → dataset column ∈ allowed values) stored in `Workspace.settings`; `lib/server/rls.ts` resolves the caller's filters and enforces them fail-closed (a rule referencing a dropped column yields 0 rows, never full access) at the three choke points every visual/query path flows through: `loadDatasetFrame` (DAX studio, AI visuals, measures), `runQueryOnDatasets` (SQL Lab, pivots, materialize) and `GET /api/datasets/[id]/rows` (in-browser DuckDB + client refresh). Restricted results are always labelled with an RLS provenance note. OWNER-only management UI in Settings → Security (validation against real dataset columns), rule changes audited as `RLS_RULES_UPDATED`. 10 oracle tests in `__tests__/unit/rls-server.test.ts`.

- **Elite-analytics gaps closed (round 3).**
  - **Real time-series forecast (Gap ①)** — the heuristic forecast is replaced by a statistical engine (`lib/engine/forecast.ts`): the ETS family (SES, Holt, damped Holt, Holt-Winters with additive seasonality) plus ARIMA(p,d,q) via conditional least squares, scored by bias-corrected AICc on the exact Gaussian likelihood with a walk-forward one-step MAE tie-breaker. 95% prediction intervals use the residual σ with the model class's multi-step variance weights; Ljung–Box residual diagnostics are surfaced as quality warnings. Oracle-gated: hand-computed properties (ramp continuation, seasonal recovery, AR(1) coefficient recovery, interval widening, determinism) always run; a live statsmodels comparison runs when the project `.venv` exists (`__tests__/unit/forecast-oracle.test.ts`). The forecast analysis graduates from "Prototype / Demo" to "Calculated".
  - **Multi-table semantic layer (Gap ②)** — `lib/engine/semantic-model.ts`: relationships with many-to-one cardinality validation (duplicate-key errors, orphan-row warnings), RELATED() row propagation, CALCULATE-style measures with dimension filters evaluated row-by-row (e.g. `SUM[Amount] where RELATED(DimCustomer[Segment]) = "VIP"`), a generated date dimension with fiscal year/quarter + ISO week attributes, and RLS row filters applied before every measure. Hand-computed star-schema oracle tests (`__tests__/unit/semantic-model.test.ts`).
  - **Dashboard visual picker (Gap ③)** — all ten Power BI–style visual kinds (waterfall, funnel, sankey, treemap, sunburst, gauge, heatmap, boxplot, ribbon, pareto) become dashboard tiles via a pure spec builder (`lib/engine/visual-picker.ts`, hand-computed expectations in `__tests__/unit/visual-picker.test.ts`); the widget canvas renders them through the existing ECharts suite, and the "Add widget" dialog gains a "Power BI visuals" category with kind selection.
  - **Audit CSV export (Gap ④)** — `GET /api/audit/export` (same scope/actor/type filters as the listing, 5,000-row cap) via a paranoid RFC-4180 serializer with CSV-formula-injection guarding (`lib/engine/audit-csv.ts`); "Export CSV" button in Settings → Audit log.
  - **Filled maps (Gap ⑤)** — real Leaflet choropleths (`components/charts/choropleth-map.tsx`): a pure engine (`lib/engine/geo.ts`) normalizes region names (diacritics, punctuation, aliases like USA/UK/UAE), classifies values by quantile or equal interval on a 5-step teal ramp, and joins them onto **bundled** GeoJSON boundaries (`/geo/us-states.json`, Natural Earth 110m `/geo/countries.json` — no tile server, no external requests). Unmatched features render as no-data gray and unmatched values are reported in the caption — never silently dropped. Available as an 11th "Filled map" kind in the dashboard visual picker and on published dashboards; the Leaflet bundle is dynamic-imported so map-free pages never pay for it. Hand-computed oracle tests in `__tests__/unit/geo.test.ts`.

- **Remaining professional gaps closed (round 2).**
  - **Per-step editors (Gap ⑤)** — every step in the Power Query studio is now click-to-edit via a data-driven schema (`lib/engine/powerquery-editors.ts`): column dropdowns populate from the dataset's real columns, filter ops/aggregation functions/type coercions are constrained selects, group-by aggregation rows are add/remove-editable, and value fields keep numeric text numeric so comparisons stay typed. Every patch re-runs the live preview through the real engine server-side. Adding a new engine step kind needs only a new STEP_EDITORS entry — no bespoke dialog code.
  - **Auto-apply on re-upload (Gap ⑥)** — `lib/server/transform-apply.ts` re-runs a dataset's saved pipeline over fresh rows after a CSV/XLSX replace, so the live dataset stays TRANSFORMED, not raw. Failure (renamed/dropped column) keeps the raw rows and reports the exact engine error in the response, activity trail and version provenance (`transformApplied`, `transformSteps`, `transformSkippedReason`).
  - **Watermark sync for every engine (Gap ⑦)** — MongoDB pulls incrementally through a native `{ col: { $gt } }` filter (`buildWatermarkMongoFilter`, $-key injection rejected, ISO strings become real Dates); Snowflake/BigQuery render the floor into query text ONLY through `buildWatermarkSqlText`'s strict gate — finite numbers or strict ISO-8601 regex matches, everything else returns null and the sync falls back to a full pull. The orchestrator's engine set is now all five watermark engines.

- **Professional-analyst gaps closed (round 1)** — four changes aimed at the working analyst evaluating Ledgerly cold:
  - **Deployment profiles (Gap ①)** — `AEROLEXA_PROFILE=pro|all|core` (default `core`) unfreezes the whole analyst toolkit (SQL Lab, notebook, what-if, connectors, scheduler, training, advisor, prompts) in one switch; `pro` deliberately keeps SSO/collaboration frozen (org/IT decisions). Per-module flags and the legacy `AEROLEXA_ENABLED_MODULES` list keep precedence. Gated by `__tests__/unit/modules-profile.test.ts`.
  - **Power Query studio UI (Gap ②)** — `/datasets/[id]/transform`: applied-steps list (add/remove/reorder) over the existing 20-step `lib/engine/powerquery.ts` engine, live before→after preview with row counts, and **saved pipelines** on the new `Dataset.transformSteps` JSON column (`POST /api/datasets/[id]/transform/save` validates with the real engine before persisting — a saved pipeline is always executable).
  - **XLSX export (Gap ③)** — `GET /api/datasets/[id]/export/xlsx` writes a real multi-sheet workbook (Data + Profile + Quality + Provenance) with an honest `sampled` provenance row when the export is capped; workbook shape pinned by `__tests__/unit/xlsx-export.test.ts`.
  - **Incremental connector sync (Gap ④, watermark)** — configure a watermark column (`POST /api/connectors/[id]/watermark`) on Postgres/MySQL datasets; subsequent syncs pull only rows past the floor via **parameterized, engine-quoted SQL** (`lib/engine/connectors/watermark.ts`, tested) and append with a strict schema-signature gate. Schema drift, non-parameterized engines, or corrupt watermark JSON all fall back to a full pull — incremental sync never silently produces a partial dataset.

- **Out-of-the-box AI copilot configuration.** Setting `LLM_API_KEY` alone now activates a hosted OpenAI-compatible model (defaults: `https://api.openai.com/v1` + `gpt-4o-mini`) — no base-URL/model juggling required. New `LLM_PROVIDER` (`openai` | `ollama`) makes the family choice explicit, and `LLM_DEFAULT_MODEL` swaps models without code. Resolution logic is centralized in `resolveLLMConfig()` (`lib/llm/providers.ts`) and unit-gated by `__tests__/unit/llm-config.test.ts`.
- **`GET /api/llm/status`** reports — honestly and without leaking the key — which model is configured, whether it is reachable right now, and an actionable remedy when it is not. The copilot UI (`components/chat/chat-interface.tsx`) shows a setup banner with that hint whenever no live model is answering, instead of silently degrading; the model picker is now always visible and marks offline options. `npm run dev` prints the one-variable setup hint when no key is set.

## [0.6.1] - 2026-09-21

### Fixed

- **`lib/server/billing.ts` — the manual-payment/webhook activation path was broken**: `activateSubscriptionOps()` was sync but contained an `await` in its `where` clause (the code never compiled through CI). Now async, resolved before building the transaction ops; all three call sites updated.
- **`lib/auth/phone-otp.ts`** strict-mode undefined indexing in `generateCode()`.
- **`lib/engine/connectors`** strict-mode fixes across `gst.ts` (an undefined `itemObj` reference — a latent runtime crash — plus un-narrowed unknowns and date parts), `tally.ts` (`readFileSync` was called on `node:fs/promises`; duplicate type re-export), `bank-statement.ts` (un-narrowed date parts, `patterns` typing) and `config.ts` (`referenceColumn` hint added to `bankStatementConfigSchema`).
- **`app/layout.tsx` + `lib/i18n.ts` split:** `next/headers` (cookies) moved to `lib/i18n-server.ts` — client components importing the shared dictionary dragged a server-only import into the client bundle and **failed the production build**; the split restores both worlds through one dictionary.
- **`__tests__/unit/pwa-offline.test.ts`** regex false-negative against the (correct) service-worker guard.
- **`__tests__/unit/copilot-eval/copilot-eval.test.ts`**: `MetricValue` imported from its real module (`@/lib/analytics/semantic-layer`), `computedAt` added to fixtures, churn-rate golden pair corrected to the honest EDA-fallback expectation, `expectedIntents` made optional.
- **`__tests__/unit/tenancy-isolation.test.ts`**: user fixture updated for the phone-OTP schema fields; org-member returns cast at the boundary.
- **`__tests__/e2e/scene.spec.ts` flat-tier budget spec**: heap was asserted against a page-global metric (`performance.memory`) that can never read 0 — the spec now asserts the scene-scoped honesty contract (zero canvases ⇒ zero draw calls) and logs page heap without failing on it.

### Added

- **3D realism program pendings closed** (all tracks S0→S10 now implemented; see `docs/3d-ui.md` 0.4.0):
  - `lib/scene/performance-budgets.ts` (S2.3 draw-call/heap budgets) gains its unit gate `__tests__/unit/scene-performance-budgets.test.ts` — constants pinned (100/250 studio, 40/150 depth, 0 flat) and the assert/read helpers' fail-closed contracts gated.
  - `lib/scene/viewer-tier.ts` (S10) quality half gains its unit gate `__tests__/unit/scene-viewer-quality.test.ts` — `getViewerQuality` per-tier knob mapping, iOS Safari honesty clamps (transmission off, instances ≤ 256, clamp never raises), and `auditViewerMemory`'s honest null outside a Chromium heap.
  - **RTL-safe what-if scene (S10):** `charts/3d/whatif.tsx` mirrors the before→after pair (and delta arrow) on X under `dir="rtl"`, matching the decomposition-tree and key-influencers scenes so reading order follows the document direction.
  - Scene track now **13 unit suites / 118 tests**, all green.
- **CI `scene-gates` job records screenshot baselines on first run** (`--update-snapshots=missing`): absent baselines are created, existing ones are never silently overwritten — an intentional re-baseline is a deliberate PR.
- **First measured performance-budget numbers** (production build, headless chromium/swiftshader, 2026-09-21): studio 1/100 draw calls · 16.3/250 MB; depth 37/40 · 14.5/150 MB; flat 0 draw calls; viewer memory audit 18.4/250 MB — all within budget, logged in `docs/quality-baseline.md`.

### Changed

- `docs/3d-ui.md` rewritten as an audited status board (0.4.0): all pendings either verified-implemented (AI-visual 3D, what-if crossover, WebGL backdrop, viewer-tier verification, device-lab, stills/Lighthouse tooling) or explicitly listed as execution-only work (fps floors on real hardware, screenshot baselines on first CI run, device-lab numbers).
- `docs/quality-baseline.md` scoreboard extended (budget gates, AI-visual/what-if oracles, viewer parity, iOS clamps) and its fps/budget logs populated with the first real measured run — including the honest fps-floor failure on the shared-CPU dev sandbox.

## [0.6.0] - 2026-09-20

### Added

- **Phone/OTP auth (Band 3.1)**: `PhoneOtp` model + migration; `lib/auth/phone-otp.ts` (6-digit codes, bcrypt-hashed at rest, 5-minute TTL, ≤5 attempts, atomic single-use consumption, 1/min + 5/hour per-phone send budget). Routes `/api/auth/phone/request` + `/verify` (login) and `/api/me/phone` + `/verify` (link a verified number in Settings). Login screen gains a "Phone OTP" tab. Delivery is pluggable: console transport by default, real WhatsApp Business Cloud API template hook when `WHATSAPP_ENABLED=true` + credentials are set. `__tests__/unit/phone-otp.test.ts` covers the brute-force/security contract.
- **PWA offline shell (Band 3.4)**: installable app (`public/manifest.json`, maskable + any SVG icons), service worker (`public/sw.js`) that precaches the offline shell, serves navigations network-first with an `/offline` fallback, and cache-first for content-hashed static assets. **`/api` responses are never cached** — offline never shows stale numbers as fresh. Registered production-only via `ServiceWorkerRegistrar` in the root layout. `__tests__/unit/pwa-offline.test.ts` gates the cache-honesty contract.
- **Monetization (Band 4.2)**: `Plan`/`Subscription`/`Invoice`/`WebhookEvent` models + migration (amounts in integer paise, never floats); `lib/server/billing.ts` with two honestly-labelled rails — Razorpay (server-created order, HMAC-verified client callback + raw-body-verified webhook, idempotent event ledger) and manual offline transfer (invoice flips to `paid` only when an operator records the payment reference). Routes `/api/billing/{plans,checkout,verify,webhook,manual}`; Billing tab in Settings with plan cards and checkout/bank-transfer actions; plans seeded idempotently. No plan gates any engine — billing never changes computed results. `__tests__/unit/billing.test.ts`.
- `docs/band-status.md` — the full band checklist audited against the codebase with file-level evidence (19 of 23 items were already implemented; this release closes the remaining 4).

### Changed

- **Brand unification (1.5)**: every `AURELIA`/`aurelia` remnant renamed to Ledgerly across code, tests, docs, scripts, Docker, CI and env flags (`AEROLEXA_ENABLED_MODULES`, `AEROLEXA_TEST_PYTHON`, `AEROLEXA_STORAGE`, `aerolexa.session` cookie, `__aerolexa_total` DuckDB column, `aerolexa:tier` override, `demo@aerolexa.local`); stale `demo@vertex.local`/`vertex.db`/`vertex:tier` references fixed. The package was already `Ledgerly`; the codebase now matches.

## [0.4.0] - 2026-09-20

### Added

- **Tenancy migration (Engagement model)**: `Engagement` model (org-scoped client/entity with code/GSTIN/status), `Project.engagementId`, one-org-per-user bootstrap via `Organization` + `OrganizationMember` rows; migration `20260920150000_add_engagement` applied.
- Org/engagement admin service (`lib/server/organization.ts`) and API routes (`app/api/organization/**`): create/update firm identity, invite/manage members (ADMIN/MEMBER/AUDITOR, owner-protected remover), create/update/archive engagements (each auto-creates a Project).
- Organization settings UI (`components/settings/organization-panel.tsx`) wired to a new "Organization" tab.
- Org-aware Postgres RLS (`prisma/rls.sql`) keyed off `app.current_user` / `app.current_workspace` / `app.current_organization`, applied via `withTenantContext()` (`lib/server/tenancy.ts`) when `RLS_ENABLED=true` on the Postgres profile.

### Changed

- **Org-aware access control**: `requireRowRole` / `requireProjectRole` / `artifactRole` now delegate to org-aware resolvers (`lib/server/members.ts`), so every existing artifact route enforces organization membership (org-rank mapped to PNG roles) — not just workspace ownership.
- All 35 `assertWorkspaceAccess` gate sites across 23 routes replaced with org-aware row-role checks (datasets, analyses, dashboards, reports, insights, presentations, projects, models, advisor, studio, scheduled-notebooks, versioning/export paths). `assertWorkspaceAccess` is retained as the explicit workspace-only check for non-org code.
- Fixed a stale Prisma mock in the semantic-layer unit suite (`prisma.customMetric.findMany` was missing).

## [0.3.1] - 2026-09-20

### Added

- 3D realism program pendings from `docs/3d-ui.md`:
  - **Scroll-driven camera dolly + DoF focus pull** on the hero (S4.1): pure scroll math oracle (`lib/scene/scroll.ts`, hand-computed tests); dolly integrated **into the shared CameraRig** so one rig owns the camera (dolly pose + pointer parallax composed, reduced-motion safe); DoF tracks a rig-steered world-space focus target
  - **Idle-deferred hero canvas mount** (S4.2): `lib/scene/defer.ts` — `requestIdleCallback` with a timeout cap plus cancellable fallback, so LCP is untouched; contract-tested
  - **ContactShadows** mounted by SceneCanvas for every scene (tier-scaled 512/256, theme-tuned), with a `contactShadowsY` override for raised grounds (ambient plinth) (S2.1)
  - **SoftShadows (PCSS) on studio tier** + shadow-receiving floor (`SceneShadowCatcher`); the key directional light now consumes `quality.shadowMapSize` (2048) (S2.2)
  - **N8AO** ambient-occlusion pass fills the canonical `ao` slot of the post stack (S2.3)
  - **3D heatmap registered in the chart dispatcher** (`supports3D()` + `LiveChart3D` routing) (S5.1)
  - Scene-track suites: scroll oracle (8 tests), idle-defer contract (4), dispatcher (4), motion-adoption source gate (1)

### Changed

- **Motion-token sweep across DOM components** (S6): KPI cards use `SPRING.soft` + `staggerDelay(index)` (was inline `{stiffness: 120, damping: 16}` + `index * 0.06`); hero preview uses `SPRING.heavy` — identical physics, one vocabulary; guarded by `motion-adoption.test.ts` failing on any inline `stiffness:` in `components/`
- EffectComposer no longer mounts a separate normal pass — N8AO handles its own depth/normals
- Hero mounts its canvas with the `marketing` flag so the DoF pass is actually live on studio
- Hero skyline, KPI bars and ambient slabs now `castShadow` so the studio shadow path has geometry to project

## [0.3.0] - 2026-09-20

### Added

- 3D realism system per `docs/3d-realism-master-plan.md` (milestones S0–S8):
  - Scene quality layer (`lib/scene/quality.ts`): per-tier post stack, shadow maps, env resolution, instance budgets, dpr clamps; strictly-downward runtime downgrade with telemetry
  - Motion tokens (`lib/scene/motion.ts`) shared by DOM and scene animation
  - Physical material library (`lib/scene/materials.ts`): dataGlass, brushedMetal, softTouch, lightEdge — cached instances, studio-gated transmission, procedural brushed roughness
  - Asset-free IBL environment (`lib/scene/environment.ts`): procedural studio-room PMREM, theme-tinted, tier-scaled; mounted once in SceneCanvas
  - Post stack module (`components/scene/postfx.tsx`) in canonical order (bloom → smaa → dof → ao → vignette → grain), tier-gated
  - Camera parallax rig (`components/scene/camera-rig.tsx`), reduced-motion safe
  - Ambient 3D set for auth/onboarding (`components/scene/ambient-scene.tsx`, wired into AuthShell)
  - 3D heatmap physicalization from computed ChartSpecs (`lib/scene/heatmap.ts` + `components/charts/3d/heatmap3d.tsx`) with hand-computed oracle tests
  - Instanced scatter rendering (one draw call per series group)
  - Scene honesty e2e specs: flat-tier zero canvases, localStorage tier override (`aerolexa:tier`), fps floor sampling
  - Bundle budget gate wired into `npm run build` (300 kB first-load per route)
  - Quality scoreboard: `docs/quality-baseline.md`

### Changed

- SceneCanvas: ACES filmic tone mapping + pinned sRGB output; PerformanceMonitor-driven runtime downgrade; IBL + parallax mounted for all scenes
- Three-ecosystem dependency versions pinned exact (three, @react-three/fiber, drei, postprocessing)
- 3D chart bars/points/donut slices and hero skyline now use the shared material library (env-lit, cached)
- Hero skyline generation is seeded-deterministic (screenshot-diffable)
- KPI skyline bars animate toward computed values on data change (mount and update)
- Auth shell renders the shared ambient scene behind the card (self-gating on tier)

### Fixed

- Tenancy resolution (`artifactRoleWithOrg`): the org-membership path never ran when the caller had no ProjectMember row (orgId was only read from that include) — org MEMBER/AUDITOR got `null` instead of their mapped role; legacy same-workspace ownership now precedes org mapping per the module's own "rule 3 = OWNER" contract
- Tenancy test cleanup used invalid Prisma filters (`workspace.deleteMany({ userId })`) and throw-on-missing deletes; replaced with relation filters / `deleteMany`
- Prisma schema: removed a duplicated `ActivityActor` back-relation that made `prisma generate` (and therefore `build`/`postinstall`) fail for every checkout; completed the pending Organization/Engagement tenancy relations (`Project.organizationId`, `Activity.organizationId`, `Organization.ownerId`)
- Added the missing `20260920140000_organization_tenancy` migration — schema and migrations verified in sync via `prisma migrate diff` (empty diff)
- Fixed the AUDITOR role gap: `team-tab.tsx` role descriptions now cover the `AUDITOR` ProjectRole; org-role mapping keeps its type import
- `next.config.mjs`: removed `swcMinify`/`instrumentationHook` (dead in Next 15), moved `serverComponentsExternalPackages` → `serverExternalPackages`, pinned `outputFileTracingRoot` to the app dir (multi-lockfile warning), removed duplicate bundle-analyzer import
- `playwright.config.ts`: removed the hardcoded machine-specific `webServer.cwd` that broke every other checkout
- Waterfall visual: restored the exact helper-series math for negative bars and removed only the truly dead bindings (repo now lints with 0 errors and 0 warnings)

## [0.1.2] - 2026-09-10

### Added

- CRDT cursor/presence collaboration (Phase 1)
- On-demand package loading via Next.js config
- Docker deployment configuration
- Optional SQL server connection switching

### Changed

- Updated package versions and dependencies
- Improved TypeScript type definitions

### Fixed

- Fixed triple-quote syntax errors in Python export scripts
- Resolved notebook versioning conflicts

---

## [0.1.1] - 2026-09-10

### Added

- Embedded AI copilot notebook features (Phase 3 preview)
- Shareable URL publishing system
- Publish/unpublish functionality for notebooks

### Changed

- Refactored notebook collaboration state management
- Updated Prisma schema for versioning support

### Fixed

- Fixed Python export code generation edge cases
- Improved audit log append-only behavior

---

## [0.1.0] - 2026-09-10

### Added

- Initial Ledgerly prototype release
- Data upload and profiling pipeline
- Notebook DSL engine with Pyodide execution
- SQL lab with DuckDB integration
- Dashboard and report builder
- Model training and what-if analysis
- Team collaboration and SSO

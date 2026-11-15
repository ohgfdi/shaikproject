# Ledgerly vs Hex — Full Analysis, Comparison & Gap-Closing Plan

_Status: written from a complete read of the repository (schema, migrations,
all API routes, engines, components, tests, scripts) plus Hex's official
product/docs. Implementation begins in the same session — see the "Plan"
section at the bottom._

---

## 1. What Ledgerly is (full analysis)

**Stack:** Next.js 14 (App Router, RSC) · React 18 · TypeScript (strict) ·
Prisma (SQLite dev / PostgreSQL via provider switch) · Tailwind + a custom
design system · ApexCharts · DuckDB-wasm + node worker · Pyodide ·
JWT sessions (jose) · Zod env validation. 324 tracked files, 44 test files
(Jest unit/component/API + Playwright e2e).

**Core loop (the product):** upload a CSV/XLSX → streaming parse + profile →
Analysis Lab (10 EDA kinds) → deterministic insights + Business Advisor →
dashboards, 12-section reports, 9-slide presentations → exports (PDF/HTML
shells, runnable Python scripts, .ipynb). Everything is deterministic and
labelled "Prototype / Demo" — a deliberate, documented product stance.

**Extended modules (all Gen-1, working):** notebook (DSL kernel +
optional Pyodide), SQL Lab on DuckDB (worker + wasm) with materialize,
prototype model trainer, what-if, external connectors (Postgres/Snowflake/
BigQuery/Sheets/REST) with sync + version snapshots, scheduled reports,
project roles + threaded comments, prompt library, catalog search, dataset &
analysis versioning with diffs, Python code export, audit/activity trail,
rate limiting, notification preferences.

**Architecture quality (genuinely good):**

- Single funnel for workspace isolation (`lib/auth/guard.ts` +
  `lib/server/members.ts` role resolution) — every route funnels through it.
- Versioning is real: immutable `DatasetVersion` NDJSON snapshots +
  `AnalysisVersion` metric extraction, not cosmetic.
- Activity/audit trail is append-only and surfaced in Settings.
- Design system docs, a11y, mobile-first, error/empty/loading states everywhere.
- The DuckDB/pyodide split and honest "how was this calculated" labelling is
  a defensible prototype strategy.

### ⚠️ Repository health: the app does not build as checked in

This is the single most important finding. `npm install` fails on
`postinstall → prisma generate` because the checked-in `prisma/schema.prisma`
is **invalid**: the `ExecutionSandbox` and `AuditEvent` models are never
closed (`}` missing) — Prisma cannot parse the file.

Beyond the syntax error, the schema describes a **second, aspirational data
model** (`Organization`, `AuditEvent`, `JobQueue`, `ScheduledJob`, `UserApiKey`,
`ExecutionSandbox`, `NotebookCell` rows…) that:

1. does **not** match the SQLite migrations (which build the _real_ model:
   `Workspace` (1:1 user), `Activity`, `ScheduledReport`, `ProjectMember`,
   `Notebook.cells` as a TEXT JSON blob, `DatasetVersion`…), and
2. does **not** match ~90% of the application code (every page, most API
   routes, `lib/server/activity.ts`, `versioning.ts`, `connector-sync.ts`,
   `members.ts`, `auth-service.ts`, `seed.ts`, and the test suite).

Concrete breakages found during analysis (all verified by reading the code):

| #   | File                                                                                            | Problem                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `prisma/schema.prisma`                                                                          | Invalid (unclosed models) → `prisma generate` fails → `npm install` fails.                                                                                                                                                                           |
| B2  | `prisma/schema.prisma`                                                                          | Wrong models vs migrations + code (Gen-2 vs Gen-1) → even a parseable version would not typecheck.                                                                                                                                                   |
| B3  | `instrumentation.ts`                                                                            | Imports `maybeStartScheduler` from `@/lib/server/scheduler` — **that export doesn't exist** (`scheduler.ts` exports `startScheduler`); `experimental.instrumentationHook` is also unset, so scheduled reports never run automatically.               |
| B4  | `lib/server/{scheduler,queue,runner,audit,auth,connectors/adapters,execution/sandbox,index}.ts` | Gen-2 dead cluster referencing non-existent models; reachable only via instrumentation (B3) + unit tests.                                                                                                                                            |
| B5  | `lib/server/rate-limit.ts`                                                                      | `recordApiKeyUsage` writes `prisma.userApiKey` — table doesn't exist (in-memory rate limiting works; only this fn is broken).                                                                                                                        |
| B6  | `components/notebook/copilot-hook.ts`                                                           | Syntactically broken fragment (uses `useCallback`/`setSuggestions`/`triggerLlm` with no definitions, no function declaration). Copilot is **not wired** into the editor anyway (plain `<textarea>`).                                                 |
| B7  | `components/notebook/notebook-input-widgets.tsx`                                                | All four widgets (`TextInput`, `SliderInput`, `DropdownSelect`, `DateRangePicker`) are stubs rendering `null`; `notebook-tab.tsx` builds `widgetComponent` but never renders it. "Add input widget" produces no UI.                                  |
| B8  | `app/api/notebooks/[id]/publish/route.ts`                                                       | Written against the Gen-2 schema (`include: { workspace }`, `cells?.cells`, `ctx.user.profileRole === "OWNER"` which is a free-text onboarding field, not a role) — broken against the real model; `publicUrl` points at a route that doesn't exist. |
| B9  | `app/api/datasets/[id]/replace/route.ts`                                                        | Calls `createDatasetVersion({ rowCount, columnCount, changeLog, … })` — those params don't exist on the function.                                                                                                                                    |

---

## 2. Hex, distilled (what Hex actually sells)

From Hex's own docs/product pages (Sept 2026):

1. **Notebooks** — SQL + Python + no-code + AI cells in one canvas, with
   cached intermediate results, data apps built from the notebook.
2. **Data Apps** — publish notebooks as interactive, parameterized apps
   (input controls bound to cells), with share links, embeds, and scheduled
   runs of the app.
3. **AI everywhere** — plain-language Q&A (Threads), Notebook Agent
   (AI-generated SQL/Python), AI app builder, evals; surfaced through the
   product, Slack, MCP, and a CLI.
4. **Context/semantic layer** — sync semantic models, dbt, warehouse
   metadata, markdown; Context Studio shows every step behind every answer.
5. **Collaboration** — concurrent editing, comments, sharing, permissions.
6. **Governance** — permissioning, lineage, audit, usage visibility.

---

## 3. Head-to-head: where Hex wins, where Ledgerly lags or is missing

Scored on what matters for the same buyer (analyst/exec workflows). 5 = Hex
class.

| Capability                                         | Hex   | Ledgerly today                                                  | Gap                                                                           |
| -------------------------------------------------- | ----- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Notebook canvas (code + markdown)                  | ★★★★★ | ★★★½ (DSL + Pyodide, cells persisted, versioned)                | No SQL cells, no no-code cells; editor is a plain textarea                    |
| **Interactive Data Apps (publish notebook → app)** | ★★★★★ | ★½ (widgets are stubs, publish route broken, no public page)    | **Biggest gap — scaffolded but non-functional**                               |
| AI-assisted analysis (NL → SQL/Python)             | ★★★★★ | ★½ (deterministic advisor is good; copilot is broken & unwired) | **Biggest gap #2 — code exists but doesn't compile/connect**                  |
| Scheduled runs of analyses/apps                    | ★★★★  | ★★★ (scheduled _reports_ only; poller never starts)             | Notebook/app scheduling missing + poller bug                                  |
| Semantic layer / shared context                    | ★★★★★ | ☆ (nothing — only a prompt library)                             | Missing entirely                                                              |
| Collaboration (roles, comments, presence)          | ★★★★  | ★★★ (roles + comments solid; no presence/realtime)              | Presence + realtime editing                                                   |
| Sharing & public links                             | ★★★★  | ★½ (publish flow broken; no public route)                       | Folded into Data Apps work                                                    |
| Governance / audit / lineage                       | ★★★★  | ★★★½ (audit + workspace RLS + role funnel are strong)           | Answer-level lineage (Context Studio) missing                                 |
| Dashboards / reports / presentations               | ★★★   | ★★★★ (genuinely featureful for a prototype)                     | Ledgerly _wins_ here on breadth for the money                                 |
| SQL Lab                                            | ★★★★  | ★★★★ (DuckDB worker + wasm, materialize)                        | Parity                                                                        |
| Versioning & reproducibility                       | ★★★★  | ★★★★ (dataset/analysis snapshots + Python export)               | Parity                                                                        |
| No-fake-data ethos & labelling                     | —     | ★★★★★ (deterministic, labelled, transparent)                    | Hex's AI is real; Ledgerly must stay honest about what's computed vs inferred |

**Where Ledgerly already wins:** breadth of executive artifacts (dashboards,
reports, presentations, exports), deterministic transparency/labelling,
versioning depth, and a genuinely complete auth/roles/audit story.

---

## 4. Implementation plan (what I'm building now)

Priorities chosen for (impact × feasibility × fit with the product's
deterministic, no-fake-AI ethos):

### Phase 0 — Restore a working build (prerequisite for everything)

1. Reconstruct `prisma/schema.prisma` from the migrations (Gen-1 model:
   `Workspace`, `Activity`, `ScheduledReport`, `ProjectMember`,
   `DatasetVersion`, `AnalysisVersion`, `NotebookVersion`, …). `npm install`
   and `prisma generate` pass.
2. Fix `instrumentation.ts` + write a real single-instance scheduler poller
   in `lib/server/scheduler.ts` (`maybeStartScheduler`), enable
   `experimental.instrumentationHook`; scheduled reports actually run.
3. Fix `rate-limit.ts` (`recordApiKeyUsage` without the missing table).
4. Reconcile the Gen-2 dead cluster: port the small, testable pieces
   (`audit.ts` → Activity-backed, `queue.ts` pure helpers + in-memory queue,
   `execution/sandbox.ts` → validation + in-memory registry), delete the
   truly dead modules (`index.ts`, `runner.ts`, `auth.ts`,
   `connectors/adapters.ts`).
5. Fix `copilot-hook.ts` (broken fragment) and the publish/replace routes.
6. `tsc --noEmit` → 0 errors; Jest unit + API suites green.

### Phase 1 — Close the two biggest Hex gaps

**F1. Interactive Notebook Apps (Hex "Data Apps").**

- Real input widgets (text, number/slider, dropdown, date range) rendered in
  the notebook, bound to named variables; code cells reference them via
  `{{variable}}` and re-run on change.
- Fix publish: `accessMode` + `shareToken` on the Notebook row (migration),
  owner-only public opt-in, copyable share URL, and a public
  `/apps/[token]` view (outputs from the published snapshot; interactive
  widgets for workspace members).

**F2. AI-assisted cell generation ("Notebook Agent"-lite, honest).**

- Rebuild the copilot hook + textarea (working autocomplete: DSL commands,
  columns, pandas methods) and wire it into the notebook editor.
- `/llm <request>` → `app/api/notebooks/[id]/ai` → deterministic NL→DSL
  translator (keyword/pattern matching over the real dataset schema),
  executes it, returns code + output + explanation, with an optional
  `LLM_API_KEY` hook (OpenAI-compatible) for live models when configured.
- Unit tests for the translator + widget variable substitution.

### Phase 2 — Next steps (documented, not built this session)

- **Semantic layer**: column descriptions/definitions + metric definitions
  surfaced in the advisor and notebooks (Hex's context engine analogue).
- **Notebook/app scheduling**: cron runs of a notebook → HTML snapshot +
  notification (extends the Phase-0 poller).
- **SQL cells in notebooks** (`%sql` cell backed by the existing DuckDB
  engine) and no-code chart cells.
- **Presence/realtime collaboration** (who's viewing, live cell cursors).
- **Lineage view**: "how was this answer produced" per artifact (Context
  Studio analogue) on top of the existing activity trail.

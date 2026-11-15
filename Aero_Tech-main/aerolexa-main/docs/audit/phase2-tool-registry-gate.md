# Gate 2 — Tool Registry and Agent Loop (READ tier only)

Status: **implemented, pending approval**. No commit has been made.
Date: 2026-10-22.

## Scope

Replace the low-quality assistant path with Claude constrained by a secure,
read-only tool layer over the existing accounting stores:

- 15 READ tools + one non-data `submit_answer` tool.
- Zod-strict inputs; the model can never supply user/workspace/organization/book/
  engagement identity.
- Every tool call re-checks tenant access and organization role; fails closed.
- Compact, capped, cursor-paginated outputs with `truncated` / `total`.
- PAN/GSTIN/bank/IFSC/phone redaction at the tool boundary.
- Deterministic grounding verifier; one correction retry; honest failure text.
- Append-only `AssistantRun` / `AssistantToolCall` audit and per-org switch.
- `POST /api/assistant` SSE streaming with auth, rate limits, idempotency,
  cancellation and a global kill switch.

No PROPOSE/EXECUTE tier exists. There are no write, filing, close, delete or
payment tools.

## Files changed

New tool/agent layer:

- `lib/ai/tools/types.ts` — tool contract + type-erased registry entry.
- `lib/ai/tools/schema.ts` — Zod→JSON-Schema projection, strict object helper.
- `lib/ai/format.ts` — integer-paise money + Indian FY helpers.
- `lib/ai/redact.ts` — tool-boundary identifier/phone scrubbing.
- `lib/ai/tools/books.ts` — `financial_statements`, `day_book`,
  `search_vouchers`, `voucher_detail`, `ledger_account_statement`.
- `lib/ai/tools/gst.ts` — `gst_invoices`,
  `gst_register_ledger_reconciliation`.
- `lib/ai/tools/operations.ts` — `inventory_summary`, `fixed_assets_summary`,
  `tds_summary`, `payroll_run_summary`, `bank_feed_status`,
  `period_lock_status`.
- `lib/ai/tools/practice.ts` — `list_books`, `engagement_status`.
- `lib/ai/tools/registry.ts` — 15 READ tools + `submit_answer`; forbidden
  identity-field list.
- `lib/ai/tools/executor.ts` — schema validation, READ-tier gate, per-call
  tenant/role re-check, typed errors, result ids, output hashes, audit.
- `lib/ai/verifier.ts` — deterministic number/date/FY/identifier grounding.
- `lib/ai/agent.ts` — bounded loop (tool cap, duplicates, wall/token/cost,
  cancellation, one correction retry).
- `lib/ai/audit.ts`, `lib/ai/settings.ts`, `lib/ai/prompt.ts`.

API:

- `app/api/assistant/route.ts` — streaming endpoint.
- `app/api/assistant/settings/route.ts` — per-org switch (OWNER/ADMIN).

Schema / config:

- `prisma/schema.prisma` — `AssistantRun`, `AssistantToolCall`,
  `AssistantOrganizationSetting`.
- `prisma/migrations/20261022000000_add_assistant/migration.sql` (active,
  SQLite) and mirrors in `prisma/migrations-sqlite/` and
  `prisma/migrations-postgres/`.
- `.env.example` — `ASSISTANT_*` block.
- `lib/env.ts` — assistant switches/limits/retention (shared file).
- `lib/server/retention.ts` — `assistant-runs` policy.
- `lib/server/book-tenancy.ts` — fail-closed org check (shared file).

Tests:

- `__tests__/unit/assistant-verifier.test.ts` (9 tests)
- `__tests__/unit/assistant-tools.test.ts` (12 tests)
- `__tests__/unit/assistant-agent.test.ts` (9 tests)
- `__tests__/unit/assistant-redaction.test.ts` (9 tests)

`lib/ai/provider.ts` is the concurrently-written Anthropic provider; Gate 2
reuses it rather than duplicating it.

## Commands and real output

Environment note: the working tree is shared with another active writer, so
`lib/ai/provider.ts` and `lib/env.ts` may change underneath this report.

### Typecheck

```
$ npx tsc --noEmit
TSC_EXIT=0
```

### Lint

```
$ npm run lint
> Ledgerly@0.6.1 lint
> eslint .

LINT_EXIT=0
```

### Focused assistant suites (SQLite scratch DB)

```
$ DATABASE_URL="file:/tmp/opencode/ledgerly-phase2-test.db" \
    npx jest --runInBand __tests__/unit/assistant-verifier.test.ts \
      __tests__/unit/assistant-tools.test.ts \
      __tests__/unit/assistant-agent.test.ts \
      __tests__/unit/assistant-redaction.test.ts

Test Suites: 4 passed, 4 total
Tests:       37 passed, 37 total
Time:        2.99 s
```

### Schema↔migration drift gate

```
$ DATABASE_URL="file:/tmp/opencode/ledgerly-phase2-test.db" \
    npx jest --runInBand __tests__/unit/schema-drift.test.ts
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

### Migration applies cleanly to an empty SQLite database

```
$ DATABASE_URL="file:/tmp/opencode/ledgerly-gate-mig.db" npx prisma migrate deploy
...
All migrations have been successfully applied.
EXIT=0
```

### Migration diff (required command)

```
$ DATABASE_URL="file:/tmp/opencode/ledgerly-phase2-verify.db" \
    npx prisma migrate diff --from-config-datasource \
    --to-schema prisma/schema.prisma --script
EXIT=0
```

The 54-line diff contains **no assistant tables** — the assistant migration
matches `prisma/schema.prisma`. The diff hunks that remain are pre-existing
HEAD drift unrelated to Phase 2:

```
DROP INDEX "Book_organizationId_idx";
DROP INDEX "PayrollRun_bookId_state_idx";
DROP INDEX "SubledgerPosting_bookId_sourceType_idx";
-- RedefineTables: BookVoucher (adds organizationId), CollaborativeUpdate
CREATE UNIQUE INDEX "SubledgerPosting_voucherId_key" ...
CREATE INDEX "SubledgerPosting_bookId_idx" ...
```

A fresh `prisma migrate deploy` therefore produces a database that is missing
`BookVoucher.organizationId` and the `SubledgerPosting` indexes; this is a
baseline defect, not introduced here.

### Real tool output over a seeded book (temporary smoke test, deleted after)

Seeded one SQLite book (Cash ₹500 debit / Revenue ₹500 credit, narration with a
PAN and phone), then ran the real executor:

```
SMOKE_STATEMENTS {"ok":true,"tier":"READ","data":{
  "trialBalance":{"totalDebit":{"paise":50000,"inr":"₹500.00"},
  "totalCredit":{"paise":50000,"inr":"₹500.00"},"balanced":true},
  "profitAndLoss":{"netProfit":{"paise":50000,"inr":"₹500.00"}}}}

SMOKE_DAYBOOK {"ok":true,"data":{"rows":[{"voucherId":"cmvisrojb0000mm9qd00hcijl",
  "voucherNumber":"V1","narration":"Cash sale to ABC Traders, PAN PAN •••• 234F,
  phone ••••••3210","debit":{"paise":50000,"inr":"₹500.00"}}]}}
```

This proves the wrapper returns integer paise with Indian-formatted strings,
preserves stable voucher ids, and redacts PAN/phone at the boundary.

### Full required Jest command (honest result)

```
$ DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable" \
    npx jest --runInBand

Test Suites: 56 failed, 3 skipped, 242 passed, 298 of 301 total
Tests:       143 failed, 39 skipped, 3401 passed, 3583 total
Time:        176.688 s
```

Pre-existing baseline (before Phase 2) was `53 failed / 3 skipped / 240 passed`
and `142 failed / 39 skipped / 3380 passed`. The exact command still cannot go
green because `prisma/schema.prisma` declares `provider = "sqlite"` while the
required URL makes `lib/db.ts` construct `@prisma/adapter-pg`:

```
PrismaClientInitializationError: The Driver Adapter '@prisma/adapter-pg',
based on 'postgres', is not compatible with the provider 'sqlite'
specified in the Prisma schema.
  at lib/db.ts:67
```

Three of the four new suites (`assistant-tools`, `assistant-agent`,
`assistant-redaction`) import the Prisma-backed chain and fail for this same
pre-existing reason under the required URL; `assistant-verifier` passes. All
37 pass under the SQLite scratch DB. No test was skipped, weakened or deleted.

## Acceptance checklist

| Requirement                                                                                    | Result                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Ground answers only in same-run tool results                                                   | Pass (verifier + prompt)                                            |
| Honest "cannot determine" path                                                                 | Pass (`verification_failed`/`limit` messages)                       |
| Server-injected identity; model never supplies it                                              | Pass (strict schemas reject identity fields; test)                  |
| Fail closed on ambiguous/missing tenant/role                                                   | Pass (executor + `assertBookTenant`)                                |
| Re-check access/role on every tool call                                                        | Pass (executor per call; engagement role per call)                  |
| READ tier only; no filings/closes/deletes/payments                                             | Pass (tier gate; registry has no PROPOSE/EXECUTE)                   |
| Wrap existing server functions                                                                 | Pass (tool layer calls existing stores/engines)                     |
| Zod strict schemas                                                                             | Pass (`objectSchema` → `.strict()`)                                 |
| Paise integers / Indian FY / INR grouping                                                      | Pass (`format.ts` + smoke output)                                   |
| Compact outputs, caps, cursor pagination, `truncated`, `total`                                 | Pass (per tool; caps 15–100)                                        |
| Redact PAN/GSTIN/bank/phone at boundary                                                        | Pass (`redact.ts` + smoke output)                                   |
| Agent hard limits (8 calls, tokens, wall, cost)                                                | Pass (agent tests)                                                  |
| Stop repeated identical calls                                                                  | Pass (duplicate test)                                               |
| Deterministic verifier; one retry; honest fallback                                             | Pass (9 verifier + agent retry tests)                               |
| `POST /api/assistant` streaming: auth, Zod, rate limits, request id, idempotency, cancellation | Implemented; not covered by an automated API test (see gaps)        |
| Append-only `AssistantRun`/`AssistantToolCall`                                                 | Pass (schema + migration + writer)                                  |
| Per-org switch + global env kill switch                                                        | Pass (settings route + `assistantEnablement`)                       |
| Defined retention                                                                              | Pass (`assistant-runs`, default 90 days)                            |
| `npx tsc --noEmit`                                                                             | Pass (exit 0)                                                       |
| `npm run lint`                                                                                 | Pass (exit 0)                                                       |
| Required full Jest command                                                                     | **Fails — pre-existing provider/adapter mismatch** documented above |
| No weakened/skipped tests; no lint disabled                                                    | Pass                                                                |
| Migration via `migrate diff`; no hand-written schema                                           | Pass (migration generated, then mirrored to both shipped sets)      |
| `migrations_sqlite_archive/` untouched                                                         | Pass                                                                |

## Decisions

1. **Identity design.** No tool accepts `bookId`/`engagementId`. The route
   validates the UI selection with `assertBookTenant` and injects it into the
   run context. With one visible book the server auto-selects; with several and
   none chosen the run stays ambiguous and the model must ask the user to pick.
2. **Org switch defaults OFF** (`ASSISTANT_ORGANIZATION_DEFAULT_ENABLED=false`);
   personal workspaces are governed only by the global kill switch.
3. **Cost honesty.** The cost cap is enforced only when `AI_COST_*` prices are
   configured; otherwise `costUsd` is `null`, never fabricated. Token/wall/tool
   caps always apply.
4. **Shared provider.** `lib/ai/provider.ts` is owned by concurrent work and is
   reused as-is; Gate 2 only added the tool/agent/API layer around it.
5. **Shipped migration sets.** Because the repo ships SQLite and PostgreSQL
   migration sets and `schema-drift.test.ts` guards both, the assistant
   migration was mirrored into `migrations-sqlite/` and `migrations-postgres/`
   in addition to the active `migrations/`.

## Gaps and blockers

1. **Full Jest cannot be green in this repo state.** Root cause is the
   pre-existing `provider = "sqlite"` + `@prisma/adapter-pg` incompatibility at
   `lib/db.ts:67`, not Phase 2. Fixing it means either switching the schema
   provider or making `lib/db.ts` choose its adapter from the schema/URL — a
   cross-cutting change outside this gate. Three new suites are collateral.
2. **No automated API test for `POST /api/assistant`.** Auth/session and the
   streaming server make this a Supertest/API-suite job, and that suite cannot
   run in the current environment. Rate limiting, idempotency replay,
   cancellation and the SSE contract were implemented but are verified only by
   code review and the agent-level tests.
3. **Pre-existing migration drift.** A freshly migrated DB is missing
   `BookVoucher.organizationId`, the `SubledgerPosting` indexes and the
   `CollaborativeUpdate` shape from BOTH the SQLite and PostgreSQL shipped
   sets. It should be fixed in its own change; Phase 2 deliberately did not
   alter unrelated tables.
4. **Concurrent writer.** `lib/ai/provider.ts`, `lib/env.ts`, `.env.example`,
   package files and chat/llm routes are being edited by another process in
   this tree. Lint/typecheck were green at the time of writing, but a later
   unrelated edit can change that.
5. **Redaction cosmetics.** Free-text PAN scrubbing can double a category label
   (e.g. `PAN PAN •••• 234F`). The value is masked; the label duplication is
   cosmetic and originates in the shared `redactSensitiveValue`.

## Open question for approval

No commit has been made. Proposed commit (scoped to Phase 2 paths only, to
avoid sweeping in another writer's in-progress files):

```
PHASE 2: TOOL REGISTRY AND AGENT LOOP (READ tier only)
```

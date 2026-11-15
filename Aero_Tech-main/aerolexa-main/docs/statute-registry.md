# Statute & notification rule registry

## The gap this closes

The CA engines compute correctly against whatever rate table they are given, but
nothing recorded **which rules were in force, since when, and on whose
authority**. Rate tables, slabs, section thresholds, TDS rates, cess, surcharge
applicability, audit turnover limits, MSB 43B(h) windows, ROC due dates and
professional-tax slabs are all data a firm must keep current — and a filed
number has to be reproducible years later.

This module is that record:

| Concern                             | Before                                 | Now                                                        |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Where a rate/slab lives             | engine constants, labelled with an AY  | a **dated, cited, versioned** row in the registry          |
| How a Finance Act change is applied | `registerOverride()` in process memory | publish a new **version**; the previous window closes      |
| Which notifications matter          | nothing                                | authority feeds ingested into a review inbox               |
| "What was the rate on 31 Mar 2026?" | unknown                                | resolve **as on** a date, entity and state                 |
| Is the firm current?                | unknown                                | registry shows every unresolved slot as **Not registered** |

## Model

Four workspace-scoped tables (`prisma/schema.prisma`):

- **StatuteSource** — an authority feed (CBID/CBIC/MCA/RBI/EPFO/GST-Council/state/other)
  with a stable `key`, a URL, and last-check status. Fetched server-side through
  the same SSRF guard as external connectors.
- **StatuteNotification** — one ingested item. Carries the canonical content hash
  (dedupe + change detection), the dates _proposed from the text_, the catalogue
  slots the parser matched, reviewer warnings, and a review status
  (`new | reviewing | applied | ignored`). **Evidence, never a rule.**
- **StatutoryRule** — a catalogue slot, created on first use so a new slot needs
  no migration.
- **StatutoryRuleVersion** — an immutable, dated version: applicability
  (`ay` + entity types + states + central/state scope), unit, value rows,
  `valueSummary`, `citation`, the effective window, the notification it came
  from, and `supersedesId`.

## The rule catalogue

`RULE_CATALOG` in `lib/engine/statutes.ts` is the documented answer to _"which
rules does the app track, and who publishes changes to them"_. Each slot
declares its unit, authority, cadence, the `ca-rate-registry` kind it feeds (if
it is a rate table) and the keywords that make a notification impact it. The
registry UI renders the catalogue; the parser matches notification text against
it. A slot with nothing in force is reported as unresolved — the app never
invents a statutory value.

## Two paths, one model

**Ingestion** (`ingestSource`)

1. Fetch the source URL (SSRF-guarded; HTML is rejected, JSON only).
2. Normalise each item: title, URL, authority, kind, **effective dates parsed
   from the text**, impacted slots, SHA-256 content hash, warnings.
3. Insert only if the same source + content hash is not already stored.
   Re-running an unchanged feed inserts nothing; an edited item is stored as a
   new notification (change detection).
4. Record the outcome on the source (`lastCheckedAt` / status / error). A fetch
   failure is recorded and rethrown — it is never reported as success.

**Registry** (`draftVersionsFromNotification` → `publishRuleVersion`)

1. A reviewer opens a notification and asks for drafts. Each draft **carries the
   value currently in force forward** so the reviewer edits the single number
   the notification changed. A missing effective date stays `null` and is
   flagged; nothing is invented.
2. Publishing writes a new version and **closes the window it replaces**
   (`effectiveTo = new effectiveFrom`) instead of deleting history — so an as-on
   lookup for a past engagement still resolves what was genuinely in force.
3. The chain is monotonic per `(rule key + applicability)`: a same-day duplicate
   is a 409, a back-dated version is a 409, and identical content is rejected.
   A state rule and an all-India rule are independent chains.
4. Publishing a version that cites a notification marks that notification
   `applied`.

## Resolution

`resolveRuleVersion(versions, { ruleKey, asOn, ay, entityType, state })`
(`lib/engine/statutes.ts`) is pure and deterministic. It selects published
versions whose window contains `asOn`, ranks applicability specificity
(more specific wins), and returns `null` when nothing applies. `toRateTable()`
converts a published version back into the `RateTable` the compute engines
already consume, and `rateTablesFromVersions()` returns every applicable table —
so a registry version can drive `getRateTable`-shaped consumers without changing
them.

## HTTP surface

| Route                                    | Method     | Purpose                                                 |
| ---------------------------------------- | ---------- | ------------------------------------------------------- |
| `/api/statutes`                          | GET        | registry overview (`asOn`, `ay`, `entityType`, `state`) |
| `/api/statutes/sources`                  | GET / POST | list / register an ingestion source                     |
| `/api/statutes/ingest`                   | POST       | fetch a source and store new items                      |
| `/api/statutes/notifications`            | GET        | the ingestion inbox (`status`, `limit`)                 |
| `/api/statutes/notifications/[id]/draft` | POST       | propose draft versions                                  |
| `/api/statutes/rules`                    | GET / POST | list versions / **publish** a version                   |
| `/api/statutes/rules/resolve`            | GET        | what was in force on a date                             |
| `/api/statutes/seed`                     | POST       | materialise the built-in AY 2025-26 defaults            |

Reads need only authentication. Writes (add source, ingest, publish, seed) need
`canAuthorRegistry` — a partner/manager/admin, or the owner of a solo
workspace — and source creation/ingestion additionally need the
`externalConnectors` entitlement, because they are the same outbound rail as a
data connector. Every write is written to the activity audit trail.

## UI

`/statutes` (page `app/(app)/statutes/page.tsx`, panel
`components/settings/statutes-panel.tsx`): summary counters, the catalogue with
the version in force and its citation, the source list with a "Fetch now"
action, the ingestion inbox with "Draft change", and an editor for the proposed
version (effective date, value summary, citation, value rows) with a Publish
button.

## Tests

- `__tests__/unit/statutes-engine.test.ts` — normalisation, date extraction,
  catalogue matching, version validation, applicability ranking, resolution,
  registry bridging.
- `__tests__/unit/statutes-service.test.ts` — ingestion idempotency and change
  detection, draft carry-forward, publish/supersede semantics (history is
  closed, not deleted), monotonic-chain refusals, seeding idempotency, the
  overview, and `canAuthorRegistry`.

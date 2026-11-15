# Performance & scale (Phase 4)

This records the decisions behind the four Phase 4 areas, and — more usefully —
the decisions that look like omissions but are deliberate. Several "optimisations"
would be correctness or security bugs here.

## 4.1 Bundle optimization

### Heavy runtimes are structural, not stylistic

`echarts` (~1 MB) and `three` (~600 kB) must never appear on a route's
first-load path. The codebase already answers "where may a heavy runtime
live?" in `components/scene/lazy-scenes.tsx`: every 3D surface is re-exported
through one `dynamic()` boundary, so the rule is a property of the codebase
rather than something each new scene must remember.

`__tests__/unit/bundle-heavy-imports.test.ts` enforces it as a graph property:
it computes the set of modules reachable from a dynamic entry point (following
static _and_ dynamic imports) and the set reachable from any `app/` route
following static imports only, then asserts no heavy module is in both.

This regressed once. `components/pbi/power-bi-studio-panel.tsx` lazy-loaded
`PbiVisual`, but `published-view.tsx` and `dashboard-builder.tsx` imported it
eagerly — putting ECharts on the critical path of both **public viewer routes**:

| Route                    | Before | After  |
| ------------------------ | ------ | ------ |
| `/apps/[shareToken]`     | 549 kB | 159 kB |
| `/embed/[token]`         | 539 kB | 150 kB |
| `/(app)/dashboards/[id]` | 597 kB | 217 kB |

The bundle-budget ratchet did **not** catch this: those routes were already
under a stale baseline. Structural assertions survive baseline drift; byte
counts do not.

### Images, fonts, third-party scripts

- **Images** — `next.config.mjs` already configures WebP/AVIF, explicit
  `deviceSizes`/`imageSizes`, `remotePatterns`, and a `contentSecurityPolicy`
  for SVG. Nothing to change.
- **Fonts** — Inter via `next/font/google` with `display: "swap"` and a CSS
  variable. Self-hosted at build time, so there is no third-party font request
  and no FOIT.
- **Third-party scripts** — there are none, by design. No `next/script`, no
  analytics, no tag manager, no CDN assets (Swagger UI and 3D textures are
  vendored). Nothing to defer, and nothing to accidentally block on login.

## 4.2 Database performance

### Indexes

The schema is already well indexed: 41 of 45 models carry `@@index`/`@@unique`,
and every foreign key that appears in a `where` clause has one — including the
composite ones that matter (`Activity` is indexed on
`[workspaceId, createdAt]`, `[workspaceId, projectId]` and `[targetType, targetId]`;
`Notification` on `[userId, readAt]`; `NotebookVersion` on
`[workspaceId, notebookId, createdAt]`). The four without indexes — `Workspace`,
`User`, `Plan`, `WebhookEvent` — are singletons or small lookup tables reached
by unique key. No changes made.

### Connection pooling

`lib/db.ts` created the Postgres adapter with only a connect timeout and an SSL
flag, inheriting every other default. Added, all env-tunable:

| Variable                           | Default | Why                                                                 |
| ---------------------------------- | ------- | ------------------------------------------------------------------- |
| `DATABASE_POOL_MAX`                | `10`    | pg's default; made explicit so it can be tuned per replica          |
| `DATABASE_POOL_IDLE_TIMEOUT_MS`    | `30000` | return idle connections instead of holding them for process life    |
| `DATABASE_POOL_CONNECT_TIMEOUT_MS` | `5000`  | the pre-v7 timeout, restored                                        |
| `DATABASE_STATEMENT_TIMEOUT_MS`    | `30000` | a runaway analytics query must not hold a pooled connection forever |

`keepAlive` is on so a proxy in front of the database (PgBouncer/pgpool) cannot
drop a connection that is about to be reused — the classic "server closed the
connection unexpectedly" under an idle-then-reuse pattern.

Sizing rule for a replica count `R`: `DATABASE_POOL_MAX × R` must stay under
the database's `max_connections`, minus headroom for migrations and admin.

### Migrations in production

`prisma migrate deploy` (never `migrate dev`) runs at boot/container start
against a single scratch schema. Two production notes:

1. **Add indexes with `CREATE INDEX CONCURRENTLY`** on Postgres. `prisma migrate
dev` generates a plain `CREATE INDEX`, which takes an `ACCESS EXCLUSIVE`
   lock and blocks reads for the duration. Generate the migration by hand,
   mark it, then verify.
2. **Every new index costs write throughput.** The Phase 4 index review added
   none, deliberately — the existing set already covers the query paths.

## 4.3 Caching strategy

### Client cache

`@tanstack/react-query` is a declared dependency that has **no
`QueryClientProvider` anywhere in the app** — every screen fetches with the raw
`api()` helper, which hardcoded `cache: "no-store"`. So nothing was ever reused
and two components asking for the same GET issued two round trips.

`lib/client/query-cache.ts` closes that gap without a provider tree or a rewrite
of every call site. It provides:

1. **TTL freshness** — a GET is served from cache until its policy expires.
2. **Request de-duplication** — concurrent GETs for the same URL share one
   in-flight promise.
3. **Stale-while-revalidate** — a stale value paints instantly and updates when
   the network answers.
4. **Bounded memory** — the store is capped and evicted oldest-first.

Correctness properties that matter more than the speed:

- A **failed request is never cached** and leaves no poisoned entry, so a
  transient 500 cannot be served to later renders.
- A failing **background revalidation is handled** — it would otherwise be an
  unhandled promise rejection, which crashes a Node process.
- `invalidate(prefix)` drops a key **and everything nested under it**, but not a
  sibling that merely shares a string prefix (`/api/datasets/abc` must not
  clobber `/api/datasets/abcdef`).
- Caching is **opt-in** (`apiCached`), so anything a user is editing keeps
  using `api()`. `apiMutate()` invalidates on write — a mutation that does not
  invalidate is the one way this cache could show a wrong number.

Default policies are deliberately short (5s–60s). This is a BI tool: a stale
number in front of a client is worse than one extra query.

### HTTP caching

`lib/server/cache-control.ts` makes the policy explicit:

| Policy                                             | Used for                                       |
| -------------------------------------------------- | ---------------------------------------------- |
| `private, no-store, max-age=0`                     | **Default.** Every authenticated response.     |
| `public, max-age=0, s-maxage=60, …must-revalidate` | Published artifacts (`/api/apps/[shareToken]`) |
| `public, max-age=3600`                             | The OpenAPI spec and Swagger shell             |

Published artifacts are the one response in the app a shared cache may hold —
they are addressed by an unguessable share token and are public _by design_.
`max-age=0` keeps browsers revalidating while `s-maxage=60` lets a CDN absorb a
burst of viewers, so unpublishing stays responsive.

The default is `no-store` deliberately: this is multi-tenant, and almost every
endpoint returns another customer's data.

### ISR — deliberately not used on authenticated routes

There is no `export const revalidate` anywhere in the app, and that is correct.

Incremental Static Regeneration caches a rendered page **at the URL**, not per
user. Applying it to `/dashboard`, `/projects/[id]` or `/datasets/[id]` would
serve one customer's workspace shell — sidebar counts, artifact lists, dataset
names — to whoever requested that URL next. That is a cross-tenant data leak,
not a performance win.

Where static generation _is_ used, the content is genuinely public and
user-independent: `generateStaticParams()` over the template catalogue, and the
static marketing page. Those are the correct ISR candidates here, and they are
already static.

The equivalent capability for per-user data is the client cache above, which is
keyed to the browser session and therefore cannot leak across accounts.

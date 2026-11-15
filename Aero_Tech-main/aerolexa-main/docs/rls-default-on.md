# Turning Row-Level Security on by default

RLS is **not yet wired in the query layer** (`RLS_QUERY_LAYER_WIRED = false`) and
enforced only when `RLS_ENABLED=true`, `prisma/rls.sql` has been applied, and the
application connects as a **non-owner** role. That combination is deliberate:
enabling the policies against unset GUCs hides every row, which looks like data
loss rather than a security feature. Run `npm run tenancy:audit` before changing
anything; it lists every tenant file that still bypasses
`withTenantContext()` and refuses a requested-but-unwired RLS configuration.

This runbook is the default-on procedure for a firm deployment. The app reports
its posture at `GET /api/health` under `checks.rlsPosture`, so you can verify
each step without guessing.

## 0. Preconditions

- PostgreSQL 16 (the SQLite development profile cannot run RLS).
- The schema is current: `npm run db:deploy`.
- A maintenance window: connections are recycled when the role changes.

## 1. Create the application role

The table owner bypasses RLS unless `FORCE` is set, and a superuser bypasses it
regardless. The app must connect as a plain role.

```sql
CREATE ROLE ledgerly_app LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE <db> TO ledgerly_app;
GRANT USAGE ON SCHEMA public TO ledgerly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ledgerly_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledgerly_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ledgerly_app;
```

Point `DATABASE_URL` at this role. Migrations should keep running as the owner
(`DIRECT_URL` / your migration job), not as `ledgerly_app`.

## 2. Apply the policies

```bash
psql "$DATABASE_URL_OWNER" -f prisma/rls.sql
```

`prisma/rls.sql` enables and forces RLS on the tenant tables and filters on
`app.current_workspace` / `app.current_organization`, which
`withTenantContext()` sets with `SET LOCAL` inside a transaction.

## 3. Wrap the query layer first

```bash
npm run tenancy:audit          # informational count + largest unwrapped files
npm run tenancy:audit -- --strict   # exits 1 until every tenant file is wrapped
```

Do not continue while `Unwrapped:` is non-zero. The audit is conservative: a file
that mixes wrapped and direct queries still counts as unwrapped.

### Auth bootstrap (do not remove)

`getAuth()` runs before an active organization is known. It uses
`withUserContext()` (only `app.current_user` is set), and two **SELECT-only**
policies let it discover the user's firms: `organization_member_bootstrap_read`
and `organization_bootstrap_read`. Writes still require
`app.current_organization`, so a user-scoped context cannot mutate org rows.
The engagement/org role lookups (`loadEngagement`, `engagementPracticeRole`,
`organizationRoleFor`) also run through the tenant context.

Without those policies, enabling RLS makes sign-in succeed but every subsequent
`requireAuth()`/`requireOrgRole()` call see no membership and return 403.

## 4. Enable enforcement

```dotenv
RLS_ENABLED=true
```

Restart the app. `GET /api/health` must show:

```json
"rlsPosture": { "requested": true, "enforced": true, "severity": "ok", ... },
"rls": { "enforcement": { "role": "ledgerly_app", "superuser": false, "bypassRls": false } }
```

If `role` is the owner or `superuser`/`bypassRls` is true, the policies are not
binding — fix the role before onboarding a firm.

## 5. Prove isolation

```bash
npm run test:postgres   # includes the RLS query-path guard suite
```

Then run the two-user check by hand:

1. Sign in as firm A, create a dataset and an engagement.
2. Sign in as firm B (separate organization) and query the same rows through SQL
   Lab, the dataset rows route, a pivot and a notebook cell.
3. Each path must return zero rows from firm A — a 404 is also acceptable, a
   result is not.

## 6. Rollback

Set `RLS_ENABLED=false` and restart. The policies stay in the database but the
tenant GUCs are no longer required; application-level guards
(`lib/auth/guard.ts`, `lib/server/members.ts`) remain in force. Never roll back
by dropping `prisma/rls.sql` objects unless you also intend to re-apply them.

## Why the default is not flipped in code

A self-hosted install that starts with SQLite would be unable to boot or would
hide every row if enforcement were unconditional. The honest default is
"reported, not assumed": development stays permissive, production is warned by
`rlsPosture()` until the operator completes this runbook.

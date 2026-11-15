# Blessed PostgreSQL deployment (ROADMAP 5.5)

The one-command production path: `docker compose --profile pg up --build -d`.
This document is the runbook for operating it — health checks, rolling
updates, RLS setup and backup/restore.

## 1. One-command deploy

```bash
# 0) Migration set + provider (once per checkout): switch-provider installs
#    prisma/migrations-postgres/ into prisma/migrations/ and regenerates the
#    client. No manual migration regeneration is needed — fresh Postgres
#    installs work with prisma migrate deploy out of the box.
npm run switch:postgres          # rewrites schema provider + installs migration set

# 1) Set real secrets in the environment (never committed):
export AUTH_SECRET="$(openssl rand -hex 32)"
export NEXT_PUBLIC_APP_URL="https://aerolexa.example.com"

# 2) Build + start Postgres and the app:
docker compose --profile pg up --build -d
```

What happens:

- `pg` starts first; compose holds the app until `pg_isready` passes.
- The app container runs `prisma migrate deploy` (idempotent) via
  `scripts/start.mjs` against the shipped `migrations-postgres/` baseline —
  fresh Postgres installs are fully migrated on first boot (verified by
  `npm run drill:backup`, which runs the same command).
- `http://localhost:3001/api/health` is the readiness probe — see §2.

## 2. Health checks

`GET /api/health` — no auth; reports booleans and latency only.

| Field                                                   | Meaning                                                                                          | Deploy action                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `checks.database.ok`                                    | real round-trip query                                                                            | false → dependency broken; LB should stop routing (503)          |
| `checks.migrations.applied`                             | applied migration count ≥ migrations shipped in this build (when `DEPLOYMENT_DATABASE=postgres`) | false → still deploying / migrations missing; hold out of the LB |
| `checks.storage.driver`                                 | `local` or `s3`                                                                                  | multi-replica deployments MUST be `s3`                           |
| `checks.scheduler.enabled` / `checks.jobWorker.enabled` | background workers on                                                                            | per-replica choice; see §4                                       |

Liveness vs readiness: the process is alive even when a dependency is broken,
so orchestrators should NOT restart on 503 — they should stop routing to it.

## 3. Rolling updates

```bash
docker compose --profile pg build app-pg
docker compose --profile pg up -d --no-deps app-pg     # single replica
docker compose --profile pg up -d --no-deps --scale app-pg=3 app-pg  # N replicas
```

- New replicas report 503 until `checks.migrations.applied` is true; only
  then put them in the load balancer.
- Migrations run BEFORE boot in the entrypoint, so a behind-schema replica
  never serves traffic.
- Multi-replica: set `LEDGERLY_STORAGE=s3` + `S3_*` so every replica shares
  the parsed/upload artifact store (the app's read-through cache handles it).

## 4. Background workers

- `SCHEDULER_ENABLED=true` → cron poller for scheduled reports/notebooks.
- `JOB_WORKER_ENABLED=true` → durable `JobQueue` drain loop (ROADMAP 5.4):
  retries with exponential backoff, dead-letter after `maxAttempts`, and
  lease-based crash recovery. For N replicas enable it on every replica —
  the atomic claim (compare-and-swap on `status`) guarantees a job runs once.
- `DIGEST_ENABLED=true` → notification digest loop (ROADMAP 7.3): emails each
  user's unread notifications as one bundle every 30 min. Idempotent
  per-pass; safe to enable on every replica, but enable it on exactly one
  if you want to avoid duplicate emails during overlapping passes.

## Email is a launch dependency, not an option

`MAIL_TRANSPORT=console` (the default) only prints mail to the server log —
verification, password reset, scheduled reports and the digest never reach a
real inbox. Production sets:

```bash
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.provider.com     # boot FAILS if transport is smtp without a host
SMTP_PORT=587                   # 587 + STARTTLS (default) or 465 + SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM="Ledgerly <no-reply@yourdomain.com>"   # must match the provider's approved sender
```

Delivery failures throw with a readable error (never silently swallowed) and
are visible in scheduled-report run messages, job-queue retries and the
audit trail.

Since launch-readiness hardening, a `NODE_ENV=production` boot **refuses to
start** with `MAIL_TRANSPORT=console` or `AUTH_REQUIRE_EMAIL_VERIFY=false` —
the two settings above are therefore mandatory, not advisory. (The zero-config
`docker compose up` prototype sets `ALLOW_INSECURE_PROD_TRANSPORTS=true` to opt
out explicitly; the `pg` profile does not.) Phone sign-in likewise refuses to
print OTP codes to the log in production unless WhatsApp delivery is
configured.

## 5. Row-Level Security (prepared, opt-in, Postgres only)

> **Not enabled by default.** `prisma/rls.sql` defines the policies (ENABLE +
> FORCE) but the application query layer is not yet wrapped in
> `withTenantContext()`, so turning RLS on today would hide every row. Do **not**
> set `RLS_ENABLED=true` until that wiring lands (ROADMAP 2.5). The application
> layer (`lib/auth/guard.ts`, `lib/server/members.ts`) is the isolation
> boundary. `/api/health` reports the live RLS status.

```bash
# Apply the policies (safe to run now: enforcement additionally needs the app
# to connect as a non-owner role AND the query-layer wiring above).
psql "$DATABASE_URL" -f prisma/rls.sql
# Only AFTER the query layer is wired, and using a dedicated non-owner role:
# RLS_ENABLED=true docker compose --profile pg up -d --no-deps app-pg
```

## 6. Backup & restore

Backup (nightly cron):

```bash
docker compose --profile pg exec -T pg \
  pg_dump -U Ledgerly -d Ledgerly -Fc > "backup-$(date +%F).dump"
```

Restore:

```bash
docker compose --profile pg exec -T pg \
  pg_restore -U Ledgerly -d Ledgerly --clean --if-exists < backup-YYYY-MM-DD.dump
```

Object storage (uploads + parsed NDJSON when `LEDGERLY_STORAGE=s3`) is
backed up with your bucket's native versioning — the DB references those
keys, so restore both together.

**Drill it, don't trust it** — the §6 commands are executed end-to-end by:

```bash
npm run drill:backup        # disposable containers: migrate → seed 10k rows →
                            # pg_dump -Fc → pg_restore → verify counts + checksum
```

The drill exits non-zero on any mismatch and appends a dated PASS row to
`docs/quality-baseline.md`. Run it on every deployment target before go-live
and after any Prisma migration change; a pass on one machine does not prove
another.

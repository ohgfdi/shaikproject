# Disaster Recovery Runbook

## Overview

This runbook describes recovery procedures for the Ledgerly application in the event of data loss, corruption, or extended downtime. It is designed for operators who have PostgreSQL administrative access and have completed the [deployment checklist](./docs/deployment-checklist.md).

---

## 1. Preconditions

Before running any recovery procedure:

- [ ] PostgreSQL is running and accessible
- [ ] A recent backup exists (see §2)
- [ ] Prisma migrations are at the expected version (`npm run db:deploy` baseline)
- [ ] Tenancy audit passes: `npm run tenancy:audit` shows **0 unwrapped** (baseline 160)
- [ ] `RLS_ENABLED=true` and `RLS_QUERY_LAYER_WIRED=true` are set per `.env.production`
- [ ] A read-only replica is available for backup restoration (recommended)

---

## 2. Backup & Restore

### 2.1 Backup Schedule

- **Automated**: Managed PostgreSQL provider (Neon, Supabase, Aiven) handles daily point-in-time recovery (PITR).
- **Manual**: Run `pg_dump` weekly or before major schema changes.

### 2.2 Restoring a Backup

```bash
# 1. Identify the backup to restore from (date/time label)
BACKUP_LABEL="2024-01-15_22-00"

# 2. Restore from the managed provider's UI/CLI
#    (e.g., neon databases: neon backup restore --label $BACKUP_LABEL)

# 3. Verify migration state
npm run db:deploy  # applies any pending migrations

# 4. Run tenancy audit to confirm compliance
npm run tenancy:audit  # must show 0 unwrapped

# 5. Restart the application
vercel --prod  # or: docker restart ledgerly
```

### 2.3 Point-in-Time Recovery (PITR)

```bash
# Restore to a specific timestamp (e.g., 1 hour ago)
psql "postgresql://user:password@host:5432/db" \
  -c "SELECT pg_start_backup('recovery');"

# Follow provider-specific PITR instructions.
# For Neon: use the point-in-time restore feature in the dashboard.
```

---

## 3. Migration Rollback

### 3.1 Rolling Back a Prisma Migration

```bash
# 1. Identify the migration to roll back to
npx prisma migrate resolve --rolled-back 20240115120001

# 2. Generate a down migration (if not already defined)
npx prisma migrate resolve --target 20240115120001

# 3. Apply the down migration
npx prisma migrate deploy --rolled-back

# 4. Verify tenancy compliance
npm run tenancy:audit

# 5. Restart the application
```

### 3.2 If No Down Migration Exists

```bash
# 1. Snapshot the current database
pg_dump "$DATABASE_URL" > backup_$(date +%Y%m%d).sql

# 2. Restore the previous migration state manually in PostgreSQL:
psql "$DATABASE_URL" < backup_previous.sql

# 3. Update Prisma schema to match the previous migration
#    (edit prisma/schema.prisma or use `prisma migrate resolve`)

# 4. Re-deploy and verify
npm run db:deploy
npm run tenancy:audit
```

---

## 4. Tenancy Compliance Recovery

### 4.1 After Any Database Change

```bash
# 1. Run the tenancy audit
npm run tenancy:audit

# 2. Verify the unwrapped count has not increased
#    - If unwrapped > 0: identify and wrap the new direct Prisma accesses
#    - If unwrapped = 0: compliance is maintained

# 3. If the baseline needs adjustment (rare, only with conscious PR)
#    - Document the change in the PR
#    - Update RLS_UNWRAPPED_BASELINE in lib/server/rls-status.ts if lowering
```

### 4.2 RLS Policy Changes

```bash
# 1. Apply new RLS policies from prisma/rls.sql
npx prisma migrate dev --create-only

# 2. Review the generated migration
# 3. Apply to production
npx prisma migrate deploy

# 4. Re-run tenancy audit
npm run tenancy:audit

# 5. Test RLS enforcement:
#    - Log in as a non-owner role
#    - Verify cross-firm data isolation
#    - Confirm RLS posture is "ok" via /api/health
```

---

## 5. Health Check & Readiness

### 5.1 Readiness Probe

```bash
# The /api/health endpoint reports readiness status:
#   200 — app is up AND all dependencies are healthy
#   503 — a dependency is broken (DB, migrations, RLS config)

curl -s http://localhost:3000/api/health | jq .
```

### 5.2 RLS Posture

```bash
# Check RLS enforcement status:
curl -s http://localhost:3000/api/health | jq '.checks.rlsPosture'
```

Expected when healthy:
```json
{
  "database": "postgres",
  "nodeEnv": "production",
  "requested": true,
  "enforced": true,
  "queryLayerWired": true,
  "configError": null,
  "severity": "ok",
  "summary": "RLS is requested on PostgreSQL and the query layer sets the tenant context inside a transaction.",
  "remedy": "Keep the migrating role non-owner and re-run the drill after role or policy changes."
}
```

---

## 6. Error Tracking

### 6.1 Capturing Errors

Errors are captured via `POST /api/errors` with a fingerprint, name, message, stack, and path. Example:

```bash
curl -X POST http://localhost:3000/api/errors \
  -H "Content-Type: application/json" \
  -d '{"err":{"name":"PrismaClientKnownError","message":"relation "Organization" does not exist","stack":"Error: relation Organization does not exist\\n    at PrismaClient..."}}'
```

### 6.2 Viewing Errors

```bash
# List all fingerprinted errors (paginated)
curl http://localhost:3000/api/errors?limit=20

# List unresolved errors
curl "http://localhost:3000/api/errors?resolved=false"

# Delete/resolve an error (admin only)
curl -X DELETE http://localhost:3000/api/errors/fingerprint-uuid
```

### 6.3 Privacy Properties

- No PII is stored (emails, tokens, long hex IDs are redacted)
- Stack frames are relative to the app root (absolute build paths removed)
- Cardinality-capped: a fingerprint hashes many instances into one row
- Errors never throw; failures are swallowed by design

---

## 7. Alerting & Monitoring

### 7.1 Metrics Endpoint

The `/api/health` endpoint emits the following metrics that can be scraped by Prometheus or integrated with a monitoring vendor:

| Metric | Type | Description |
|--------|------|-------------|
| `checks.database.ok` | Gauge | 1 = DB reachable, 0 = unreachable |
| `checks.database.latencyMs` | Histogram | Round-trip query latency |
| `checks.rlsPosture.severity` | Gauge | "ok" | "warn" | "critical" |
| `checks.migrations.applied` | Gauge | Number of applied migrations |
| `jobWorker.enabled` | Gauge | 1 = worker is enabled, 0 = disabled |
| `queue.enabled` | Gauge | 1 = scheduler queue is enabled |
| `backup.enabled` | Gauge | 1 = backup system is enabled |

### 7.2 Alert Rules (example for Alertmanager)

```yaml
# Alert if DB is unreachable
- alert: DatabaseDown
  expr: up{service="Ledgerly"} == 0
  for: 1m
  labels: severity: critical
  annotations:
    summary: "Ledgerly database is down"
    description: "The app cannot reach its PostgreSQL database."

# Alert if RLS is not enforced in production
- alert: RLSNotEnforced
  expr: ledgerly_rls_severity{severity!="ok"} == 1
  for: 5m
  labels: severity: critical
  annotations:
    summary: "Row-level security is not enforced"
    description: "RLS_ENABLED=true but query layer is not wrapped in withTenantContext()."
```

---

## 8. Incident Response Workflow

### 8.1 Liveness Failure (503 from /api/health)

1. Check `/api/health` — identify the failing check (database, migrations, RLS)
2. If **database**: verify PostgreSQL is running, check connection string, restart the container
3. If **migrations**: run `npx prisma migrate deploy`; verify with `npm run db:deploy`
4. If **RLS**: run `npm run tenancy:audit`; if unwrapped > 0, wrap files or raise baseline consciously
5. Restart the application once the check passes
6. Verify `/api/health` returns `200`

### 8.2 Data Corruption

1. Identify the affected table/data via logs or error reports
2. Restore from the most recent backup (§2)
3. Run `npm run tenancy:audit` to confirm compliance
4. Validate application functionality (smoke test key flows)
5. Document the incident in the team channel

### 8.3 Tenancy Compliance Drift

1. Run `npm run tenancy:audit`
2. If unwrapped > 0:
   - Identify new files with direct Prisma accesses
   - Wrap them in `withTenantContext()` or `withTenantDb()`
   - Commit the wrapping change with a conscious PR that documents the decision
   - If lowering the baseline: document the justification in the PR
3. If unwrapped = 0: compliance is maintained; resume normal operations

---

## 9. Communication

### 9.1 Status Page

- Bookmark `/api/health` for quick liveness/readiness checks
- Share the health URL with on-call engineers

### 9.2 Incident Channel

- Post all incidents to the `#ops-incidents` Slack/Teams channel
- Include: `/api/health` output, backup timestamps, migration versions
- Link to the DR runbook for reference

### 9.3 Post-Incident Review

After any incident > 15 minutes:

1. Complete the [ incident template](https://example.com/incident-template) (link in handbook)
2. Root-cause analysis: what failed, why, and how to prevent recurrence
3. Action items with owners and deadlines
4. Post-mortem published to the team wiki

---

## 10. Quick Reference Cheat Sheet

```bash
# Liveness/readiness
curl http://localhost:3000/api/health

# Tenancy audit
npm run tenancy:audit

# Error tracking (list unresolved)
curl "http://localhost:3000/api/errors?resolved=false"

# RLS posture
curl http://localhost:3000/api/health | jq '.checks.rlsPosture'

# Backup status (managed provider UI)
#   → Check provider dashboard for PITR and last successful backup

# Restart after fix
vercel --prod  # or: systemctl restart ledgerly
```

---
*Document version: 1.0 — reviewed quarterly. Last updated: $(date +%Y-%m-%d)*
import { prisma } from "@/lib/db";
import { publicEnv } from "@/lib/env";
import { backupPosture, readBackupReceipt } from "@/lib/server/backup-evidence";
import { log } from "@/lib/server/logger";
import { moduleEnabled } from "@/lib/server/modules";
import { queueHealth } from "@/lib/server/queue-health";
import { rlsPosture } from "@/lib/server/rls-posture";
import { storageKind } from "@/lib/server/storage";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe.
 *
 * 200 — app is up AND the database answers a real round-trip query.
 * 503 — app is up but a dependency is broken (DB unreachable). Load balancers
 *       and orchestrators should stop routing to this instance; k8s liveness
 *       should NOT restart on 503 (the process is alive, the dependency is not).
 *
 * The body reports the config that matters for operating multiple instances.
 * No authentication: it exposes only booleans and latency, never data.
 */
export async function GET() {
  const now = new Date();
  const startedAt = Date.now();
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    log.error("health: database check failed", { error: err instanceof Error ? err.message : String(err) });
  }
  const dbLatencyMs = Date.now() - startedAt;

  // Queue depth (not just the enable flag). A stopped worker and an idle queue
  // used to look identical from here; queueHealth() separates them and a dead
  // job is reported even when the queue is otherwise empty. It never flips
  // readiness — the app is alive and can serve traffic with a backed-up queue —
  // but severity="critical" is the signal an operator must act on.
  const queue = await queueHealth(now);

  // Backup evidence: the drill writes a machine-readable receipt, so a stale or
  // failed restore is visible without reading a markdown table. No receipt is
  // "no evidence", never "fine".
  const backup = backupPosture(await readBackupReceipt(), now);

  // Migration gate (ROADMAP 5.5): when the deployment opts in with
  // DEPLOYMENT_DATABASE=postgres, a replica whose schema is BEHIND must not
  // receive traffic — a query that references a not-yet-migrated column 500s,
  // which looks like a broken app instead of "still deploying". We compare
  // applied migrations against the count shipped with this build; failure to
  // CHECK is reported honestly but leaves readiness unknown rather than false
  // (a transient check error must not flap the LB). Feeds readiness only.
  let migrationsApplied: boolean | null = null; // null = unknown (non-pg or check unavailable)
  let migrationError: string | null = null;
  if (dbOk && process.env.DEPLOYMENT_DATABASE === "postgres") {
    try {
      const rows = (await prisma.$queryRaw<{ applied: number }[]>`SELECT COUNT(*)::int AS applied
         FROM "_prisma_migrations"
         WHERE finished_at IS NOT NULL AND rollback_at IS NULL`) as { applied: number }[];
      const applied = rows[0]?.applied ?? 0;
      const { expectedMigrations } = await import("@/lib/server/migration-contract");
      migrationsApplied = applied >= expectedMigrations();
    } catch (err) {
      migrationError = err instanceof Error ? err.message : String(err);
    }
  }

  // RLS status (PostgreSQL only): report whether requested row-level security
  // is actually enforced, plus any premature-enable config error. Best-effort
  // (a probe failure reports unknown) and never flips readiness by itself.
  let rls: Record<string, unknown> | null = null;
  if (dbOk) {
    const { isPostgres, rlsConfigError, rlsEnabled, rlsEnforcementStatus } = await import("@/lib/server/tenancy");
    if (isPostgres()) {
      const configError = rlsConfigError();
      let enforcement: Awaited<ReturnType<typeof rlsEnforcementStatus>> | null = null;
      try {
        enforcement = await rlsEnforcementStatus();
      } catch {
        enforcement = null;
      }
      rls = {
        requested: process.env.RLS_ENABLED === "true",
        enabled: rlsEnabled(),
        ...(configError ? { configError } : {}),
        ...(enforcement ? { enforcement } : {}),
      };
    }
  }

  const body: {
    ok: boolean;
    service: string;
    checks: Record<string, unknown>;
    version: string;
    time: string;
  } = {
    ok: dbOk,
    service: "Ledgerly",
    checks: {
      database: { ok: dbOk, latencyMs: dbLatencyMs },
      migrations: { applied: migrationsApplied, ...(migrationError ? { error: migrationError } : {}) },
      storage: { driver: safeStorageKind() },
      rlsPosture: rlsPosture(),
      scheduler: { enabled: moduleEnabled("SCHEDULER_ENABLED") },
      jobWorker: { enabled: process.env.JOB_WORKER_ENABLED === "true" },
      queue,
      backup,
      digest: { enabled: process.env.DIGEST_ENABLED === "true" },
      ...(rls ? { rls } : {}),
    },
    version: process.env.APP_VERSION ?? "dev",
    time: new Date().toISOString(),
  };

  // The public app URL is the only env value echoed, and only when healthy.
  if (dbOk) body.checks.appUrl = publicEnv.NEXT_PUBLIC_APP_URL;

  // Readiness: liveness (dbOk) AND — when the Postgres profile is active —
  // every migration applied. A rolling deploy holds the new replica out of
  // the LB until this flips true.
  const ready = dbOk && migrationsApplied !== false;

  return Response.json(body, {
    status: ready ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

function safeStorageKind(): string {
  try {
    return storageKind();
  } catch {
    return "misconfigured";
  }
}

/**
 * Launch preflight.
 *
 *   npm run preflight:prod
 *
 * One command that answers the questions an operator otherwise discovers from a
 * bad deploy: is this a real Postgres install, is row-level security consistent
 * with the flag, is the schema at the shipped migration count, has a restore
 * actually been proven, is the job worker draining, and is filing configured?
 *
 * Exit 0 = no blocking finding. Exit 1 = at least one `error`. Warnings do not
 * block a self-hosted install that is still completing the runbook, but they are
 * printed with the exact remedy.
 */

import "dotenv/config";

import { filingGatewayHealth } from "../lib/engine/filing/gateway";
import { backupPosture, readBackupReceipt } from "../lib/server/backup-evidence";
import { outboxPosture } from "../lib/server/mail-outbox";
import { queueHealth } from "../lib/server/queue-health";
import { rlsPosture } from "../lib/server/rls-posture";

type Level = "ok" | "warn" | "error";

interface Check {
  id: string;
  level: Level;
  summary: string;
  remedy?: string;
}

function push(checks: Check[], check: Check): void {
  checks.push(check);
}

async function main(): Promise<number> {
  const checks: Check[] = [];
  const production = process.env.NODE_ENV === "production";
  const rls = rlsPosture(process.env);

  // 1) Database provider. SQLite is a fine dev default and a bad production one.
  push(checks, {
    id: "database",
    level: rls.database === "postgres" ? "ok" : production ? "error" : "warn",
    summary:
      rls.database === "postgres"
        ? "PostgreSQL is the configured database."
        : `Database provider is ${rls.database}; production should run PostgreSQL (npm run switch:postgres).`,
    remedy: rls.database === "postgres" ? undefined : "Run `npm run switch:postgres`, apply migrations, then `npm run drill:backup`.",
  });

  // 2) RLS consistency. Contradiction is always an error; off in production is a warning.
  if (rls.configError) {
    push(checks, {
      id: "rls",
      level: "error",
      summary: rls.configError,
      remedy: "Unset RLS_ENABLED on SQLite, or move DATABASE_URL to PostgreSQL and apply prisma/rls.sql.",
    });
  } else if (rls.database === "postgres" && !rls.requested) {
    push(checks, {
      id: "rls",
      level: "warn",
      summary: "RLS_ENABLED is off; tenant isolation relies on the application guard.",
      remedy: "Apply prisma/rls.sql, then set RLS_ENABLED=true and confirm /api/health reports enforcement.",
    });
  } else {
    push(checks, { id: "rls", level: "ok", summary: rls.summary });
  }

  // 3) Backup evidence, not backup configuration.
  const backup = backupPosture(await readBackupReceipt(), new Date());
  push(checks, {
    id: "backup",
    level: backup.severity === "critical" ? "error" : backup.severity === "warn" ? "warn" : "ok",
    summary: backup.summary,
    remedy: backup.severity === "ok" ? undefined : backup.remedy,
  });

  // 4) Schema at the migration count shipped with this build.
  if (rls.database === "postgres") {
    try {
      const { prisma } = await import("../lib/db");
      const { expectedMigrations } = await import("../lib/server/migration-contract");
      const rows = (await prisma.$queryRaw`SELECT COUNT(*)::int AS applied
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rollback_at IS NULL`) as { applied: number }[];
      const applied = rows[0]?.applied ?? 0;
      const expected = expectedMigrations();
      push(checks, {
        id: "migrations",
        level: applied >= expected ? "ok" : "error",
        summary: `${applied} of ${expected} migrations applied.`,
        remedy: applied >= expected ? undefined : "Run `npm run db:deploy` before routing traffic to this instance.",
      });
    } catch (err) {
      push(checks, {
        id: "migrations",
        level: "warn",
        summary: `Could not read the migration ledger (${err instanceof Error ? err.message : String(err)}).`,
        remedy: "Check DATABASE_URL connectivity and re-run the preflight.",
      });
    }
  }

  // 5) Durable queue: depth, dead jobs, and whether a worker is enabled.
  const queue = await queueHealth();
  push(checks, {
    id: "queue",
    level: queue.severity === "critical" ? "error" : queue.severity === "warn" ? "warn" : "ok",
    summary: queue.summary,
    remedy:
      queue.severity === "ok"
        ? undefined
        : `${queue.remedy} JOB_WORKER_ENABLED is ${process.env.JOB_WORKER_ENABLED === "true" ? "on" : "OFF"}.`,
  });

  // 6) Secrets and public URL.
  const authSecret = process.env.AUTH_SECRET ?? "";
  push(checks, {
    id: "auth-secret",
    level: authSecret.length >= 32 ? "ok" : "error",
    summary:
      authSecret.length >= 32
        ? "AUTH_SECRET is present and long enough to sign sessions."
        : "AUTH_SECRET is missing or shorter than 32 characters.",
    remedy: authSecret.length >= 32 ? undefined : "Generate one: openssl rand -base64 48, then set AUTH_SECRET.",
  });

  const app = process.env.NEXT_PUBLIC_APP_URL ?? "";
  push(checks, {
    id: "app-url",
    level: /^https:\/\//.test(app) ? "ok" : production ? "warn" : "ok",
    summary: app
      ? `Public app URL: ${app}`
      : "NEXT_PUBLIC_APP_URL is not set; shared links and emails will not point anywhere.",
    remedy: app ? undefined : "Set NEXT_PUBLIC_APP_URL to the public https URL of this install.",
  });

  // 7) Mail delivery. Portal invites and client approvals are useless if the
  // console transport is still selected in production.
  const mailTransport = (process.env.MAIL_TRANSPORT ?? "console").trim();
  const smtpHost = (process.env.SMTP_HOST ?? "").trim();
  const mailOk = mailTransport === "smtp" && smtpHost !== "";
  push(checks, {
    id: "mail",
    level: mailOk ? "ok" : production ? "warn" : "ok",
    summary: mailOk
      ? `SMTP mail is configured (${smtpHost}).`
      : `MAIL_TRANSPORT is "${mailTransport}"; client portal invitations print to the server log instead of reaching clients.`,
    remedy: mailOk
      ? undefined
      : "Set MAIL_TRANSPORT=smtp with SMTP_HOST (and SMTP_USER/SMTP_PASS), then re-send pending invitations.",
  });

  // 7b) Durable outbox. Failed rows are messages a firm believes it sent.
  const outbox = await outboxPosture();
  push(checks, {
    id: "mail-outbox",
    level: outbox.counts.failed > 0 ? "warn" : "ok",
    summary:
      outbox.counts.failed > 0
        ? `${outbox.counts.failed} queued message(s) exhausted retries and were not delivered.`
        : `${outbox.counts.pending} queued message(s) pending, ${outbox.counts.sent} delivered.`,
    remedy:
      outbox.counts.failed > 0
        ? "Inspect MailOutbox.lastError, fix the SMTP cause, reset status to pending (attempts 0), and let the worker retry."
        : undefined,
  });

  // 8) Filing gateway — informational; conformance is a separate command.
  const filing = filingGatewayHealth();
  push(checks, {
    id: "filing",
    level: filing.provider === "live" ? "ok" : "warn",
    summary: `Filing gateway provider is "${filing.provider}"; nothing leaves the building in simulation.`,
    remedy:
      filing.provider === "live"
        ? undefined
        : "Set FILING_GATEWAY=live with credentials, then run `npm run filing:conformance`.",
  });

  const order: Record<Level, number> = { error: 0, warn: 1, ok: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);

  for (const check of checks) {
    const marker = check.level === "error" ? "FAIL" : check.level === "warn" ? "WARN" : "OK  ";
    process.stdout.write(`[${marker}] ${check.id}: ${check.summary}\n`);
    if (check.remedy) process.stdout.write(`       fix: ${check.remedy}\n`);
  }

  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  process.stdout.write(
    `\n${errors === 0 ? "Preflight passed" : "Preflight BLOCKED"} — ${errors} error(s), ${warnings} warning(s).\n`,
  );
  return errors === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`preflight: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

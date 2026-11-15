/**
 * Boot-time row-level-security gate.
 *
 * `rlsPosture()` already reports the matrix, but a report nobody reads is not a
 * gate. Two configurations are unsafe enough to refuse booting:
 *
 *  1. `RLS_ENABLED=true` on a non-Postgres database — the request is a no-op,
 *     so the operator believes isolation is enforced when it is not.
 *  2. `RLS_ENABLED=true` with an owner/superuser connection is not detectable
 *     from env alone; `/api/health` reports the live role check instead.
 *
 * Production Postgres with RLS off stays a WARNING, not a refusal: self-hosted
 * installs legitimately run that way while completing the runbook, and the
 * application guard still isolates tenants. The gate exists so the risk is
 * printed at boot and visible in health, not so a working instance dies.
 *
 * Pure by construction (takes env), so the decision is unit-testable.
 */

import { rlsPosture } from "@/lib/server/rls-posture";

export type RlsBootLevel = "error" | "warn";

export interface RlsBootFinding {
  level: RlsBootLevel;
  code: string;
  message: string;
  remedy: string;
}

export function rlsBootFindings(env: Record<string, string | undefined> = process.env): RlsBootFinding[] {
  const posture = rlsPosture(env);
  const findings: RlsBootFinding[] = [];

  if (posture.configError) {
    findings.push({
      level: "error",
      code: "RLS_CONFIG_CONTRADICTION",
      message: posture.configError,
      remedy: "Unset RLS_ENABLED on SQLite, or move DATABASE_URL to PostgreSQL and apply prisma/rls.sql.",
    });
  }

  if (env.NODE_ENV === "production" && posture.database !== "postgres") {
    findings.push({
      level: "warn",
      code: "SQLITE_IN_PRODUCTION",
      message: posture.summary,
      remedy: posture.remedy,
    });
  }

  if (env.NODE_ENV === "production" && posture.database === "postgres" && !posture.requested) {
    findings.push({
      level: "warn",
      code: "RLS_OFF_IN_PRODUCTION",
      message: posture.summary,
      remedy: posture.remedy,
    });
  }

  return findings;
}

/** Throws only on a contradiction — a warning must not stop a working app. */
export function assertRlsBootFindings(findings: RlsBootFinding[]): void {
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to boot: ${errors.map((finding) => `${finding.code} — ${finding.message}`).join(" ")} ` +
      `Remedy: ${errors[0]?.remedy ?? "Check the RLS configuration."}`,
  );
}

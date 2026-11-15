/**
 * Row-level-security posture for the deployment.
 *
 * RLS policies are prepared (prisma/rls.sql) but the query layer is NOT wrapped
 * yet (`RLS_QUERY_LAYER_WIRED = false`), so enforcement is opt-in *and* refused
 * until `npm run tenancy:audit` reaches zero. That is a defensible choice for a
 * single-tenant dev box and an indefensible default for a production CA firm,
 * so the posture is computed explicitly instead of being left implicit in env.
 *
 * Pure: reads the supplied env only, so the matrix is unit-testable.
 */

export type RlsPostureSeverity = "ok" | "warn" | "critical";

export interface RlsPosture {
  database: "postgres" | "other";
  nodeEnv: string;
  requested: boolean;
  enforced: boolean;
  queryLayerWired: boolean;
  configError: string | null;
  severity: RlsPostureSeverity;
  summary: string;
  remedy: string;
}

import { RLS_AUDIT_COMMAND, RLS_QUERY_LAYER_WIRED } from "@/lib/server/rls-status";

export const RLS_DEFAULT_ON_DOC = "docs/rls-default-on.md";

export function rlsPosture(env: Record<string, string | undefined> = process.env): RlsPosture {
  const database = (env.DATABASE_URL ?? "").startsWith("postgres") ? "postgres" : "other";
  const nodeEnv = env.NODE_ENV ?? "development";
  const requested = env.RLS_ENABLED === "true";
  const queryLayerWired = RLS_QUERY_LAYER_WIRED;
  const production = nodeEnv === "production";

  if (database !== "postgres") {
    return {
      database,
      nodeEnv,
      requested,
      enforced: false,
      queryLayerWired,
      configError: requested ? "RLS_ENABLED=true is a no-op without PostgreSQL." : null,
      severity: production ? "warn" : "ok",
      summary: production
        ? "Production is running on SQLite. Isolation rests entirely on application checks, and Postgres-only features (RLS, migration gates) are unavailable."
        : "RLS does not apply to the SQLite development profile.",
      remedy: production
        ? "Use the PostgreSQL profile before onboarding a paying firm (docs/deploy-postgres.md)."
        : "No action for local development.",
    };
  }

  if (requested && !queryLayerWired) {
    return {
      database,
      nodeEnv,
      requested,
      enforced: false,
      queryLayerWired,
      configError: `RLS was requested before the query layer was wrapped in withTenantContext(). Every row would be hidden. Measure the gap with ${RLS_AUDIT_COMMAND}.`,
      severity: "critical",
      summary: "RLS is requested but the tenant context is not applied; queries would return nothing.",
      remedy: `Leave RLS_ENABLED=false until ${RLS_AUDIT_COMMAND} reports zero unwrapped tenant files.`,
    };
  }

  if (!requested) {
    return {
      database,
      nodeEnv,
      requested,
      enforced: false,
      queryLayerWired,
      configError: null,
      severity: production ? "warn" : "ok",
      summary: production
        ? "PostgreSQL is running with RLS off. Tenant isolation is enforced by the application layer only, so a missed guard is a cross-firm read."
        : "PostgreSQL is running with RLS off (expected for local development).",
      remedy: production
        ? `Turn enforcement on for firm deployments: apply prisma/rls.sql with a non-owner role and set RLS_ENABLED=true. See ${RLS_DEFAULT_ON_DOC}.`
        : `Enable it when you move to a shared or production database. See ${RLS_DEFAULT_ON_DOC}.`,
    };
  }

  return {
    database,
    nodeEnv,
    requested,
    enforced: true,
    queryLayerWired,
    configError: null,
    severity: "ok",
    summary: "RLS is requested on PostgreSQL and the query layer sets the tenant context inside a transaction.",
    remedy: "Keep the migrating role non-owner and re-run the drill after role or policy changes.",
  };
}

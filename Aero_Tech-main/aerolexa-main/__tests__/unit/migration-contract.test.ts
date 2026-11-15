/**
 * Oracle tests for the migration contract (ROADMAP 5.5), updated for the
 * provider-scoped layout:
 *
 *   prisma/migrations-sqlite/    23 incremental migrations + lock (sqlite)
 *   prisma/migrations-postgres/  1 idempotent baseline + lock (postgresql)
 *   prisma/migrations/           installed set (scripts/switch-provider.mjs)
 *
 * The counter must resolve through installed → shipped-set matching the
 * schema provider, and the shipped sets must agree with their own locks so
 * `prisma migrate deploy` works for BOTH providers without manual steps.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { expectedMigrations } from "@/lib/server/migration-contract";

const prismaDir = path.join(process.cwd(), "prisma");
const schema = readFileSync(path.join(prismaDir, "schema.prisma"), "utf8");
const schemaProvider = /provider\s*=\s*"(sqlite|postgresql)"/.exec(schema)?.[1] ?? "sqlite";

function countDirs(dir: string): number {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
}

function lockProvider(dir: string): string | null {
  const lock = path.join(dir, "migration_lock.toml");
  if (!existsSync(lock)) return null;
  return /provider\s*=\s*"(sqlite|postgresql)"/.exec(readFileSync(lock, "utf8"))?.[1] ?? null;
}

describe("migration contract", () => {
  it("resolves the active count through installed → shipped-set fallback", () => {
    const installed = countDirs(path.join(prismaDir, "migrations"));
    const shipped = countDirs(path.join(prismaDir, `migrations-${schemaProvider}`));
    const expected = installed > 0 ? installed : shipped;
    expect(expectedMigrations()).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("is deterministic across calls (no fs races in the count)", () => {
    expect(expectedMigrations()).toBe(expectedMigrations());
  });

  it("ships BOTH provider sets (fresh installs work without db push)", () => {
    expect(existsSync(path.join(prismaDir, "migrations-sqlite"))).toBe(true);
    expect(existsSync(path.join(prismaDir, "migrations-postgres"))).toBe(true);
  });

  it("each shipped set's lock matches its dialect (no mid-deploy provider mismatch)", () => {
    expect(lockProvider(path.join(prismaDir, "migrations-sqlite"))).toBe("sqlite");
    expect(lockProvider(path.join(prismaDir, "migrations-postgres"))).toBe("postgresql");
  });

  it("the sqlite set keeps its incremental migrations", () => {
    // Bump this when a migration is added — the number IS the deploy contract
    // (lib/server/migration-contract.ts gates readiness on it).
    // 42 = the shipped set before client document requests; 43 = +that table;
    // 44 = +the deliverable document-reference/UDIN-source columns;
    // 47 = +the portal, compliance-calendar and engagement-scoped-request sets;
    // 48 = +the filing-run/event execution pipeline;
    // 49 = +practice time entries and client invoices;
    // 50 = +the User state/country columns the schema already declared;
    // 51 = +invoice settlement, filing verification and the partner digest.
    // 52 = +the immutable filing proof bundle.
    // 53 = +TOTP MFA state on User.
    // 54 = +the client approval receipt columns.
    // 55 = +client portal accounts and their one-time sign-in tokens.
    // 56 = +magic-link delivery status on those tokens.
    // 57 = +durable mail outbox.
    // 58 = +per-client filing rollout state.
    expect(countDirs(path.join(prismaDir, "migrations-sqlite"))).toBe(58);
  });

  it("the postgres set keeps its idempotent whole-schema baseline", () => {
    const baseline = path.join(prismaDir, "migrations-postgres", "20260924000000_postgres_baseline", "migration.sql");
    expect(existsSync(baseline)).toBe(true);
    const sql = readFileSync(baseline, "utf8");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "public"');
    expect(sql).toContain('CREATE TABLE "User"');
    // Idempotent guard is what makes re-deploys safe.
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("ships the engagement-governance migration for both providers", () => {
    const sqlite = path.join(
      prismaDir,
      "migrations-sqlite",
      "20261008000000_add_engagement_governance",
      "migration.sql",
    );
    const postgres = path.join(
      prismaDir,
      "migrations-postgres",
      "20261008000000_add_engagement_governance",
      "migration.sql",
    );
    expect(existsSync(sqlite)).toBe(true);
    expect(existsSync(postgres)).toBe(true);
    for (const file of [sqlite, postgres]) {
      const sql = readFileSync(file, "utf8");
      expect(sql).toContain('CREATE TABLE "EngagementChangeLog"');
      expect(sql).toContain('CREATE TABLE "WorkingPaper"');
      expect(sql).toContain('CREATE TABLE "ClientConsent"');
    }
  });

  it("ships the deliverable-assembly migration for both providers", () => {
    const sqlite = path.join(
      prismaDir,
      "migrations-sqlite",
      "20261009000000_add_deliverable_assembly",
      "migration.sql",
    );
    const postgres = path.join(
      prismaDir,
      "migrations-postgres",
      "20261009000000_add_deliverable_assembly",
      "migration.sql",
    );
    expect(existsSync(sqlite)).toBe(true);
    expect(existsSync(postgres)).toBe(true);
    for (const file of [sqlite, postgres]) {
      const sql = readFileSync(file, "utf8");
      expect(sql).toContain('CREATE TABLE "EngagementReportFormat"');
      expect(sql).toContain('CREATE TABLE "EngagementReportTemplate"');
      expect(sql).toContain('CREATE TABLE "EngagementDeliverableVersion"');
      expect(sql).toContain('CREATE TABLE "EngagementDeliverableSignOff"');
      expect(sql).toContain('CREATE TABLE "EngagementDeliverablePart"');
      expect(sql).toContain('CREATE TABLE "EngagementDeliverableRedaction"');
      expect(sql).toContain('CREATE TABLE "OrganizationReportTemplate"');
    }
  });

  it("ships the statute/notification rule registry migration for both providers", () => {
    const sqlite = path.join(prismaDir, "migrations-sqlite", "20261011000000_add_statute_registry", "migration.sql");
    const postgres = path.join(
      prismaDir,
      "migrations-postgres",
      "20261011000000_add_statute_registry",
      "migration.sql",
    );
    expect(existsSync(sqlite)).toBe(true);
    expect(existsSync(postgres)).toBe(true);
    for (const file of [sqlite, postgres]) {
      const sql = readFileSync(file, "utf8");
      // Both `CREATE TABLE "X"` and Prisma's `CREATE TABLE IF NOT EXISTS "X"`
      // appear in this repo's shipped sets, so assert the creation itself
      // rather than one spacing of it.
      for (const table of ["StatuteSource", "StatuteNotification", "StatutoryRule", "StatutoryRuleVersion"]) {
        expect(new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`).test(sql)).toBe(true);
      }
    }
  });

  it("the two sets do not drift apart in table coverage", () => {
    const tablesIn = (dir: string) => {
      let sql = "";
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const file = path.join(dir, entry.name, "migration.sql");
          if (existsSync(file)) sql += readFileSync(file, "utf8");
        }
      }
      // Match real table creations only: quoted-or-bare identifiers, and not
      // Prisma's `new_X` rebuild intermediates nor the `IF` in
      // `CREATE TABLE IF NOT EXISTS`.
      return new Set(
        [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)]
          .map((m) => m[1] ?? m[2])
          .filter((t): t is string => !!t && !t.startsWith("new_")),
      );
    };
    const sqliteTables = tablesIn(path.join(prismaDir, "migrations-sqlite"));
    const postgresTables = tablesIn(path.join(prismaDir, "migrations-postgres"));
    const missingInPostgres = [...sqliteTables].filter((t) => !postgresTables.has(t));
    expect(missingInPostgres).toEqual([]);
  });
});

/**
 * Migration contract for the health endpoint's readiness gate (ROADMAP 5.5).
 *
 * The blessed Postgres deploy runs `prisma migrate deploy` in a dedicated
 * init step BEFORE app replicas start. Readiness asks: "has this database
 * reached the schema the code ships with?" — answered by counting applied
 * migrations and comparing with the count of migration directories in the
 * repo. Adding a migration folder is the deployment contract: the new build
 * expects at least that many applied migrations before it serves traffic.
 *
 * Layout: the shipped sets live in `prisma/migrations-sqlite/` and
 * `prisma/migrations-postgres/`; `scripts/switch-provider.mjs` copies the
 * matching set into `prisma/migrations/` (what Prisma reads and what ships
 * in build artifacts). The counter therefore reads prisma/migrations/ when
 * present, falling back to whichever shipped set matches the schema's
 * provider — so the gate works on dev machines AND in built images.
 *
 * Counting directories (not reading migration_lock) keeps this
 * dependency-free and honest: rls.sql / baselines under prisma/ that are not
 * migration directories are never miscounted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Number of migration directories for the active provider. */
export function expectedMigrations(): number {
  const dir = path.join(process.cwd(), "prisma", "migrations");
  if (existsSync(dir)) return countMigrations(dir);
  return countMigrations(shippedSetDir());
}

/** The provider-scoped set dir matching the schema's datasource provider. */
function shippedSetDir(): string {
  let provider = "sqlite";
  try {
    const schema = readdirSchema();
    const match = /provider\s*=\s*"(sqlite|postgresql)"/.exec(schema);
    if (match) provider = match[1] as string;
  } catch {
    // schema unreadable: fall back to the sqlite default set
  }
  return path.join(process.cwd(), "prisma", `migrations-${provider}`);
}

function readdirSchema(): string {
  return readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
}

function countMigrations(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

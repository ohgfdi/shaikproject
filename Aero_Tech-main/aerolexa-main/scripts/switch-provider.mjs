#!/usr/bin/env node
/**
 * Switch the Prisma datasource provider between SQLite (default, zero-setup
 * local dev) and PostgreSQL (deployments, docker-compose) — AND install the
 * matching migration set, so `prisma migrate deploy` works for both
 * providers out of the box.
 *
 *   npm run switch:postgres   # provider → postgresql + migrations-postgres/ installed + client regenerated
 *   npm run switch:sqlite     # provider → sqlite + migrations-sqlite/ installed + client regenerated
 *
 * Migration sets live in provider-scoped directories:
 *
 *   prisma/migrations-sqlite/    21 incremental migrations, sqlite dialect,
 *                                migration_lock.toml = sqlite
 *   prisma/migrations-postgres/  1 idempotent baseline (whole schema from
 *                                migrate diff), migration_lock.toml = postgresql
 *
 * `switch-provider` copies the matching set into prisma/migrations/ (the
 * directory Prisma reads). The check in migrateSettingsContract():
 *
 *   - a lock that disagrees with the schema provider fails the build —
 *     Prisma would otherwise hard-error mid-deploy;
 *   - a migration dir NOT matching the current provider (e.g. leftover
 *     postgres baseline while provider is sqlite) fails loudly with the fix.
 *
 * See migrateSettingsContract() for the exact contract tests.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "prisma", "schema.prisma");
const schema = readFileSync(schemaPath, "utf8");
const migrationsDir = path.join(root, "prisma", "migrations");
const sets = {
  sqlite: path.join(root, "prisma", "migrations-sqlite"),
  postgresql: path.join(root, "prisma", "migrations-postgres"),
};

const target = process.argv[2];
if (target !== "sqlite" && target !== "postgresql") {
  console.error("Usage: node scripts/switch-provider.mjs <sqlite|postgresql>");
  process.exit(1);
}

const current = /provider\s*=\s*"(sqlite|postgresql)"/.exec(schema)?.[1];
if (!current) {
  console.error("Could not locate the datasource provider in prisma/schema.prisma.");
  process.exit(1);
}

// Guard against clobbering a hand-edited migrations/ directory: the
// source-of-truth sets live in migrations-sqlite/ and migrations-postgres/.
const lockPath = path.join(migrationsDir, "migration_lock.toml");
if (existsSync(lockPath)) {
  const lockProvider = /provider\s*=\s*"(sqlite|postgresql)"/.exec(readFileSync(lockPath, "utf8"))?.[1];
  const setMatchesCurrentLock = lockProvider === current;
  const setIsShipped = lockProvider && existsSync(sets[lockProvider]);
  if (!setMatchesCurrentLock || !setIsShipped) {
    console.error(
      `prisma/migrations/ does not match a shipped migration set (lock provider: ${lockProvider ?? "unknown"}).\n` +
        `Refusing to overwrite a hand-maintained migration history. If it is stale, delete it and re-run:\n` +
        `  rm -rf prisma/migrations && npm run switch:${target === "sqlite" ? "sqlite" : "postgres"}`,
    );
    process.exit(1);
  }
}

// 1) Flip the schema provider.
if (current === target) {
  console.log(`Datasource is already "${target}". Ensuring the matching migration set is installed…`);
} else {
  const next = schema.replace(/(provider\s*=\s*)"(sqlite|postgresql)"/, `$1"${target}"`);
  writeFileSync(schemaPath, next);
  console.log(`Switched datasource provider: ${current} → ${target}`);
}

// 2) Install the matching migration set (clean replace — the shipped sets are
//    the source of truth; prisma/migrations/ is generated).
if (existsSync(migrationsDir)) rmSync(migrationsDir, { recursive: true });
mkdirSync(migrationsDir, { recursive: true });
cpSync(sets[target], migrationsDir, { recursive: true });
console.log(
  `Installed migration set: prisma/migrations-${target === "sqlite" ? "sqlite" : "postgres"}/ → prisma/migrations/`,
);

// 3) Regenerate the client (per-provider).
execFileSync("npx", ["prisma", "generate"], { cwd: root, stdio: "inherit" });

if (target === "postgresql") {
  console.log("\nPostgreSQL is ready for fresh installs:");
  console.log("  point DATABASE_URL at an empty database, then:");
  console.log("    npm run db:deploy          # applies migrations-postgres/ via prisma migrate deploy");
  if (spawnSync("docker", ["--version"]).status === 0) {
    console.log("  or verify the whole loop right now with: npm run drill:backup");
  }
}

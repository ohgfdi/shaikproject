// Prisma CLI configuration (Prisma ORM 7+).
//
// Prisma 7 stopped loading .env files by itself and moved the connection
// string out of the schema's `datasource` block, so the CLI is configured
// here instead. `dotenv/config` must be the first import so DATABASE_URL is
// populated before the URL is read.
//
// NOTE: this file intentionally does NOT name a migrations path per provider.
// scripts/switch-provider.mjs swaps the whole prisma/migrations/ directory
// between the shipped migrations-sqlite/ and migrations-postgres/ sets, so the
// default path below is correct for whichever provider the schema declares.
import "dotenv/config";
import { defineConfig } from "prisma/config";

import { sqliteFilePath } from "./lib/db-url";

/**
 * Prisma Migrate takes the URL as-is for server databases, but a relative
 * SQLite `file:` path must keep resolving against prisma/ (the Prisma 6 base)
 * now that the URL lives in this root-level config file.
 *
 * Two consumers, two requirements:
 *  - the RUNTIME adapter (lib/db.ts) wants the bare filesystem path —
 *    better-sqlite3 opens files, it does not parse URLs;
 *  - the CLI (this config) wants a real connection URL — its parser rejects
 *    scheme-less paths with P1013 "the scheme is not recognized".
 *
 * So: resolve to an absolute path via sqliteFilePath (pins the prisma/ base),
 * then re-prefix `file:` for the CLI. Empty stays empty so `prisma generate`
 * (postinstall, Docker builder) keeps working with no DATABASE_URL.
 */
function datasourceUrl(raw: string): string {
  if (!raw) return raw;
  // Pass through non-SQLite URLs (PostgreSQL, MySQL, MongoDB) as-is.
  // The Prisma CLI needs a real connection URL — no `file:` prefix.
  if (raw.startsWith("postgres") || raw.startsWith("mysql") || raw.startsWith("mongodb")) return raw;
  // For SQLite, resolve to an absolute path and re‑prefix `file:` for the CLI.
  const resolved = sqliteFilePath(raw === ":memory:" ? "file::memory:" : raw);
  return `file:${resolved}`;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Prisma 7 no longer auto-runs the seed after `migrate dev`/`migrate reset`.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Deliberately process.env and NOT prisma/config's env() helper: env() throws
    // when the variable is absent, and every CLI command loads this file —
    // including `prisma generate`, which runs from postinstall and from the
    // Dockerfile builder stage where no DATABASE_URL exists. `prisma generate`
    // never needs the URL, so it must not be required to resolve one.
    url: datasourceUrl(process.env.DATABASE_URL ?? ""),
  },
});

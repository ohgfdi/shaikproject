import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { isNextBuild } from "@/lib/build-phase";
import { sqliteFilePath } from "@/lib/db-url";

/**
 * Prisma client singleton. In development, hot reload would otherwise create a
 * new pool per module evaluation. This module is server-only by convention —
 * never import it from a client component (the Next.js `server-only` package
 * guard is enforced via the import boundary in lib/server.ts).
 *
 * Prisma 7 requires an explicit driver adapter for every database, so the
 * adapter is chosen here from DATABASE_URL. That mirrors the single-schema,
 * two-provider setup: `npm run switch:postgres` / `switch:sqlite` flips the
 * schema's provider and the matching migration set, and DATABASE_URL picks the
 * matching adapter at boot. Keep this in step with isPostgres() in
 * lib/server/tenancy.ts, which sniffs the same variable.
 */
function createAdapter(): PrismaBetterSqlite3 | PrismaPg {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    // Prisma 7 talks to node-pg rather than the Rust engine, so pool and SSL
    // defaults come from pg itself and differ from v6: no connection timeout
    // (v6 used 5s) and certificates are now verified. Restore the v6 timeout,
    // and keep v6's "ignore invalid certificates" behaviour so the upgrade is
    // not also an outage. Set DATABASE_SSL_REJECT_UNAUTHORIZED=true (plus
    // NODE_EXTRA_CA_CERTS or `node --use-openssl-ca`) to verify properly.
    const verifyCerts = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === "true";
    return new PrismaPg({
      connectionString: url,
      connectionTimeoutMillis: numEnv("DATABASE_POOL_CONNECT_TIMEOUT_MS", 5_000),
      ssl: sslConfig(url, verifyCerts),
      max: numEnv("DATABASE_POOL_MAX", 10),
      // Idle connections are returned to the pool rather than held open for
      // the life of the process, and keepAlive stops PgBouncer/pgpool in front
      // of the database from dropping a connection that is about to be reused
      // (the classic "server closed the connection unexpectedly" under an
      // idle-then-reuse pattern).
      idleTimeoutMillis: numEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      keepAlive: true,
      // A runaway analytics query (a full scan over a large dataset, a cartesian
      // join) would otherwise hold a pooled connection indefinitely and starve
      // every other request. Cap it at the server side. pg spells this
      // `statement_timeout` (snake_case, and it maps to the server's GUC).
      statement_timeout: numEnv("DATABASE_STATEMENT_TIMEOUT_MS", 30_000),
    });
  }
  return new PrismaBetterSqlite3({ url: sqliteFilePath(url) });
}

/**
 * SSL settings for a Postgres connection string.
 *
 * The URL is the single source of truth so the local/dev paths work: the
 * documented `docker compose --profile pg` database (and every test suite)
 * speaks plaintext and passes `sslmode=disable`, which must mean "no TLS"
 * rather than "TLS anyway, then fail". A managed database should pass
 * `sslmode=require` (or `verify-full`), and that is what turns TLS on.
 *
 * With no `sslmode` at all, TLS stays on — the previous behaviour — so an
 * existing production URL is not downgraded by this change.
 */
function sslConfig(url: string, verifyCerts: boolean): false | { rejectUnauthorized: boolean } {
  const mode = new URL(url).searchParams.get("sslmode");
  if (mode === "disable" || mode === "allow") return false;
  return { rejectUnauthorized: verifyCerts || mode === "verify-ca" || mode === "verify-full" };
}

/** Parse a positive-integer env var, falling back when unset or malformed. */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** SQLite is for development only; in production we require PostgreSQL. */
enforceProductionDatabase();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: createAdapter(),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Ensures SQLite is never used in production. Exits loudly if DATABASE_URL
 * points at SQLite.
 *
 * `next build` also runs under NODE_ENV=production and imports every server
 * module to collect page data and prerender, so a build against a development
 * database would hit this gate even though nothing is being served. The check
 * belongs to a *running* server (`next start` / Docker), so the build phase is
 * exempt: a build host is not a deployment.
 */
function enforceProductionDatabase(): void {
  if (isNextBuild()) return;
  const url = process.env.DATABASE_URL ?? "";
  const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");
  const isSqlite = url.startsWith("sqlite://") || (!isPostgres && url.includes(".db"));
  if (process.env.NODE_ENV === "production" && isSqlite) {
    console.error("FATAL: SQLite is not supported in production. Set DATABASE_URL to a PostgreSQL connection string.");
    process.exit(1);
  }
}

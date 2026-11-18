/**
 * Connection-URL helpers shared by the Prisma CLI (prisma.config.ts) and the
 * runtime client (lib/db.ts).
 *
 * Prisma 7 requires an explicit driver adapter, and the adapters take a raw
 * driver path rather than a Prisma `file:` URL. It also moved the URL out of
 * prisma/schema.prisma and into prisma.config.ts at the project root, which
 * changes how a *relative* SQLite path is interpreted: Prisma 6 resolved
 * `file:../data/aerolexa.db` against the schema's own directory (prisma/),
 * so it landed in <root>/data. Resolving against the project root instead
 * would point one level above the repo and silently open the wrong database.
 *
 * `sqliteFilePath` pins that behaviour to the Prisma 6 base so the CLI and the
 * runtime client always open the same file, whatever the URL looks like.
 */

import path from "node:path";


/** Directory Prisma 6 resolved relative SQLite paths against: prisma/. */
const SQLITE_URL_BASE = path.join(process.cwd(), "prisma");

/**
 * Convert a Prisma connection URL into a filesystem path that better-sqlite3
 * can open. Absolute paths, Windows drive paths and `:memory:` pass through
 * unchanged; `file:`-prefixed relative paths are resolved against `prisma/`.
 */
export function sqliteFilePath(url: string): string {
  if (!url || url === ":memory:") return url;
  const withoutScheme = url.startsWith("file:") ? url.slice("file:".length) : url;
  if (path.isAbsolute(withoutScheme) || /^[a-zA-Z]:[\\/]/.test(withoutScheme)) {
    return withoutScheme;
  }
  return path.resolve(SQLITE_URL_BASE, withoutScheme);
}

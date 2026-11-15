import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Schema-drift gate.
 *
 * The app calls Prisma delegates (`prisma.gstInvoice`, `prisma.tdsEntry`, …)
 * for models that no migration ever created, so a freshly migrated database
 * was missing 35 tables and those requests died with P2021 ("no such table").
 * Because CI mocks Prisma in most unit suites and the API suite boots against
 * a database that had accumulated the tables, nothing failed — which is
 * exactly how drift survives a green build.
 *
 * This test is the guard: every `model` in prisma/schema.prisma must have a
 * matching `CREATE TABLE` in BOTH shipped migration sets (SQLite and
 * PostgreSQL), and the generated `prisma/migrations/` directory must stay in
 * sync with the SQLite set it is copied from.
 */

const prismaDir = path.join(process.cwd(), "prisma");
const schemaPath = path.join(prismaDir, "schema.prisma");

/** Model names declared in the schema (honours `@@map` table aliases). */
function schemaModels(): Array<{ model: string; table: string }> {
  const src = readFileSync(schemaPath, "utf8");
  const blocks = src.split(/^\s*model\s+/m).slice(1);
  const out: Array<{ model: string; table: string }> = [];
  for (const block of blocks) {
    const nameMatch = /^([A-Za-z0-9_]+)\s*\{/.exec(block);
    if (!nameMatch) continue;
    const model = nameMatch[1] as string;
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(block);
    out.push({ model, table: mapMatch ? (mapMatch[1] as string) : model });
  }
  return out;
}

/** Table names a migration set creates (ignores indexes/renames). */
function tablesCreatedIn(dir: string): Set<string> {
  const tables = new Set<string>();
  if (!existsSync(dir)) return tables;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, "utf8");
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      // Skip Prisma's temporary rebuild shadow tables; they are renamed in the
      // same migration and must not mask a genuinely missing real table.
      const name = m[1] as string;
      if (name.startsWith("new_")) continue;
      tables.add(name);
    }
  }
  return tables;
}

const models = schemaModels();

describe("schema ↔ migration drift gate", () => {
  test("the schema actually declares models (sanity)", () => {
    expect(models.length).toBeGreaterThan(50);
  });

  test("every model has a CREATE TABLE in the SQLite migration set", () => {
    const tables = tablesCreatedIn(path.join(prismaDir, "migrations-sqlite"));
    const missing = models.filter((m) => !tables.has(m.table)).map((m) => m.model);
    expect(missing).toEqual([]);
  });

  test("every model has a CREATE TABLE in the PostgreSQL migration set", () => {
    const tables = tablesCreatedIn(path.join(prismaDir, "migrations-postgres"));
    const missing = models.filter((m) => !tables.has(m.table)).map((m) => m.model);
    expect(missing).toEqual([]);
  });

  test("the active prisma/migrations directory matches its shipped source set", () => {
    const activeDir = path.join(prismaDir, "migrations");
    if (!existsSync(activeDir)) return; // nothing installed
    const schema = readFileSync(schemaPath, "utf8");
    const provider = /provider\s*=\s*"(sqlite|postgresql)"/.exec(schema)?.[1] ?? "sqlite";
    // A switch-provider round-trip copies the shipped set over the active one.
    // When a hand-added migration exists only in the active dir (and not in its
    // shipped source), the copy silently deletes the fix an existing database
    // already applied — which is how the FK rebuild was lost.
    const shipped = path.join(prismaDir, provider === "postgresql" ? "migrations-postgres" : `migrations-${provider}`);
    const names = (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    expect(names(activeDir)).toEqual(names(shipped));
  });
});

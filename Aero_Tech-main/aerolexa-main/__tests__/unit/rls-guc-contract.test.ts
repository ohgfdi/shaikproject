/**
 * RLS GUC contract — every key a policy reads, the context helper must set.
 *
 * This exists because the two drifted silently: the shipped policies read four
 * GUCs (`app.tenant_id`, `app.current_workspace`, `app.current_organization`,
 * `app.current_user`) while `withTenantContext()` set three, omitting
 * `app.tenant_id` — which 30 policies compare against. Wrapping the query layer
 * and enabling RLS would then have hidden every row on those tables instead of
 * failing loudly: exactly the deception the RLS rollout is meant to prevent.
 *
 * The assertion is structural, so it keeps holding when new policies land: add a
 * policy that reads a new key and this test names it before anyone can turn RLS
 * on against an unset GUC.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SET_CONFIG = /set_config\(\s*'(app\.[a-z_]+)'/g;
const CURRENT_SETTING = /current_setting\(\s*'(app\.[a-z_]+)'/g;

function readIfExists(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function matches(content: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) found.add(match[1]!);
  return found;
}

/** Every policy-bearing SQL file: the canonical one plus both provider sets. */
function policySql(): string {
  const files = ["prisma/rls.sql"];
  for (const dir of ["prisma/migrations", "prisma/migrations-postgres", "prisma/migrations-sqlite"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name, "migration.sql"));
    } catch {
      continue;
    }
    files.push(...entries);
  }
  return files.map(readIfExists).join("\n");
}

describe("RLS GUC contract", () => {
  const policyKeys = matches(policySql(), CURRENT_SETTING);
  const canonical = readIfExists("lib/server/tenancy.ts");
  const primitive = readIfExists("lib/server/tenant-db.ts");
  const canonicalKeys = matches(canonical, SET_CONFIG);
  const primitiveKeys = matches(primitive, SET_CONFIG);

  it("finds the policies and the helpers (guards against a rename that hides this test)", () => {
    expect(policyKeys.size).toBeGreaterThan(0);
    expect(canonicalKeys.size).toBeGreaterThan(0);
    expect(primitiveKeys.size).toBeGreaterThan(0);
  });

  it("withTenantContext() sets every GUC any shipped policy reads", () => {
    const missing = [...policyKeys].filter((key) => !canonicalKeys.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("the fail-closed primitive sets every GUC any shipped policy reads", () => {
    const missing = [...policyKeys].filter((key) => !primitiveKeys.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("refuses a missing tenant id instead of querying all rows", async () => {
    const { withTenantContext } = await import("@/lib/server/tenancy");
    await expect(
      withTenantContext({ workspaceId: "", organizationId: null, userId: "user-1" }, async () => "unreachable"),
    ).rejects.toThrow(/without a workspaceId/);
  });
});

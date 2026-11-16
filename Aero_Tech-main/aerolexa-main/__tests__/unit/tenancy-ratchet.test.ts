/**
 * Tenancy ratchet — the gap may shrink, never grow.
 *
 * Wrapping the remaining 163 tenant files in withTenantContext() is a multi-week refactor.
 * Until it lands, DB-level RLS stays off, and every new endpoint that queries
 * Prisma directly would add another place where the isolation story depends on
 * someone remembering a guard.
 *
 * This test holds the measured count to the shipped baseline. Adding an
 * unwrapped tenant file fails CI and forces a conscious choice: wrap it, or
 * raise the baseline in the same PR and say why.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { RLS_UNWRAPPED_BASELINE } from "@/lib/server/rls-status";
import { auditTenantAccess, type SourceFile } from "@/lib/server/tenancy-audit";

const ROOTS = ["app", "lib/server"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "generated", ".next"].includes(entry.name)) continue;
      out.push(...walk(full));
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe("tenant wiring ratchet", () => {
  it("does not add unwrapped tenant files beyond the shipped baseline", () => {
    const files: SourceFile[] = ROOTS.flatMap((root) => {
      const resolved = path.resolve(process.cwd(), root);
      try {
        return walk(resolved).map((file) => ({
          path: path.relative(process.cwd(), file),
          content: readFileSync(file, "utf8"),
        }));
      } catch {
        return [];
      }
    });

    const audit = auditTenantAccess(files);
    expect(RLS_UNWRAPPED_BASELINE).toBeGreaterThan(0);
    // Equal or lower is fine. A higher count means a new direct Prisma access
    // path on a tenant model — wrap it, or justify a baseline bump in the PR.
    expect(audit.unwrappedFiles).toBeLessThanOrEqual(RLS_UNWRAPPED_BASELINE);
    expect(audit.tenantFiles).toBeGreaterThanOrEqual(audit.unwrappedFiles);
  });
});

/**
 * Tenancy wiring audit.
 *
 *   npm run tenancy:audit
 *   npm run tenancy:audit -- --strict   # exit 1 until every tenant file is wrapped
 *
 * The default run is informational and exits 0. It exits 1 when RLS is actually
 * requested (RLS_ENABLED=true) while unwrapped tenant files remain — that is the
 * configuration that hides every row.
 */

import "dotenv/config";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { RLS_UNWRAPPED_BASELINE } from "../lib/server/rls-status";
import { auditTenantAccess, type SourceFile } from "../lib/server/tenancy-audit";

const ROOTS = ["app", "lib/server"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated" || entry.name === ".next") continue;
      out.push(...walk(full));
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

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
const top = [...audit.findings]
  .filter((finding) => !finding.wrapped)
  .sort((a, b) => b.models.length - a.models.length)
  .slice(0, 15);

process.stdout.write(
  [
    audit.summary,
    `Files scanned: ${audit.filesScanned}`,
    `Tenant files:  ${audit.tenantFiles}`,
    `Unwrapped:     ${audit.unwrappedFiles} (baseline ${RLS_UNWRAPPED_BASELINE})`,
    `Exempt:        ${audit.exemptFiles.length} declared global aggregate(s)`,
    ...audit.exemptFiles.map((file) => `  ${file}`),
    "",
    "Largest unwrapped files:",
    ...top.map((finding) => `  ${finding.path} (${finding.models.join(", ")})`),
    "",
  ].join("\n"),
);

const strict = process.argv.includes("--strict");
const rlsRequested = process.env.RLS_ENABLED === "true";

// Ratchet: the gap may shrink as files are wrapped, never grow. A new direct
// tenant query should be wrapped (or the baseline raised deliberately).
if (audit.unwrappedFiles > RLS_UNWRAPPED_BASELINE) {
  process.stderr.write(
    `Tenancy regression: ${audit.unwrappedFiles} unwrapped tenant files, baseline is ${RLS_UNWRAPPED_BASELINE}. ` +
      "Wrap the new direct Prisma access path, or raise RLS_UNWRAPPED_BASELINE with a reason.\n",
  );
  process.exitCode = 1;
}

if ((strict || rlsRequested) && !audit.ready) {
  process.stderr.write(
    rlsRequested
      ? "RLS_ENABLED=true while tenant queries are unwrapped: this would hide every row. Unset it, then wrap the files above.\n"
      : "Strict mode: tenant files still bypass withTenantContext().\n",
  );
  process.exitCode = 1;
}

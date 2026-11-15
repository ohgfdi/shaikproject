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
    `Unwrapped:     ${audit.unwrappedFiles}`,
    "",
    "Largest unwrapped files:",
    ...top.map((finding) => `  ${finding.path} (${finding.models.join(", ")})`),
    "",
  ].join("\n"),
);

const strict = process.argv.includes("--strict");
const rlsRequested = process.env.RLS_ENABLED === "true";

if ((strict || rlsRequested) && !audit.ready) {
  process.stderr.write(
    rlsRequested
      ? "RLS_ENABLED=true while tenant queries are unwrapped: this would hide every row. Unset it, then wrap the files above.\n"
      : "Strict mode: tenant files still bypass withTenantContext().\n",
  );
  process.exitCode = 1;
}

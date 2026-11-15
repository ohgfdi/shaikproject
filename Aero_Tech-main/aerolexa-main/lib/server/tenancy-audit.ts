/**
 * Tenancy wiring audit.
 *
 * RLS can only be enabled when every tenant-scoped query runs inside
 * withTenantContext(). This audit is deliberately conservative: a file counts
 * as wrapped only when it contains an actual `withTenantContext(` call. A file
 * that mixes wrapped and direct queries is still reported as unwrapped, because
 * a partial wrap is exactly how a cross-tenant read slips through.
 */

import { TENANT_MODELS } from "./rls-status";

export interface SourceFile {
  path: string;
  content: string;
}

export interface TenantAccessFinding {
  path: string;
  models: string[];
  wrapped: boolean;
}

export interface TenancyAudit {
  filesScanned: number;
  tenantFiles: number;
  unwrappedFiles: number;
  modelCounts: Record<string, number>;
  findings: TenantAccessFinding[];
  /** True only when tenant files exist and none is unwrapped. */
  ready: boolean;
  summary: string;
}

const TENANT_MODEL_SET = new Set(TENANT_MODELS);

/** All tenant-model accessors used in one source file. */
export function tenantModelsIn(content: string, prefixes: readonly string[] = ["prisma", "tx"]): string[] {
  const found = new Set<string>();
  for (const prefix of prefixes) {
    const pattern = new RegExp(`\\b${prefix}\\.([A-Za-z0-9_]+)\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const model = match[1]!;
      if (TENANT_MODEL_SET.has(model)) found.add(model);
    }
  }
  return [...found].sort();
}

export function auditTenantAccess(files: SourceFile[]): TenancyAudit {
  const findings: TenantAccessFinding[] = [];
  const modelCounts: Record<string, number> = {};

  for (const file of files) {
    const models = tenantModelsIn(file.content);
    if (models.length === 0) continue;
    for (const model of models) modelCounts[model] = (modelCounts[model] ?? 0) + 1;
    // A direct `prisma.<tenantModel>` call is unwrapped even when the same file
    // also calls withTenantContext() for other queries: partial wrapping is how
    // a cross-tenant read slips through.
    const direct = tenantModelsIn(file.content, ["prisma"]);
    findings.push({
      path: file.path,
      models,
      wrapped:
        (file.content.includes("withTenantContext(") ||
          file.content.includes("withTenantDb(") ||
          file.content.includes("withUserContext(")) &&
        direct.length === 0,
    });
  }

  const unwrapped = findings.filter((finding) => !finding.wrapped);
  return {
    filesScanned: files.length,
    tenantFiles: findings.length,
    unwrappedFiles: unwrapped.length,
    modelCounts,
    findings: findings.sort((a, b) => a.path.localeCompare(b.path)),
    ready: findings.length > 0 && unwrapped.length === 0,
    summary:
      findings.length === 0
        ? "No tenant-model access was found; the audit found nothing to certify."
        : unwrapped.length === 0
          ? `${findings.length} tenant file(s) call withTenantContext()/withTenantDb(); re-check before enabling RLS.`
          : `${unwrapped.length} of ${findings.length} tenant file(s) access tenant models without withTenantContext() or withTenantDb(). Keep RLS_ENABLED=false until this reaches zero.`,
  };
}

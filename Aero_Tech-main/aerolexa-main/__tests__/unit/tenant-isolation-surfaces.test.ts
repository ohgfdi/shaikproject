/**
 * Cross-tenant read surfaces — source-gated contract test.
 *
 * `rls-query-paths.test.ts` pins the dataset chokepoint. This suite pins the
 * OTHER half of the isolation story: every workspace-scoped list/search/export
 * must carry the caller's workspace in its own WHERE clause, and the one export
 * that once leaked every tenant (an empty `where` when a user had no workspace)
 * must stay fixed.
 *
 * These are source contracts on purpose: the repo's Prisma layer is mocked in
 * unit runs, so a behaviour test would prove the mock. A refactor that drops the
 * scope now fails here before it can ship.
 */

import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");

describe("dataset read surfaces", () => {
  const SQL_LAB = "app/api/datasets/[id]/query/route.ts";

  it("SQL Lab reaches rows only through the shared query helper", () => {
    const route = read(SQL_LAB);
    expect(route).toContain("runQueryOnDatasets(");
    expect(route).not.toContain("loadParsedDataset(");
  });

  it.each([
    "app/api/datasets/[id]/rows/route.ts",
    "app/api/datasets/[id]/values/route.ts",
    "app/api/datasets/[id]/whatif/route.ts",
    "app/api/datasets/[id]/insights/route.ts",
    "app/api/datasets/[id]/export/xlsx/route.ts",
    "app/api/notebooks/[id]/run/route.ts",
    "app/api/training/route.ts",
    "app/api/advisor/route.ts",
    "app/api/copilot/route.ts",
    "app/api/studio/route.ts",
  ])("%s filters through dataset-access", (path) => {
    expect(read(path)).toContain("dataset-access");
  });

  it("row security resolves rules from the dataset OWNER's workspace", () => {
    const source = read("lib/server/dataset-access.ts");
    expect(source).toContain("loadRlsRules(dataset.workspaceId)");
    // The caller's workspace is the wrong scope for a shared project.
    expect(source).not.toContain("loadRlsRules(ctx.workspace.id)");
  });
});

describe("catalog search", () => {
  it("scopes every model query to the caller's workspace", () => {
    const source = read("app/api/search/route.ts");
    const queries = (source.match(/findMany\(/g) ?? []).length;
    const whereScoped = (source.match(/where: \{ workspaceId: ctx\.workspace\.id/g) ?? []).length;
    // Model list: projects, datasets, analyses, insights, notebooks, models,
    // prompts, dashboards, reports, presentations. A new model added without a
    // workspace filter changes these two numbers and fails here.
    expect(queries).toBe(10);
    expect(whereScoped).toBe(queries);
    expect(source).not.toContain("where: {}");
  });
});

describe("audit trail export", () => {
  it("is workspace-scoped and gated as the Firm governance export", () => {
    const source = read("app/api/audit/export/route.ts");
    expect(source).toContain("workspaceId: ctx.workspace.id");
    expect(source).toContain('requirePlanFeature(ctx.workspace.id, "auditExport"');
  });
});

describe("DPDP portability bundle", () => {
  it("never falls back to an empty WHERE clause", () => {
    const source = read("lib/server/portability.ts");
    expect(source).toContain("function wsScope");
    // A user without a personal workspace gets nothing, not every row.
    expect(source).toContain('{ id: "__no_workspace__" }');
    // The helper itself must fall back to the match-nothing scope. (The doc
    // comment quotes the old broken expression, so match the return, not prose.)
    expect(source).toMatch(/return workspaceId \? \{ workspaceId \} : \{ \.\.\.NO_WORKSPACE \};/);
  });
});

describe("isolation posture", () => {
  it("health reports the RLS posture and the flag stays truthful", () => {
    expect(read("app/api/health/route.ts")).toContain("rlsPosture");
    expect(read("lib/server/rls-status.ts")).toContain("RLS_QUERY_LAYER_WIRED = false");
  });
});

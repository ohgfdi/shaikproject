/**
 * Publish authorization tests (SEC-2).
 *
 * The defect: reports/dashboards publish routes ran the OWNER check only when
 * `artifact.projectId` was set. A projectless artifact therefore skipped the
 * check entirely — any authenticated member could flip `accessMode: "public"`
 * on someone else's report/dashboard, and a cross-workspace caller fell
 * through every check too (no workspace scoping at all).
 *
 * The fix is the shared requirePublishRole guard. The full behavior matrix
 * (two workspaces, projectless vs project, creator vs member vs outsider)
 * runs against a real DB in the API integration suite; these source-gated
 * tests pin the wiring so the guard cannot be silently dropped again.
 */
import { readFileSync } from "node:fs";

const MEMBERS_SRC = readFileSync(`${process.cwd()}/lib/server/members.ts`, "utf8");
const REPORT_SRC = readFileSync(`${process.cwd()}/app/api/reports/[id]/publish/route.ts`, "utf8");
const DASHBOARD_SRC = readFileSync(`${process.cwd()}/app/api/dashboards/[id]/publish/route.ts`, "utf8");
const NOTEBOOK_SRC = readFileSync(`${process.cwd()}/app/api/notebooks/[id]/publish/route.ts`, "utf8");

describe("publish authz — the shared guard (SEC-2)", () => {
  it("requirePublishRole exists and enforces workspace scoping with a 404 (no existence leak)", () => {
    expect(MEMBERS_SRC).toContain("export async function requirePublishRole(");
    // Cross-workspace callers get notFoundError, never forbiddenError.
    const guard = MEMBERS_SRC.slice(MEMBERS_SRC.indexOf("requirePublishRole("));
    expect(guard).toContain("notFoundError(`${label} not found.`)");
    expect(guard).toContain("row.workspaceId !== ctx.workspace.id");
  });

  it("projectless artifacts require the CREATOR (the legacy same-workspace OWNER rule is not enough for publish)", () => {
    const guard = MEMBERS_SRC.slice(MEMBERS_SRC.indexOf("requirePublishRole("));
    expect(guard).toContain("row.createdById && row.createdById !== ctx.user.id");
    expect(guard).toContain("workspaceOwner?.user?.id !== ctx.user.id");
  });

  it("project artifacts still resolve through requireProjectRole with OWNER minimum", () => {
    const guard = MEMBERS_SRC.slice(MEMBERS_SRC.indexOf("requirePublishRole("));
    expect(guard).toContain('requireProjectRole(ctx, project, "OWNER")');
  });
});

describe("publish authz — every publish route uses the guard", () => {
  it("reports POST and DELETE both call requirePublishRole (unconditionally, not only when projectId is set)", () => {
    expect(REPORT_SRC.match(/requirePublishRole\(ctx, report, "Report"\)/g)?.length).toBe(2);
    expect(REPORT_SRC).not.toContain("if (report.projectId)");
  });

  it("dashboards POST and DELETE both call requirePublishRole", () => {
    expect(DASHBOARD_SRC.match(/requirePublishRole\(ctx, dashboard, "Dashboard"\)/g)?.length).toBe(2);
    expect(DASHBOARD_SRC).not.toContain("if (dashboard.projectId)");
  });

  it("notebooks: public opt-in goes through the guard; unpublish too; workspace-mode stays EDITOR", () => {
    expect(NOTEBOOK_SRC).toContain('requirePublishRole(ctx, notebook, "Notebook")');
    expect(NOTEBOOK_SRC).toContain('await requireRowRole(ctx, notebook, "EDITOR")');
    // The old ad-hoc OWNER check is replaced by the guard.
    expect(NOTEBOOK_SRC).not.toContain("Only the project owner can enable public access");
  });
});

import { prisma } from "@/lib/db";
import { RLS_QUERY_LAYER_WIRED, TENANT_MODELS } from "@/lib/server/rls-status";
import { auditTenantAccess, tenantModelsIn } from "@/lib/server/tenancy-audit";

describe("tenancy audit", () => {
  it("reports a truthful not-wired status", () => {
    expect(RLS_QUERY_LAYER_WIRED).toBe(false);
    expect(TENANT_MODELS).toContain("filingRollout");
    expect(TENANT_MODELS).toContain("clientPortalAccount");
  });

  it("finds tenant-model accessors and ignores unrelated prisma calls", () => {
    const models = tenantModelsIn(
      "await prisma.engagement.findMany(); await tx.filingRollout.upsert(); await prisma.user.findFirst();",
    );
    expect(models).toEqual(["engagement", "filingRollout"]);
  });

  it("treats a file with any direct tenant query as unwrapped, even if it also wraps some", () => {
    const audit = auditTenantAccess([
      { path: "wrapped.ts", content: "withTenantContext(ctx, (tx) => tx.engagement.findMany())" },
      {
        path: "mixed.ts",
        content: "withTenantContext(ctx, (tx) => tx.engagement.findMany()); await prisma.clientPortalAccount.findMany();",
      },
      { path: "unrelated.ts", content: "await prisma.user.findFirst();" },
    ]);
    expect(audit.tenantFiles).toBe(2);
    expect(audit.unwrappedFiles).toBe(1);
    expect(audit.findings.find((finding) => finding.path === "mixed.ts")?.wrapped).toBe(false);
    expect(audit.ready).toBe(false);
    expect(audit.summary).toContain("1 of 2");
  });

  it("does not certify an empty scan", () => {
    const audit = auditTenantAccess([{ path: "readme.md", content: "no queries" }]);
    expect(audit.ready).toBe(false);
    expect(audit.summary).toContain("nothing to certify");
  });
});

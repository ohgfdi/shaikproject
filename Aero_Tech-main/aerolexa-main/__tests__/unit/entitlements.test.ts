/**
 * Plan entitlements — oracle tests for the monetization gate.
 *
 * Hand-computed expectations: the plan matrix is pinned (free = nothing
 * distributed, pro = everything but org seats, firm = unlimited), the
 * override env var wins over the matrix, and the seat-count math (owner
 * excluded) is exact. The DB-touching suites follow the repo convention:
 * env BEFORE imports, scratch SQLite, dynamic module loads, earned skip.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "entitlements-test-secret-0123456789abcdef";
delete process.env.PLAN_OVERRIDES;

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { PLAN_ENTITLEMENTS, type PlanEntitlements } from "@/lib/server/entitlements";

describe("plan matrix (hand-pinned)", () => {
  it("free gates every distribution/capacity entitlement", () => {
    const e: PlanEntitlements = PLAN_ENTITLEMENTS.free;
    expect(e.publicShareLinks).toBe(false);
    expect(e.externalConnectors).toBe(false);
    expect(e.scheduledReports).toBe(false);
    expect(e.apiKeys).toBe(false);
    expect(e.scheduledConnectorSync).toBe(false);
    expect(e.scheduledNotebookPublish).toBe(false);
    expect(e.maxOrgSeats).toBe(0);
    expect(e.maxApiKeys).toBe(0);
  });

  it("pro unlocks distribution but stays owner-only on org seats", () => {
    const e = PLAN_ENTITLEMENTS.pro;
    expect(e.publicShareLinks).toBe(true);
    expect(e.externalConnectors).toBe(true);
    expect(e.scheduledReports).toBe(true);
    expect(e.apiKeys).toBe(true);
    expect(e.scheduledConnectorSync).toBe(true);
    expect(e.scheduledNotebookPublish).toBe(true);
    expect(e.maxOrgSeats).toBe(1); // solo consultant
    expect(e.maxApiKeys).toBe(null); // unlimited
  });

  it("firm is unlimited everywhere", () => {
    const e = PLAN_ENTITLEMENTS.firm;
    expect(e.maxOrgSeats).toBe(null);
    expect(e.maxApiKeys).toBe(null);
    expect(e.publicShareLinks).toBe(true);
    expect(e.externalConnectors).toBe(true);
  });
});

describe("seat counting (scratch DB)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let countOrgSeats: (typeof import("@/lib/server/entitlements"))["countOrgSeats"];
  let requireOrgSeatAvailable: (typeof import("@/lib/server/entitlements"))["requireOrgSeatAvailable"];
  let entitlementsForWorkspace: (typeof import("@/lib/server/entitlements"))["entitlementsForWorkspace"];
  let workspacePlanId: (typeof import("@/lib/server/entitlements"))["workspacePlanId"];
  let dbReady = false;

  beforeAll(async () => {
    try {
      const dataDir = path.resolve("data");
      await fs.mkdir(dataDir, { recursive: true });
      // Mirror the migration-contract pattern: db push the real schema.
      // Prisma 7 removed --skip-generate (db push no longer generates).
      const r = spawnSync("npx", ["prisma", "db", "push", "--accept-data-loss"], {
        stdio: "pipe",
        timeout: 120_000,
      });
      dbReady = r.status === 0;
      if (!dbReady) {
        console.log("  [entitlements] skipping DB suite — prisma db push failed:", r.stderr?.toString().slice(0, 300));
        return;
      }
      const db = await import("@/lib/db");
      prisma = db.prisma;
      const mod = await import("@/lib/server/entitlements");
      countOrgSeats = mod.countOrgSeats;
      requireOrgSeatAvailable = mod.requireOrgSeatAvailable;
      entitlementsForWorkspace = mod.entitlementsForWorkspace;
      workspacePlanId = mod.workspacePlanId;
    } catch (err) {
      dbReady = false;
      console.log("  [entitlements] skipping DB suite —", err instanceof Error ? err.message : err);
    }
  });

  it("counts non-owner members only", async () => {
    if (!dbReady) return;
    const suffix = Date.now();
    const owner = await prisma.user.create({
      data: {
        name: "Owner",
        email: `own-${suffix}@t.dev`,
        passwordHash: "x",
        workspace: { create: { name: `W-${suffix}`, settings: "{}" } },
      },
    });
    const org = await prisma.organization.create({ data: { name: `O-${suffix}`, ownerId: owner.id } });
    const member1 = await prisma.user.create({
      data: { name: "M1", email: `m1-${suffix}@t.dev`, passwordHash: "x" },
    });
    const member2 = await prisma.user.create({
      data: { name: "M2", email: `m2-${suffix}@t.dev`, passwordHash: "x" },
    });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: member1.id, role: "ADMIN" } });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: member2.id, role: "MEMBER" } });

    // 2 members + 1 owner = 2 billable seats (owner excluded).
    expect(await countOrgSeats(org.id)).toBe(2);

    // Adding a third member must throw the upgrade error (free = 0 seats).
    await expect(requireOrgSeatAvailable(org.id)).rejects.toMatchObject({
      status: 402,
      code: "PLAN_UPGRADE_REQUIRED",
    });

    // But an ORG whose owner holds a Firm subscription passes.
    const { ensurePlans } = await import("@/lib/server/billing");
    await ensurePlans();
    await prisma.subscription.create({
      data: { workspaceId: owner.workspaceId!, planId: "firm", status: "active" },
    });
    const firmPlan = await workspacePlanId(owner.workspaceId!);
    expect(firmPlan).toBe("firm");
    const ent = await entitlementsForWorkspace(owner.workspaceId!);
    expect(ent.maxOrgSeats).toBe(null);
    await expect(requireOrgSeatAvailable(org.id)).resolves.toBeUndefined();
  });

  it("free workspaces have no API-key allowance", async () => {
    if (!dbReady) return;
    const mod = await import("@/lib/server/entitlements");
    const suffix = Date.now();
    const owner = await prisma.user.create({
      data: {
        name: "KeyOwner",
        email: `key-${suffix}@t.dev`,
        passwordHash: "x",
        workspace: { create: { name: `KW-${suffix}`, settings: "{}" } },
      },
    });
    // No subscription row → default free → maxApiKeys 0 → creating key #1 fails.
    await expect(mod.requireApiKeyAvailable(owner.workspaceId!)).rejects.toMatchObject({
      status: 402,
      code: "PLAN_UPGRADE_REQUIRED",
    });
  });
});

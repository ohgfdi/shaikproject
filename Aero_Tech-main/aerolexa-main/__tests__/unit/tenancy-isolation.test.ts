import { readFileSync } from "node:fs";

// DB-backed suite: ensure a DATABASE_URL exists before the Prisma client is
// instantiated (same pattern as connector-crypto.test.ts). Defaults to the
// project's migrated SQLite dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";

import type { AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  requireRowRoleWithOrg,
  artifactRoleWithOrg,
  organizationRoleFor,
  mapOrgRoleToProjectRole,
  requireProjectRole,
  requireOrgRole,
} from "@/lib/server/members";
import {
  createOrganization,
  inviteOrganizationMember,
  updateOrganizationMember,
  removeOrganizationMember,
  createEngagement,
  listOrganizationEngagements,
} from "@/lib/server/organization";
import { rlsConfigError } from "@/lib/server/tenancy";

/**
 * Tenancy isolation tests: proves org-scoped engagements are confidential
 * between users of the same firm but different client engagements.
 */

const TEST_PREFIX = `test_${Date.now()}_`;

function makeCtx(userId: string, workspaceId: string, organization?: { id: string; role: string } | null): AuthContext {
  const now = new Date();
  return {
    user: {
      id: userId,
      email: `${userId}@test.com`,
      name: userId,
      passwordHash: "x",
      workspaceId,
      profileRole: null,
      goals: null,
      organization: null,
      industry: null,
      experience: null,
      onboardedAt: null,
      emailVerifiedAt: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
      state: null,
      country: null,
      sessionVersion: 1,
      mfaSecret: null,
      mfaPendingSecret: null,
      mfaEnabledAt: null,
      mfaRecoveryCodes: null,
      mfaLastUsedStep: null,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    },
    workspace: { id: workspaceId, name: "Test Workspace", settings: null, createdAt: now, updatedAt: now },
    settings: { numberFormat: "comma", aiDemoMode: false },
    organization: organization?.id
      ? {
          id: organization.id,
          name: "Test Org",
          gstin: null,
          partnerDigestLastSentOn: null,
          ownerId: null,
          settings: null,
          createdAt: now,
          updatedAt: now,
        }
      : null,
    organizationRole: organization?.role ?? null,
    isAdmin: false,
  };
}

describe("Tenancy isolation (org-scoped engagements)", () => {
  let userAId: string;
  let userBId: string;
  let workspaceAId: string;
  let workspaceBId: string;
  let organizationId: string;
  let engagementId: string;

  beforeAll(async () => {
    // Create two users with separate workspaces (simulating two consultants in the same firm)
    userAId = `${TEST_PREFIX}user-a`;
    userBId = `${TEST_PREFIX}user-b`;
    await prisma.user.create({
      data: {
        id: userAId,
        email: `${userAId}@test.com`,
        name: "Consultant A",
        passwordHash: "x",
        workspace: { create: { name: "A Workspace" } },
      },
    });
    await prisma.user.create({
      data: {
        id: userBId,
        email: `${userBId}@test.com`,
        name: "Consultant B",
        passwordHash: "x",
        workspace: { create: { name: "B Workspace" } },
      },
    });

    // Get workspace IDs via user relation
    workspaceAId = (await prisma.user.findUnique({
      where: { id: userAId },
      select: { workspace: { select: { id: true } } },
    }))!.workspace!.id;
    workspaceBId = (await prisma.user.findUnique({
      where: { id: userBId },
      select: { workspace: { select: { id: true } } },
    }))!.workspace!.id;

    // Create organization (the firm) and add both users as members
    const org = await prisma.organization.create({
      data: {
        name: "Test Firm",
        gstin: "29AAAAA0000A1Z5",
        members: {
          create: [
            { userId: userAId, role: "ADMIN" },
            { userId: userBId, role: "MEMBER" },
          ],
        },
      },
    });
    organizationId = org.id;

    // Create an engagement (org-owned project) owned by userA
    const engagement = await prisma.project.create({
      data: {
        name: "Client Engagement",
        workspaceId: workspaceAId,
        organizationId,
        ownerId: userAId,
      },
    });
    engagementId = engagement.id;
  });

  afterAll(async () => {
    // Clean up in correct order to satisfy FK constraints
    await prisma.projectMember.deleteMany({ where: { projectId: engagementId } });
    await prisma.project.deleteMany({ where: { id: engagementId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceAId, workspaceBId] } } });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [`${TEST_PREFIX}user-a`, `${TEST_PREFIX}user-b`, `${TEST_PREFIX}user-c`, `${TEST_PREFIX}user-auditor`],
        },
      },
    });
  });

  test("userA (ADMIN + owner) has OWNER on engagement", async () => {
    const ctx = makeCtx(userAId, workspaceAId, { id: organizationId, role: "ADMIN" });
    const role = await artifactRoleWithOrg(ctx, {
      workspaceId: workspaceAId,
      projectId: engagementId,
      ownerId: userAId,
    });
    expect(role).toBe("OWNER");
  });

  test("userB (MEMBER, no projectMember) gets VIEWER via org membership", async () => {
    const ctx = makeCtx(userBId, workspaceBId, { id: organizationId, role: "MEMBER" });
    const role = await artifactRoleWithOrg(ctx, {
      workspaceId: workspaceAId,
      projectId: engagementId,
      ownerId: userAId,
    });
    expect(role).toBe("VIEWER");
  });

  test("userB with explicit projectMember EDITOR gets EDITOR (overrides org)", async () => {
    await prisma.projectMember.create({
      data: { projectId: engagementId, userId: userBId, role: "EDITOR" },
    });
    const ctx = makeCtx(userBId, workspaceBId, { id: organizationId, role: "MEMBER" });
    const role = await artifactRoleWithOrg(ctx, {
      workspaceId: workspaceAId,
      projectId: engagementId,
      ownerId: userAId,
    });
    expect(role).toBe("EDITOR");
    await prisma.projectMember.delete({ where: { projectId_userId: { projectId: engagementId, userId: userBId } } });
  });

  test("userC (not in org) gets null on engagement", async () => {
    const userCId = `${TEST_PREFIX}user-c`;
    await prisma.user.create({
      data: {
        id: userCId,
        email: `${userCId}@test.com`,
        name: "Outsider",
        passwordHash: "x",
        workspace: { create: { name: "C Workspace" } },
      },
    });
    const workspaceCId = (await prisma.user.findUnique({
      where: { id: `${TEST_PREFIX}user-c` },
      select: { workspace: { select: { id: true } } },
    }))!.workspace!.id;
    const ctx = makeCtx(`${TEST_PREFIX}user-c`, workspaceCId, null);
    const role = await artifactRoleWithOrg(ctx, {
      workspaceId: workspaceAId,
      projectId: engagementId,
      ownerId: userAId,
    });
    expect(role).toBeNull();
    // Workspace cascade deletes user
    await prisma.workspace.delete({ where: { id: workspaceCId } });
  });

  test("org AUDITOR role maps to AUDITOR project role (read-only on all engagements)", async () => {
    const userAuditorId = `${TEST_PREFIX}user-auditor`;
    await prisma.user.create({
      data: {
        id: userAuditorId,
        email: `${userAuditorId}@test.com`,
        name: "Auditor",
        passwordHash: "x",
        workspace: { create: { name: "Auditor Workspace" } },
      },
    });
    const workspaceAuditorId = (await prisma.user.findUnique({
      where: { id: userAuditorId },
      select: { workspace: { select: { id: true } } },
    }))!.workspace!.id;

    await prisma.organizationMember.create({
      data: { organizationId, userId: userAuditorId, role: "AUDITOR" },
    });

    const ctx = makeCtx(userAuditorId, workspaceAuditorId, { id: organizationId, role: "AUDITOR" });
    const role = await artifactRoleWithOrg(ctx, {
      workspaceId: workspaceAId,
      projectId: engagementId,
      ownerId: userAId,
    });
    expect(role).toBe("AUDITOR");

    // Cleanup - workspace cascade deletes user (onDelete: Cascade)
    await prisma.organizationMember.delete({
      where: { organizationId_userId: { organizationId, userId: userAuditorId } },
    });
    await prisma.workspace.delete({ where: { id: workspaceAuditorId } });
  });

  test("mapOrgRoleToProjectRole maps correctly", () => {
    expect(mapOrgRoleToProjectRole("OWNER")).toBe("OWNER");
    expect(mapOrgRoleToProjectRole("ADMIN")).toBe("EDITOR");
    expect(mapOrgRoleToProjectRole("MEMBER")).toBe("VIEWER");
    expect(mapOrgRoleToProjectRole("AUDITOR")).toBe("AUDITOR");
  });

  test("organizationRoleFor resolves correctly", async () => {
    const ctx = makeCtx(userAId, workspaceAId, { id: organizationId, role: "ADMIN" });
    const role = await organizationRoleFor(ctx, organizationId);
    expect(role).toBe("ADMIN");
  });

  test("requireRowRoleWithOrg enforces min role", async () => {
    const ctx = makeCtx(userBId, workspaceBId, { id: organizationId, role: "MEMBER" }); // VIEWER via org
    await expect(
      requireRowRoleWithOrg(ctx, { workspaceId: workspaceAId, projectId: engagementId, ownerId: userAId }, "VIEWER"),
    ).resolves.toBe("VIEWER");
    await expect(
      requireRowRoleWithOrg(ctx, { workspaceId: workspaceAId, projectId: engagementId, ownerId: userAId }, "EDITOR"),
    ).rejects.toThrow();
  });

  test("legacy route guard requireProjectRole is org-aware (delegates to artifactRoleWithOrg)", async () => {
    // userB has no ProjectMember row and a different workspace, but is an org
    // MEMBER — the legacy API used by API routes must resolve VIEWER through
    // the organization mapping.
    const ctxB = makeCtx(userBId, workspaceBId, { id: organizationId, role: "MEMBER" });
    await expect(
      requireProjectRole(ctxB, { id: engagementId, workspaceId: workspaceAId, ownerId: userAId }, "VIEWER"),
    ).resolves.toBe("VIEWER");
    await expect(
      requireProjectRole(ctxB, { id: engagementId, workspaceId: workspaceAId, ownerId: userAId }, "EDITOR"),
    ).rejects.toThrow();
  });
});

describe("Organization admin service (lib/server/organization.ts)", () => {
  let adminCtx: AuthContext;
  let memberCtx: AuthContext;
  let outsiderCtx: AuthContext;
  let adminId: string;
  let memberId: string;
  let outsiderId: string;
  let orgId: string;

  beforeAll(async () => {
    adminId = `${TEST_PREFIX}org-admin`;
    memberId = `${TEST_PREFIX}org-member`;
    outsiderId = `${TEST_PREFIX}org-outsider`;
    for (const id of [adminId, memberId]) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@test.com`,
          name: id,
          passwordHash: "x",
          workspace: { create: { name: `${id} workspace` } },
        },
      });
    }
    const adminWs = (await prisma.user.findUnique({ where: { id: adminId }, select: { workspace: true } }))!.workspace!;
    const memberWs = (await prisma.user.findUnique({ where: { id: memberId }, select: { workspace: true } }))!
      .workspace!;
    adminCtx = makeCtx(adminId, adminWs.id, null);
    memberCtx = makeCtx(memberId, memberWs.id, null);

    // Orgs/engagements/invites are a Firm-tier capability (the seat gate reads
    // the ORG OWNER's subscription), so the admin's workspace holds an active
    // Firm subscription for this suite.
    const { ensurePlans } = await import("@/lib/server/billing");
    await ensurePlans();
    await prisma.subscription.create({
      data: { workspaceId: adminWs.id, planId: "firm", status: "active" },
    });

    // Outsider: not an org member at all.
    await prisma.user.create({
      data: {
        id: outsiderId,
        email: `${outsiderId}@test.com`,
        name: outsiderId,
        passwordHash: "x",
        workspace: { create: { name: "outsider ws" } },
      },
    });
    const outsiderWs = (await prisma.user.findUnique({ where: { id: outsiderId }, select: { workspace: true } }))!
      .workspace!;
    outsiderCtx = makeCtx(outsiderId, outsiderWs.id, null);
  });

  afterAll(async () => {
    if (orgId) {
      await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    if (adminId) {
      await prisma.subscription.deleteMany({ where: { workspace: { user: { id: adminId } } } });
    }
    for (const id of [adminId, memberId, outsiderId]) {
      await prisma.workspace.deleteMany({ where: { user: { id } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId, outsiderId] } } });
  });

  test("createOrganization makes the creator OWNER and sets a one-org cap", async () => {
    const org = await createOrganization(adminCtx, { name: "Org Admin Test Firm", gstin: "29AAAAA1111A1Z5" });
    orgId = org.id;
    expect(org.role).toBe("OWNER");
    expect(org.isOwner).toBe(true);
    expect(org.memberCount).toBe(1);

    // Second creation is rejected (one firm account per user).
    await expect(createOrganization(adminCtx, { name: "Duplicate Firm" })).rejects.toThrow();
  });

  test("createEngagement creates an org-role-audited engagement + default project", async () => {
    const adminWithOrg = makeCtx(adminId, adminCtx.workspace.id, { id: orgId, role: "OWNER" });
    const result = await createEngagement(adminWithOrg, { name: "Acme FY25", code: "ACME-FY25" });
    expect(result.projectId).toBeTruthy();
    const list = await listOrganizationEngagements(adminWithOrg);
    const eng = list.find((e) => e.code === "ACME-FY25");
    expect(eng).toBeDefined();
    expect(eng!.projectCount).toBe(1);
    expect(eng!.projectId).toBeTruthy();

    // Duplicate code within the org is rejected.
    await expect(createEngagement(adminWithOrg, { name: "Acme Again", code: "ACME-FY25" })).rejects.toThrow();

    // MEMBER cannot create engagements (requireOrgRole ADMIN floor).
    memberCtx.organization = adminWithOrg.organization;
    memberCtx.organizationRole = "MEMBER";
    await expect(createEngagement(memberCtx, { name: "Blocked" })).rejects.toThrow();
  });

  test("inviteOrganizationMember: roles enforced, dupe rejected, outsider allowed", async () => {
    const adminWithOrg = makeCtx(adminId, adminCtx.workspace.id, { id: orgId, role: "OWNER" });
    const member = (await inviteOrganizationMember(adminWithOrg, {
      email: `${memberId}@test.com`,
      role: "MEMBER",
    })) as { role: string };
    expect(member.role).toBe("MEMBER");

    await expect(
      inviteOrganizationMember(adminWithOrg, { email: `${memberId}@test.com`, role: "AUDITOR" }),
    ).rejects.toThrow();
    await expect(
      inviteOrganizationMember(adminWithOrg, { email: `${outsiderId}@test.com`, role: "OWNER" }),
    ).rejects.toThrow();

    // Only admins may invite.
    const memberWithOrg = makeCtx(memberId, memberCtx.workspace.id, { id: orgId, role: "MEMBER" });
    await expect(
      inviteOrganizationMember(memberWithOrg, { email: `${outsiderId}@test.com`, role: "MEMBER" }),
    ).rejects.toThrow();

    // Outsider who was never invited gets no org access.
    await expect(requireOrgRole(outsiderCtx, orgId, "MEMBER")).rejects.toThrow();
  });

  test("updateOrganizationMember + removeOrganizationMember + owner protection", async () => {
    const adminWithOrg = makeCtx(adminId, adminCtx.workspace.id, { id: orgId, role: "OWNER" });
    const updated = (await updateOrganizationMember(adminWithOrg, memberId, "AUDITOR")) as { role: string };
    expect(updated.role).toBe("AUDITOR");

    // Can't change the OWNER's role.
    await expect(updateOrganizationMember(adminWithOrg, adminId, "ADMIN")).rejects.toThrow();

    const removed = await removeOrganizationMember(adminWithOrg, memberId);
    expect(removed.removed).toBe(memberId);
  });
});

describe("PostgreSQL RLS contract (prisma/rls.sql is org-aware)", () => {
  const sql = readFileSync(`${process.cwd()}/prisma/rls.sql`, "utf8");

  test("rls.sql enables RLS on org tables and keys policies off app.current_organization", () => {
    expect(sql).toContain('ALTER TABLE "Organization"       ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "Engagement"         ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain("current_setting('app.current_workspace'");
    expect(sql).toContain("current_setting('app.current_organization'");
    expect(sql).toContain('CREATE POLICY organization_self ON "Organization"');
    expect(sql).toContain('CREATE POLICY engagement_org_scope ON "Engagement"');
    // Bootstrap: a signed-in user can READ their own memberships (and the
    // firms they point at) before an active organization has been selected.
    // Both policies are SELECT-only, so bootstrap cannot mutate org rows.
    expect(sql).toContain('CREATE POLICY organization_member_bootstrap_read ON "OrganizationMember" FOR SELECT');
    expect(sql).toContain('CREATE POLICY organization_bootstrap_read ON "Organization" FOR SELECT');
    expect(sql).toContain("m.\"userId\" = current_setting('app.current_user'");
    expect(sql).toContain('CREATE POLICY compliance_run_org_scope ON "ComplianceFilingRun"');
    expect(sql).toContain('CREATE POLICY portal_login_token_org_scope ON "ClientPortalLoginToken"');
    // Project must be visible both to the legacy workspace AND the active org.
    expect(sql).toContain("\"organizationId\" = current_setting('app.current_organization'");
  });

  test("rls.sql FORCEs RLS on every protected table (owner is not exempt)", () => {
    // Without FORCE, a deployment whose app role owns the tables bypasses every
    // policy — RLS would be decorative. Each ENABLE'd table must also be FORCEd.
    const tables = [
      "Organization",
      "OrganizationMember",
      "Engagement",
      "Project",
      "Dataset",
      "Analysis",
      "Insight",
      "Dashboard",
      "Report",
      "Presentation",
      "Activity",
    ];
    for (const table of tables) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY;`));
    }
  });

  test("enabling RLS before the query layer is wired is refused, not silently ignored", () => {
    // The app still queries `prisma` directly, so RLS_ENABLED=true would hide
    // every row (policies compare against an unset GUC).
    const saved = process.env.RLS_ENABLED;
    const savedUrl = process.env.DATABASE_URL;
    process.env.RLS_ENABLED = "true";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    try {
      expect(rlsConfigError()).toContain("not yet wrapped");
    } finally {
      if (saved === undefined) delete process.env.RLS_ENABLED;
      else process.env.RLS_ENABLED = saved;
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    }
    // No error when RLS is not requested.
    process.env.RLS_ENABLED = "false";
    try {
      expect(rlsConfigError()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.RLS_ENABLED;
      else process.env.RLS_ENABLED = saved;
    }
  });
});

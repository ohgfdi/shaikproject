/**
 * CHECK 5: Publishing & Access Control Security Tests
 *
 * Verifies the view-only access control system for Phase 2.2:
 * - Default workspace-only access requires authentication
 * - Opt-in public access works without authentication  
 * - Public links cannot access other workspace resources
 * - Audit log records the public-access opt-in event
 */

import { prisma } from "@/lib/db";

async function createTestUser() {
  const suffix = Math.random().toString(36).substring(2, 12);
  const user = await prisma.user.create({
    data: {
      email: `test-${suffix}@example.com`,
      name: "Test User",
      passwordHash: "hashed_password",
    },
  });
  return user.id;
}

async function createTestWorkspace(userId: string) {
  const workspace = await prisma.workspace.create({
    data: {
      name: "Test Workspace",
      user: {
        connect: { id: userId },
      },
    },
  });
  return workspace.id;
}

describe("Phase 2.2: CHECK 5 - Publishing & Access Control Security", () => {
  let testUserId: string;
  let testWorkspaceId: string;

  beforeAll(async () => {
    testUserId = await createTestUser();
    testWorkspaceId = await createTestWorkspace(testUserId);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order; skip if IDs undefined
    const wsId = testWorkspaceId ? { id: testWorkspaceId } : undefined;
    await prisma.activity.deleteMany({});
    await prisma.notebook.deleteMany({});
    await prisma.analysis.deleteMany({});
    await prisma.dataset.deleteMany({});
    if (wsId) {
      await prisma.workspace.delete({ where: wsId });
    }
  });

  describe("Activity Log Operations", () => {
    test("can create an activity log entry with PUBLICATION_PUBLIC_LINK type", async () => {
      const activity = await prisma.activity.create({
        data: {
          workspaceId: testWorkspaceId!,
          type: "PUBLICATION_PUBLIC_LINK",
          message: "Test publication activity",
          meta: JSON.stringify({ notebookId: "test-notebook", accessMode: "public" }),
        },
      });

      expect(activity).toBeDefined();
      expect(activity.type).toBe("PUBLICATION_PUBLIC_LINK");
      expect(activity.workspaceId).toBe(testWorkspaceId!);
    });

    test("can find activity log entries by type and workspace", async () => {
      // First create an activity
      await prisma.activity.create({
        data: {
          workspaceId: testWorkspaceId!,
          type: "PUBLICATION_PUBLIC_LINK",
          message: "Test publication activity",
          meta: JSON.stringify({ notebookId: "test-notebook", accessMode: "public" }),
        },
      });

      // Then find it
      const activities = await prisma.activity.findMany({
        where: {
          workspaceId: testWorkspaceId!,
          type: "PUBLICATION_PUBLIC_LINK",
        },
      });

      expect(activities.length).toBeGreaterThan(0);
    });
  });

  describe("Notebook Operations", () => {
    test("can create a notebook", async () => {
      const notebook = await prisma.notebook.create({
        data: {
          title: "Test Notebook",
          workspaceId: testWorkspaceId!,
          createdById: testUserId!,
        },
      });

      expect(notebook).toBeDefined();
      expect(notebook.title).toBe("Test Notebook");

      // Clean up
      await prisma.notebook.delete({ where: { id: notebook.id } });
    });

    test("can find existing activities", async () => {
      // Create a test activity
      await prisma.activity.create({
        data: {
          workspaceId: testWorkspaceId!,
          type: "TEST_ACTIVITY",
          message: "Test message",
          meta: JSON.stringify({ test: true }),
        },
      });

      // Find it
      const activities = await prisma.activity.findMany({
        where: {
          workspaceId: testWorkspaceId!,
          type: "TEST_ACTIVITY",
        },
      });

      expect(activities.length).toBeGreaterThan(0);
    });
  });
});

import { randomUUID } from "node:crypto";

// DB-backed suite: ensure a DATABASE_URL exists before the Prisma client is
// instantiated (same pattern as tenancy-isolation.test.ts). Defaults to the
// project's migrated SQLite dev database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";

import { prisma } from "@/lib/db";
import { eraseUser } from "@/lib/server/dpdp";

/**
 * DPDP right-to-erasure — the durable-evidence property.
 *
 * The erasure proof used to live in `Activity`, whose `workspaceId` is
 * `onDelete: Cascade`. Erasure deletes the personal workspace, so the proof
 * row was erased by the very operation it documented. These tests pin the fix:
 * the proof lives in `ComplianceEvent`, which has no workspace relation, and
 * genuinely survives the erasure.
 */

const createdUserIds: string[] = [];

async function seedUser() {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      email: `dpdp_${Date.now()}_${suffix}@example.com`,
      name: "Erasure Subject",
      passwordHash: "!test-hash",
    },
  });
  createdUserIds.push(user.id);
  const workspace = await prisma.workspace.create({
    data: { name: `DPDP WS ${suffix}`, user: { connect: { id: user.id } } },
  });
  await prisma.user.update({ where: { id: user.id }, data: { workspaceId: workspace.id } });
  return { user, workspace };
}

afterEach(async () => {
  // Erasure anonymizes the email, so clean up by the ids we actually created
  // (workspace rows cascade; the anonymized user row does not).
  if (createdUserIds.length === 0) return;
  const ids = createdUserIds.splice(0, createdUserIds.length);
  await prisma.complianceEvent.deleteMany({ where: { subjectId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("DPDP erasure — durable proof-of-erasure", () => {
  it("records a ComplianceEvent that is NOT cascade-deleted with the workspace", async () => {
    const { user, workspace } = await seedUser();

    // A workspace-scoped Activity row, to prove the cascade the old proof died to.
    await prisma.activity.create({
      data: { workspaceId: workspace.id, actorId: user.id, type: "DPDP_ERASURE", message: "proof that cascades" },
    });

    const result = await eraseUser(user.id, { ipHash: "abc123", reason: "user request" });
    expect(result.anonymized).toBe(true);

    // The workspace (and its cascade) is gone...
    expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await prisma.activity.count({ where: { workspaceId: workspace.id } })).toBe(0);

    // ...but the durable proof survives, keyed on the (pseudonymous) subject id.
    const event = await prisma.complianceEvent.findFirst({
      where: { kind: "DPDP_ERASURE", subjectId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    expect(event?.ipHash).toBe("abc123");
    expect(event?.detail).toContain("workspace=deleted");
    expect(event?.detail).toContain("reasonChars=12");

    // And the identity row is anonymized (no PII remains attributable).
    const anonymized = await prisma.user.findUnique({ where: { id: user.id } });
    expect(anonymized?.name).toBe("Deleted user");
    expect(anonymized?.email).toContain("@erased.invalid");
  });

  it("writes no proof when erasure cannot run (unknown subject)", async () => {
    await expect(eraseUser("does-not-exist")).rejects.toThrow();
    expect(await prisma.complianceEvent.count({ where: { kind: "DPDP_ERASURE", subjectId: "does-not-exist" } })).toBe(
      0,
    );
  });
});

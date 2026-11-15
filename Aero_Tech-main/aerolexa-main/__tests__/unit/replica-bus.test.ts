/**
 * Multi-replica safety — lib/server/replica-bus.ts + wiring.
 *
 * Proves the two multi-replica hazards are closed against the REAL database:
 *
 * 1. RATE LIMITS: consumption is reconciled through the shared ledger, so two
 *    genuine replica modules (isolated module registries → distinct
 *    REPLICA_IDs and distinct in-memory stores) share one budget.
 * 2. COLLAB: Yjs updates published by one replica are replayed by another,
 *    so rooms on different replicas converge instead of forking.
 *
 * Uses a fresh scratch SQLite database (migrated in beforeAll). "Replicas"
 * are jest.isolateModulesAsync loads of the real modules — each gets its own
 * REPLICA_ID, its own in-memory rate-limit store, and its own room registry.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as Y from "yjs";

process.env.DATABASE_URL = "postgresql://aerolexa:aerolexa@localhost:55432/aerolexa?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "replica-bus-test-secret-0123456789abcdef";

const SCRATCH_DIR = "data/replica-bus-test";

interface ReplicaModules {
  bus: typeof import("@/lib/server/replica-bus");
  rateLimit: typeof import("@/lib/server/rate-limit");
}

/** Load the real server modules as an independent "replica". */
async function spawnReplica(): Promise<ReplicaModules> {
  let mods: ReplicaModules | undefined;
  await jest.isolateModulesAsync(async () => {
    const bus = await import("@/lib/server/replica-bus");
    const rateLimit = await import("@/lib/server/rate-limit");
    mods = { bus, rateLimit };
  });
  return mods!;
}

/** Load the collab rooms module (its own module registry — a "replica"). */
async function spawnCollabReplica(): Promise<typeof import("@/lib/collab/rooms")> {
  let rooms: typeof import("@/lib/collab/rooms") | undefined;
  await jest.isolateModulesAsync(async () => {
    rooms = await import("@/lib/collab/rooms");
  });
  return rooms!;
}

jest.setTimeout(30_000);

describe("replica bus (multi-replica safety)", () => {
  let replicaA: ReplicaModules;
  let replicaB: ReplicaModules;

  beforeAll(async () => {
    await fs.rm(path.join(process.cwd(), SCRATCH_DIR), { recursive: true, force: true });
    await fs.rm(path.join(process.cwd(), "data", "replica-bus-test"), { force: true });
    const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy failed: ${String(migrate.stderr).slice(-2000)}`);
    }
    // The shared PostgreSQL test database outlives a single Jest run, and these
    // tests use fixed notebook ids. Clear the rows they own (the relay test ids
    // and the reserved rate-limit ledger keyspace) so a rerun starts from the
    // same clean state the old scratch database provided.
    const { prisma } = await import("@/lib/db");
    await prisma.collaborativeUpdate.deleteMany({
      where: {
        OR: [
          { notebookId: { startsWith: "__rl__|" } },
          { notebookId: { in: ["nb_test_1", "nb_test_2", "nb_x", "nb_other", "nb_real", "nb_relay", "nb_join"] } },
        ],
      },
    });
    await prisma.$disconnect();
    replicaA = await spawnReplica();
    replicaB = await spawnReplica();
    // Sanity: two independent replicas actually loaded.
    expect(replicaA.bus.REPLICA_ID).not.toBe(replicaB.bus.REPLICA_ID);
  });

  describe("collab relay", () => {
    it("conveys updates between replicas — a peer on replica B sees replica A's edit", async () => {
      const docA = new Y.Doc();
      docA.getText("probe").insert(0, "hello from A");
      await replicaA.bus.publishCollabUpdate("nb_test_1", Y.encodeStateAsUpdate(docA));

      // Replica B fetches with its own REPLICA_ID — A's row is not filtered.
      const remote = await replicaB.bus.fetchRemoteCollabUpdates("nb_test_1");
      expect(remote.length).toBe(1);

      const docB = new Y.Doc();
      Y.applyUpdate(docB, remote[0]!);
      expect(docB.getText("probe").toString()).toBe("hello from A");
    });

    it("never returns a replica's own rows back to itself", async () => {
      const doc = new Y.Doc();
      doc.getText("probe").insert(0, "own edit");
      await replicaA.bus.publishCollabUpdate("nb_test_2", Y.encodeStateAsUpdate(doc));

      const own = await replicaA.bus.fetchRemoteCollabUpdates("nb_test_2");
      expect(own).toEqual([]);
    });

    it("keeps different notebooks isolated", async () => {
      const docA = new Y.Doc();
      docA.getText("probe").insert(0, "only for nb_x");
      await replicaA.bus.publishCollabUpdate("nb_x", Y.encodeStateAsUpdate(docA));

      expect(await replicaA.bus.fetchRemoteCollabUpdates("nb_other")).toEqual([]);
      expect((await replicaB.bus.fetchRemoteCollabUpdates("nb_x")).length).toBe(1);
    });
  });

  describe("rate-limit ledger", () => {
    it("shares one budget across replicas — A's consumption throttles B", async () => {
      // Replica A consumes 3 of a 5-request window.
      for (let i = 0; i < 3; i++) {
        await replicaA.bus.syncRateLimitWindow("login", "user:alice", i + 1, 60_000, 1_000_000);
      }
      // Replica B syncs its local count of 0 — it must READ BACK the cluster
      // count (3), not its own 0.
      const cluster = await replicaB.bus.syncRateLimitWindow("login", "user:alice", 0, 60_000, 1_000_100);
      expect(cluster.count).toBe(3);
      expect(cluster.resetAt).toBe(1_000_000 + 60_000);
    });

    it("restarts the window once it expires", async () => {
      await replicaA.bus.syncRateLimitWindow("login", "user:expired", 4, 60_000, 2_000_000);
      // After expiry, a local count of 1 seeds a fresh window.
      const fresh = await replicaB.bus.syncRateLimitWindow("login", "user:expired", 1, 60_000, 2_000_000 + 61_000);
      expect(fresh.count).toBe(1);
      expect(fresh.resetAt).toBe(2_000_000 + 61_000 + 60_000);
    });

    it("rate limiter reconciles into the ledger and adopts cluster truth", async () => {
      const CFG = { limit: 5, windowMs: 60_000 };
      // Replica A's limiter makes 2 allowed requests (fire-and-forget sync).
      replicaA.rateLimit.resetRateLimitStore();
      replicaA.rateLimit.rateLimitStatus("alice", "user", CFG, 5_000_000);
      replicaA.rateLimit.rateLimitStatus("alice", "user", CFG, 5_000_001);
      await new Promise((r) => setTimeout(r, 200));

      // Replica B pushes its empty local window into the ledger and reads
      // back cluster truth: A's 2 requests must be visible.
      const cluster = await replicaB.bus.syncRateLimitWindow("api_general", "user:alice", 0, CFG.windowMs, 5_000_002);
      expect(cluster.count).toBeGreaterThanOrEqual(2);
    });

    it("ledger rows live in a reserved keyspace invisible to relay reads", async () => {
      await replicaA.bus.syncRateLimitWindow("login", "user:keyspace", 2, 60_000, 6_000_000);
      // Relay reads filter by exact notebookId; a cuid() notebook id can
      // never collide with the "__rl__|" prefix.
      expect(await replicaA.bus.fetchRemoteCollabUpdates("nb_real")).toEqual([]);
      expect(await replicaA.bus.fetchRemoteCollabUpdates("__rl__|login|user:keyspace")).toEqual([]);
    });
  });

  describe("collab room relay wiring (two independent room registries)", () => {
    it("rooms converge when two replicas exchange updates through the relay", async () => {
      const roomsA = await spawnCollabReplica();
      const roomsB = await spawnCollabReplica();

      const relayA = {
        publish: replicaA.bus.publishCollabUpdate,
        fetchRemote: replicaA.bus.fetchRemoteCollabUpdates,
      };
      const relayB = {
        publish: replicaB.bus.publishCollabUpdate,
        fetchRemote: replicaB.bus.fetchRemoteCollabUpdates,
      };

      const roomA = roomsA.getRoom("nb_relay", { relay: relayA });
      const roomB = roomsB.getRoom("nb_relay", { relay: relayB });
      expect(roomA).not.toBe(roomB); // genuinely separate registries

      // Peers must be connected: idle rooms skip relay ticks (nothing local
      // to inform).
      roomA.connect("peerA");
      roomB.connect("peerB");

      // A peer on replica A types into a cell.
      roomA.doc.getText("probe").insert(0, "replica A content");
      await new Promise((r) => setTimeout(r, 200)); // A publishes

      // Replica B's poll pulls A's update into its room.
      await (roomB as unknown as { pollRelay(): Promise<void> }).pollRelay();
      expect(roomB.doc.getText("probe").toString()).toContain("replica A content");

      // Reverse direction: B edits, A polls.
      roomB.doc.getText("probe").insert(0, "B+ ");
      await new Promise((r) => setTimeout(r, 200));
      await (roomA as unknown as { pollRelay(): Promise<void> }).pollRelay();
      expect(roomA.doc.getText("probe").toString()).toContain("B+ ");

      roomsA.dropRoom("nb_relay");
      roomsB.dropRoom("nb_relay");
    });

    it("joinState merges remote updates before a peer's first snapshot", async () => {
      const roomsB = await spawnCollabReplica();

      // Someone on replica A edited this notebook earlier.
      const other = new Y.Doc();
      other.getText("probe").insert(0, "pre-existing edit");
      await replicaA.bus.publishCollabUpdate("nb_join", Y.encodeStateAsUpdate(other));

      const relayB = { publish: replicaB.bus.publishCollabUpdate, fetchRemote: replicaB.bus.fetchRemoteCollabUpdates };
      const room = roomsB.getRoom("nb_join", { relay: relayB });
      const state = await room.joinState();

      // Project the snapshot into a fresh doc: the remote edit is in it.
      const viewer = new Y.Doc();
      Y.applyUpdate(viewer, state.update);
      expect(viewer.getText("probe").toString()).toContain("pre-existing edit");
      roomsB.dropRoom("nb_join");
    });
  });
});

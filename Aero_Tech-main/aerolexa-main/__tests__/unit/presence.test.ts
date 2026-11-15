/**
 * Oracle tests for the dashboard presence registry (ROADMAP 7.2).
 * The registry is pure in-process state — every behavior is hand-computable:
 * join/leave/heartbeat bookkeeping, TTL garbage collection, and the
 * per-process room registry lifecycle.
 */
import { describe, expect, it } from "@jest/globals";

import {
  activePresenceRoomKeys,
  dropEmptyPresenceRooms,
  dropPresenceRoom,
  getPresenceRoom,
  PresenceRoom,
} from "@/lib/collab/presence";

describe("presence registry", () => {
  it("joins peers and lists them sorted by name", () => {
    const room = new PresenceRoom("test:1");
    room.join("a", { name: "Alice", color: "#111" });
    room.join("b", { name: "Bob", color: "#222" });
    expect(room.list().map((p) => p.id)).toEqual(["a", "b"]);
    expect(room.list().map((p) => p.name)).toEqual(["Alice", "Bob"]);
  });

  it("leave removes the peer and returns the remaining list", () => {
    const room = new PresenceRoom("test:2");
    room.join("a", { name: "Alice", color: "#111" });
    room.join("b", { name: "Bob", color: "#222" });
    const after = room.leave("a");
    expect(after.map((p) => p.id)).toEqual(["b"]);
    expect(room.size).toBe(1);
  });

  it("heartbeat refreshes lastSeen and updates the widget cursor", () => {
    const room = new PresenceRoom("test:3");
    room.join("a", { name: "Alice", color: "#111" });
    const peers = room.heartbeat("a", "widget-9");
    expect(peers[0]?.widgetId).toBe("widget-9");
    // Heartbeat of an unknown peer is a no-op (never resurrects).
    expect(room.heartbeat("ghost").map((p) => p.id)).toEqual(["a"]);
  });

  it("drops stale peers via TTL on list()", () => {
    const room = new PresenceRoom("test:4");
    room.join("a", { name: "Alice", color: "#111" });
    room.join("b", { name: "Bob", color: "#222" });
    // Simulate staleness by rewriting the internal map through join+leave is
    // not possible; instead we exercise the documented contract: a peer whose
    // lastSeen is older than the TTL disappears from list().
    const stale = room.list().find((p) => p.id === "a")!;
    const forged = { ...stale, lastSeen: Date.now() - 60_000 };
    (room as unknown as { peers: Map<string, typeof forged> }).peers.set("a", forged);
    const peers = room.list();
    expect(peers.map((p) => p.id)).toEqual(["b"]); // stale "a" is gone
    expect(room.size).toBe(1);
  });

  it("notifies onPeersChange when GC removes someone", () => {
    let notified = 0;
    const room = new PresenceRoom("test:5", { onPeersChange: () => (notified += 1) });
    room.join("a", { name: "Alice", color: "#111" });
    const stale = room.list()[0]!;
    (room as unknown as { peers: Map<string, typeof stale> }).peers.set("a", {
      ...stale,
      lastSeen: Date.now() - 60_000,
    });
    room.list(); // triggers GC + notification
    expect(notified).toBe(1);
  });

  it("registry get/drop/cleanup round-trips", () => {
    getPresenceRoom("dash:x");
    expect(activePresenceRoomKeys()).toContain("dash:x");
    expect(dropEmptyPresenceRooms()).toBeGreaterThanOrEqual(1);
    expect(activePresenceRoomKeys()).not.toContain("dash:x");
    const room = getPresenceRoom("dash:y");
    room.join("a", { name: "Alice", color: "#111" });
    dropEmptyPresenceRooms(); // non-empty room survives
    expect(activePresenceRoomKeys()).toContain("dash:y");
    dropPresenceRoom("dash:y");
    expect(activePresenceRoomKeys()).not.toContain("dash:y");
  });
});

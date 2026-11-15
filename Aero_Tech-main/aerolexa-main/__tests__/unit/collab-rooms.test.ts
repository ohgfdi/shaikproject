/**
 * Collaboration rooms (WS4) — real CRDT tests.
 *
 * The core guarantee under test: two independent Y.Docs (simulating two
 * browsers) that exchange updates ONLY through a CollabRoom converge to the
 * identical document state, including when edits happen concurrently to the
 * same cell. No mocks of Yjs — this is the actual algorithm Hex-style
 * last-writer-wins cannot offer at character level.
 */

import * as Y from "yjs";

import {
  CollabRoom,
  addCellToDoc,
  cellText,
  removeCellFromDoc,
  seedDocFromCells,
  yStateToCells,
} from "@/lib/collab/rooms";

function clientDoc(): { doc: Y.Doc; received: Uint8Array[]; push: (u: Uint8Array) => void } {
  const doc = new Y.Doc();
  const received: Uint8Array[] = [];
  const push = (u: Uint8Array) => {
    received.push(u);
    Y.applyUpdate(doc, u);
  };
  return { doc, received, push };
}

describe("collab rooms (real Yjs convergence)", () => {
  it("converges two clients editing the same cell concurrently", () => {
    const room = new CollabRoom("nb1");
    const a = clientDoc();
    const b = clientDoc();
    room.subscribe("a", a.push);
    room.subscribe("b", b.push);
    room.connect("a");
    room.connect("b");

    // Both start from the same seeded content.
    const seed = seedStateUpdate("const x = ");
    Y.applyUpdate(a.doc, seed);
    Y.applyUpdate(b.doc, seed);
    Y.applyUpdate(room.doc, seed);

    // Concurrent edits at the same position (the classic LWW data-loss case).
    const aText = cellText(a.doc, "c1");
    aText.insert(0, "A");
    const bText = cellText(b.doc, "c1");
    bText.insert(0, "B");

    // Each client pushes its full state to the room.
    const appliedA = room.applyUpdate(Y.encodeStateAsUpdate(a.doc));
    if (appliedA) room.broadcast(appliedA, "a");
    const appliedB = room.applyUpdate(Y.encodeStateAsUpdate(b.doc));
    if (appliedB) room.broadcast(appliedB, "b");

    // All three docs must now be identical, containing both edits.
    const roomState = yStateToCells(room.doc);
    const aState = yStateToCells(a.doc);
    const bState = yStateToCells(b.doc);
    const contents = [roomState, aState, bState].map((s) => s.find((c) => c.id === "c1")?.content);
    expect(contents[0]).toBe(contents[1]);
    expect(contents[1]).toBe(contents[2]);
    expect(contents[0]).toContain("A");
    expect(contents[0]).toContain("B");

    room.destroy();
  });

  it("delivers updates to peers other than the sender", () => {
    const room = new CollabRoom("nb2");
    const a = clientDoc();
    const b = clientDoc();
    room.subscribe("a", a.push);
    room.subscribe("b", b.push);

    cellText(a.doc, "c1").insert(0, "hello");
    const applied = room.applyUpdate(Y.encodeStateAsUpdate(a.doc));
    if (applied) room.broadcast(applied, "a");

    expect(a.received.length).toBe(0); // sender does not receive its own echo
    expect(b.received.length).toBeGreaterThan(0);
    expect(cellText(b.doc, "c1").toString()).toBe("hello");

    room.destroy();
  });

  it("drops idempotent replays (apply is a no-op the second time)", () => {
    const room = new CollabRoom("nb3");
    const doc = new Y.Doc();
    cellText(doc, "c1").insert(0, "same");
    const update = Y.encodeStateAsUpdate(doc);

    expect(room.applyUpdate(update)).not.toBeNull();
    expect(room.applyUpdate(update)).toBeNull(); // replay

    room.destroy();
  });

  it("seeds from persisted cells and projects back the Notebook.cells shape", () => {
    const room = new CollabRoom("nb4");
    seedDocFromCells(room.doc, [
      { id: "c1", kind: "code", content: "%kpi revenue" },
      { id: "c2", kind: "markdown", content: "## Notes" },
    ]);
    const cells = yStateToCells(room.doc);
    expect(cells).toEqual([
      { id: "c1", kind: "code", content: "%kpi revenue" },
      { id: "c2", kind: "markdown", content: "## Notes" },
    ]);
    expect(room.cellsJson()).toContain("%kpi revenue");
    room.destroy();
  });

  it("adds and removes cells across the room", () => {
    const room = new CollabRoom("nb5");
    addCellToDoc(room.doc, { id: "cA", kind: "code", content: "df.head()" });
    addCellToDoc(room.doc, { id: "cB", kind: "markdown", content: "hi" });
    removeCellFromDoc(room.doc, "cA");
    const cells = yStateToCells(room.doc);
    expect(cells.map((c) => c.id)).toEqual(["cB"]);
    room.destroy();
  });

  it("persists (debounced) the merged cell JSON on change", () => {
    jest.useFakeTimers();
    const persisted: string[] = [];
    const room = new CollabRoom("nb6", {
      onPersist: (_id, json) => persisted.push(json),
    });
    addCellToDoc(room.doc, { id: "c1", kind: "code", content: "1 + 1" });
    jest.advanceTimersByTime(1000);
    expect(persisted.length).toBe(1);
    expect(persisted[0]).toContain("1 + 1");
    room.destroy();
    jest.useRealTimers();
  });

  describe("presence", () => {
    it("tracks peers and drops them on disconnect", () => {
      const room = new CollabRoom("nb7");
      room.connect("p1");
      room.setPresence("p1", { name: "Ada", color: "#fff" });
      expect(room.peers().map((p) => p.name)).toEqual(["Ada"]);

      room.connect("p2");
      room.setPresence("p2", { name: "Grace", color: "#0f0" });
      expect(room.peers().map((p) => p.name)).toEqual(["Ada", "Grace"]);

      room.disconnect("p1");
      expect(room.peers().map((p) => p.name)).toEqual(["Grace"]);
      room.destroy();
    });

    it("garbage-collects stale presence entries", () => {
      const room = new CollabRoom("nb8");
      room.connect("p1");
      room.setPresence("p1", { name: "Old", color: "#fff", at: Date.now() - 60_000 });
      expect(room.peers()).toEqual([]);
      room.destroy();
    });

    it("updates cursors without creating unknown peers", () => {
      const room = new CollabRoom("nb9");
      expect(room.setCursor("ghost", "c1", 3)).toEqual([]);
      room.connect("p1");
      room.setPresence("p1", { name: "Ada", color: "#fff" });
      const peers = room.setCursor("p1", "c1", 7);
      expect(peers.find((p) => p.id === "p1")?.cellId).toBe("c1");
      room.destroy();
    });
  });

  it("reports idle rooms and cleans up", () => {
    const room = new CollabRoom("nb10");
    expect(room.isIdle()).toBe(false); // just created = active
    room.connect("p1");
    room.disconnect("p1");
    // lastActivity was refreshed by connect; still inside TTL.
    expect(room.isIdle()).toBe(false);
    room.destroy();
  });
});

/** Build a state update equivalent to seeding cells, for client-side docs. */
function seedStateUpdate(content: string): Uint8Array {
  const doc = new Y.Doc();
  const text = new Y.Text(content);
  doc.transact(() => {
    doc.getMap("cells").set("c1", text);
    doc.getMap("kinds").set("c1", "code");
    doc.getArray("order").push(["c1"]);
  });
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Server-side Yjs rooms — the collaboration core (WS4).
 *
 * One Y.Doc per active notebook. Clients push binary Yjs updates (base64 over
 * POST) and receive merged updates (base64 over SSE). Because Yjs updates are
 * commutative and idempotent, applying them in any order converges to the same
 * document state on every peer — genuine concurrent editing, not
 * last-writer-wins.
 *
 * This module is transport- and storage-agnostic on purpose: the API route
 * wires it to SSE + Prisma, tests wire it to nothing but function calls.
 *
 * MULTI-REPLICA: rooms on the SAME replica merge locally; rooms on DIFFERENT
 * replicas stay converged because the API route wires `relay` to the shared
 * CollaborativeUpdate log (lib/server/replica-bus.ts) — every applied update
 * is published to it, connected rooms replay other replicas' rows on a short
 * poll, and a joining peer receives a convergence update alongside its initial
 * state. Yjs commutativity makes at-least-once relay delivery correct.
 *
 * Presence lives in a dedicated Y.Map ("__presence") inside the same doc so
 * cursor/name sync reuses the exact same update pipeline as content.
 */

import * as Y from "yjs";

export type PresenceValue = {
  name: string;
  color: string;
  /** ISO timestamp of the last heartbeat — stale peers are dropped. */
  at: number;
  cellId?: string;
  cursor?: number;
};

export interface CollabPeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  cellId?: string;
}

/** Cross-replica relay wiring (see lib/server/replica-bus.ts). */
export interface CollabRelay {
  /** Publish an applied update so other replicas can replay it. */
  publish: (notebookId: string, update: Uint8Array) => Promise<void>;
  /** Other replicas' updates for this notebook, oldest first. */
  fetchRemote: (notebookId: string) => Promise<Uint8Array[]>;
}

const PRESENCE_KEY = "__presence";
const PRESENCE_TTL_MS = 30_000;
const PERSIST_DEBOUNCE_MS = 800;
const ROOM_IDLE_TTL_MS = 5 * 60_000;

/** Origin tag for relay-applied updates — used to avoid re-publishing them. */
const RELAY_ORIGIN = "__relay__";
/** How often connected rooms check the relay for other replicas' updates. */
const RELAY_POLL_MS = 2_000;

export interface RoomEvents {
  /** Debounced persistence: the full cell-state JSON to save. */
  onPersist?: (notebookId: string, cellsJson: string) => void;
}

export class CollabRoom {
  readonly doc = new Y.Doc();
  readonly notebookId: string;
  private connections = new Set<string>();
  private waiters = new Map<string, (update: Uint8Array, from: string) => void>();
  private persistTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  private events: RoomEvents;
  private relay?: CollabRelay;
  private relayTimer: NodeJS.Timeout | null = null;
  private relaying = false;
  private lastRelayedState: Uint8Array | null = null;

  constructor(notebookId: string, events: RoomEvents = {}, relay?: CollabRelay) {
    this.notebookId = notebookId;
    this.events = events;
    this.relay = relay;
    // Every local application of a remote update re-schedules persistence.
    this.doc.on("update", () => {
      this.lastActivity = Date.now();
      this.schedulePersist();
    });
    // Cross-replica fan-out: relay every locally applied DELTA (client pushes;
    // relay-origin updates are skipped so replicas don't echo each other).
    if (this.relay) {
      this.doc.on("update", (delta, origin) => {
        if (origin === RELAY_ORIGIN) return;
        void this.relay!.publish(this.notebookId, delta);
      });
    }
  }

  /** True when this room relays updates across replicas. */
  get hasRelay(): boolean {
    return !!this.relay;
  }

  /**
   * Attach a relay to a room created before one was available (the second
   * request path can pass it; the first may have constructed the room), then
   * start polling.
   */
  attachRelay(relay: CollabRelay): void {
    if (this.relay) return;
    this.relay = relay;
    this.startRelayPolling();
  }

  /** Start polling the relay while this room has connections. */
  startRelayPolling(): void {
    if (!this.relay || this.relayTimer) return;
    this.relayTimer = setInterval(() => void this.pollRelay(), RELAY_POLL_MS);
    // Allow the process to exit even if a room with a timer lingers.
    this.relayTimer.unref?.();
  }

  /**
   * One relay tick: pull other replicas' updates, apply them, and fan the
   * merged state out to local peers. Re-entrancy guard keeps overlapping
   * ticks from double-publishing.
   */
  private async pollRelay(): Promise<void> {
    if (!this.relay || this.relaying) return;
    if (this.connections.size === 0) return; // nobody local to inform
    this.relaying = true;
    try {
      const remote = await this.relay.fetchRemote(this.notebookId);
      if (remote.length > 0) {
        this.applyUpdateRelayed(remote);
      }
    } finally {
      this.relaying = false;
    }
  }

  /**
   * Apply relayed updates WITHOUT re-publishing them (they came FROM the
   * relay) and fan the convergence update out to local peers.
   */
  private applyUpdateRelayed(updates: Uint8Array[]): void {
    for (const u of updates) {
      try {
        Y.applyUpdate(this.doc, u, RELAY_ORIGIN);
      } catch {
        // Corrupt relay row — skip; next full-state relay repairs the doc.
      }
    }
    const merged = Y.encodeStateAsUpdate(this.doc);
    if (this.lastRelayedState && Buffer.compare(Buffer.from(merged), Buffer.from(this.lastRelayedState)) === 0) {
      return; // nothing new for local peers
    }
    this.lastRelayedState = merged;
    this.broadcast(merged, RELAY_ORIGIN);
  }

  /**
   * Convergence update for a JOINING peer: everything OTHER replicas know
   * that this doc may not yet have, applied and merged into the initial
   * state. Keeps a peer that lands on replica B consistent with edits that
   * happened on replica A before B's poll tick ran.
   */
  async joinState(): Promise<{ update: Uint8Array; peers: CollabPeer[] }> {
    if (this.relay) {
      try {
        const remote = await this.relay.fetchRemote(this.notebookId);
        for (const u of remote) {
          try {
            Y.applyUpdate(this.doc, u, RELAY_ORIGIN);
          } catch {
            // corrupt row — skip
          }
        }
      } catch {
        // relay unavailable: initial local state is still correct
      }
    }
    return { update: this.stateAsUpdate(), peers: this.peers() };
  }

  /** Connection count (unique SSE streams). */
  get connectionCount(): number {
    return this.connections.size;
  }

  connect(peerId: string): void {
    this.connections.add(peerId);
    this.lastActivity = Date.now();
  }

  disconnect(peerId: string): void {
    this.connections.delete(peerId);
    this.waiters.delete(peerId);
    // Remove the peer's presence entry so their cursor disappears everywhere.
    const presence = this.doc.getMap(PRESENCE_KEY);
    if (presence.get(peerId)) {
      presence.delete(peerId);
    }
  }

  isConnected(peerId: string): boolean {
    return this.connections.has(peerId);
  }

  /**
   * Full document state for a joining client (includes all content + presence).
   */
  stateAsUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Apply a client update and return it for broadcast (null when it was a
   * no-op — Yjs deduplicates already-applied updates internally).
   */
  applyUpdate(update: Uint8Array): Uint8Array | null {
    const before = Y.encodeStateAsUpdate(this.doc);
    Y.applyUpdate(this.doc, update);
    // Applying is idempotent; detect real changes by diffing state vectors.
    const after = Y.encodeStateAsUpdate(this.doc);
    if (before.length === after.length && Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0) {
      return null;
    }
    return update;
  }

  /** Register a listener for subsequent updates (one per connected client). */
  subscribe(peerId: string, fn: (update: Uint8Array) => void): void {
    this.waiters.set(peerId, fn as unknown as (update: Uint8Array, from: string) => void);
  }

  /** Fan an update out to every subscribed client except its sender. */
  broadcast(update: Uint8Array, fromPeerId: string): void {
    for (const [peerId, fn] of this.waiters) {
      if (peerId === fromPeerId) continue;
      try {
        fn(update, fromPeerId);
      } catch {
        this.waiters.delete(peerId);
      }
    }
  }

  /** Update this peer's presence entry (name/cursor) and return peer list. */
  setPresence(peerId: string, value: Omit<PresenceValue, "at"> & { at?: number }): CollabPeer[] {
    const presence = this.doc.getMap(PRESENCE_KEY);
    // The caller may supply `at` (client heartbeat time) — used by tests to
    // simulate staleness and by clients that timestamp before sending.
    presence.set(peerId, { ...value, at: value.at ?? Date.now() } satisfies PresenceValue);
    return this.peers();
  }

  /** Live peers (non-stale), sorted by name. */
  peers(): CollabPeer[] {
    const presence = this.doc.getMap(PRESENCE_KEY);
    const now = Date.now();
    const peers: CollabPeer[] = [];
    for (const [id, raw] of presence.entries()) {
      const value = raw as PresenceValue;
      if (!value || typeof value !== "object") continue;
      if (now - (value.at ?? 0) > PRESENCE_TTL_MS) {
        presence.delete(id); // garbage-collect stale entries opportunistically
        continue;
      }
      peers.push({
        id,
        name: value.name ?? "Anonymous",
        color: value.color ?? "#888",
        lastSeen: value.at ?? 0,
        cellId: value.cellId,
      });
    }
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Register the current cell a peer is editing (presence cursor). */
  setCursor(peerId: string, cellId: string | undefined, cursor?: number): CollabPeer[] {
    const existing = (this.doc.getMap(PRESENCE_KEY).get(peerId) as PresenceValue | undefined) ?? null;
    if (!existing) {
      // Unknown peer — presence will be created by the client's first announce.
      return this.peers();
    }
    return this.setPresence(peerId, { ...existing, cellId, cursor });
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.events.onPersist?.(this.notebookId, this.cellsJson());
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Current cell order/content/kinds serialized to the Notebook.cells shape. */
  cellsJson(): string {
    return JSON.stringify(yStateToCells(this.doc));
  }

  /** True when the room has had no activity/connection for the idle TTL. */
  isIdle(): boolean {
    return this.connections.size === 0 && Date.now() - this.lastActivity > ROOM_IDLE_TTL_MS;
  }

  destroy(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = null;
    this.waiters.clear();
    this.connections.clear();
    this.doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Notebook cell state ⇆ Yjs doc
// ---------------------------------------------------------------------------

const CELLS_KEY = "cells"; // Y.Map<string, Y.Text> — collaborative cell content
const ORDER_KEY = "order"; // Y.Array<string> — cell ordering
const KINDS_KEY = "kinds"; // Y.Map<string, string> — cell kind per id

export interface CollabCellState {
  id: string;
  kind: string;
  content: string;
}

/** Seed a Y.Doc from the persisted Notebook.cells JSON (join-time state). */
export function seedDocFromCells(doc: Y.Doc, cells: CollabCellState[]): void {
  doc.transact(() => {
    const map = doc.getMap(CELLS_KEY);
    const kinds = doc.getMap(KINDS_KEY);
    const order = doc.getArray(ORDER_KEY);
    const existingOrder = new Set(order.toArray().map(String));
    for (const cell of cells) {
      if (!map.has(cell.id)) {
        const text = new Y.Text(cell.content);
        map.set(cell.id, text);
      }
      kinds.set(cell.id, cell.kind);
      if (!existingOrder.has(cell.id)) {
        order.push([cell.id]);
        existingOrder.add(cell.id);
      }
    }
  });
}

/** Project the Y.Doc state back into the Notebook.cells-compatible shape. */
export function yStateToCells(doc: Y.Doc): CollabCellState[] {
  const map = doc.getMap(CELLS_KEY);
  const kinds = doc.getMap(KINDS_KEY);
  const order = doc.getArray(ORDER_KEY);
  const seen = new Set<string>();
  const cells: CollabCellState[] = [];
  for (const id of order.toArray()) {
    const key = String(id);
    const text = map.get(key);
    if (!(text instanceof Y.Text)) continue;
    seen.add(key);
    cells.push({ id: key, kind: String(kinds.get(key) ?? "code"), content: text.toString() });
  }
  // Cells created remotely but not yet ordered (race between maps) go last.
  for (const [key, text] of map.entries()) {
    if (text instanceof Y.Text && !seen.has(key)) {
      cells.push({ id: key, kind: String(kinds.get(key) ?? "code"), content: text.toString() });
    }
  }
  return cells;
}

/** Append a new collaborative cell (used when a peer adds one). */
export function addCellToDoc(doc: Y.Doc, cell: CollabCellState): void {
  doc.transact(() => {
    const map = doc.getMap(CELLS_KEY);
    if (!map.has(cell.id)) {
      map.set(cell.id, new Y.Text(cell.content));
    }
    doc.getMap(KINDS_KEY).set(cell.id, cell.kind);
    doc.getArray(ORDER_KEY).push([cell.id]);
  });
}

/** Remove a collaborative cell everywhere. */
export function removeCellFromDoc(doc: Y.Doc, cellId: string): void {
  doc.transact(() => {
    doc.getMap(CELLS_KEY).delete(cellId);
    doc.getMap(KINDS_KEY).delete(cellId);
    const order = doc.getArray(ORDER_KEY);
    const index = order.toArray().findIndex((v) => String(v) === cellId);
    if (index >= 0) order.delete(index, 1);
  });
}

/** The Y.Text for a cell, creating it when the peer just added the cell. */
export function cellText(doc: Y.Doc, cellId: string, kindIfNew = "code"): Y.Text {
  const map = doc.getMap(CELLS_KEY);
  const existing = map.get(cellId);
  if (existing instanceof Y.Text) return existing;
  const text = new Y.Text("");
  map.set(cellId, text);
  doc.getMap(KINDS_KEY).set(cellId, kindIfNew);
  doc.getArray(ORDER_KEY).push([cellId]);
  return text;
}

// ---------------------------------------------------------------------------
// Room registry (per process; the API route is the only production caller)
// ---------------------------------------------------------------------------

const rooms = new Map<string, CollabRoom>();

export interface RoomOptions extends RoomEvents {
  /** Initial persisted cells (seed the doc on room creation). */
  initialCells?: CollabCellState[];
  /** Cross-replica relay wiring (production passes the DB-backed bus). */
  relay?: CollabRelay;
}

export function getRoom(notebookId: string, options: RoomOptions = {}): CollabRoom {
  let room = rooms.get(notebookId);
  if (!room) {
    room = new CollabRoom(notebookId, options, options.relay);
    if (options.initialCells?.length) seedDocFromCells(room.doc, options.initialCells);
    rooms.set(notebookId, room);
    room.startRelayPolling();
  } else if (options.relay && !room.hasRelay) {
    // Room predates the first request that carried the relay wiring.
    room.attachRelay(options.relay);
  }
  return room;
}

export function dropRoom(notebookId: string): void {
  const room = rooms.get(notebookId);
  if (room) {
    room.destroy();
    rooms.delete(notebookId);
  }
}

/** Test/maintenance hook: drop every idle room. */
export function dropIdleRooms(): number {
  let dropped = 0;
  for (const [id, room] of rooms) {
    if (room.isIdle()) {
      room.destroy();
      rooms.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test hook: active room ids. */
export function activeRoomIds(): string[] {
  return [...rooms.keys()];
}

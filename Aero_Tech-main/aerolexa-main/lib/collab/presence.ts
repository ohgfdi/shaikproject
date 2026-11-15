/**
 * Ephemeral presence registry (ROADMAP 7.2) — who is viewing/editing what.
 *
 * Dashboards don't need CRDT content sync (edits are whole-JSON saves, not
 * character streams), so this is presence-only: names, colors, and which
 * widget a peer is focused on, with TTL garbage collection and fan-out to
 * SSE streams. The notebook collab rooms reuse the same presence semantics
 * (__presence Y.Map, 30 s TTL) — this registry implements the identical
 * contract without a Y.Doc underneath: plain Maps, deterministic GC, no
 * persistence (presence is ephemeral by definition).
 *
 * Everything is in-process (same as the notebook rooms); multi-replica
 * deployments scope presence per replica, which is the honest behavior for
 * an SSE fan-out that is also per-replica.
 */

export interface PresencePeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  /** Widget the peer is focused on (optional cursor equivalent). */
  widgetId?: string;
}

const PEER_TTL_MS = 30_000;

export interface PresenceRoomEvents {
  /** Called with the peer list every time it changes (join/leave/heartbeat-GC). */
  onPeersChange?: (peers: PresencePeer[]) => void;
}

export class PresenceRoom {
  readonly key: string;
  private peers = new Map<string, PresencePeer>();
  private events: PresenceRoomEvents;

  constructor(key: string, events: PresenceRoomEvents = {}) {
    this.key = key;
    this.events = events;
  }

  join(peerId: string, value: { name: string; color: string }): PresencePeer[] {
    this.peers.set(peerId, { id: peerId, name: value.name, color: value.color, lastSeen: Date.now() });
    return this.list();
  }

  /** Heartbeat + optional cursor update; returns the fresh peer list. */
  heartbeat(peerId: string, widgetId?: string): PresencePeer[] {
    const existing = this.peers.get(peerId);
    if (!existing) return this.list();
    this.peers.set(peerId, { ...existing, lastSeen: Date.now(), ...(widgetId !== undefined ? { widgetId } : {}) });
    return this.list();
  }

  leave(peerId: string): PresencePeer[] {
    this.peers.delete(peerId);
    return this.list();
  }

  /** Live peers with TTL garbage collection applied. */
  list(): PresencePeer[] {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_TTL_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    const out = [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (changed) this.events.onPeersChange?.(out);
    return out;
  }

  get size(): number {
    return this.peers.size;
  }
}

// ---------------------------------------------------------------------------
// Registry (per process; the API route is the only production caller)
// ---------------------------------------------------------------------------

const rooms = new Map<string, PresenceRoom>();

export type PresenceOptions = PresenceRoomEvents;

export function getPresenceRoom(key: string, options: PresenceOptions = {}): PresenceRoom {
  let room = rooms.get(key);
  if (!room) {
    room = new PresenceRoom(key, options);
    rooms.set(key, room);
  }
  return room;
}

export function dropPresenceRoom(key: string): void {
  rooms.delete(key);
}

/** Test/maintenance hook: drop every empty room, returns dropped count. */
export function dropEmptyPresenceRooms(): number {
  let dropped = 0;
  for (const [key, room] of rooms) {
    if (room.size === 0) {
      rooms.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** Test hook: active presence room keys. */
export function activePresenceRoomKeys(): string[] {
  return [...rooms.keys()];
}

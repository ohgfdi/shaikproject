/**
 * Dashboard widget CRDT collaboration (WS4).
 *
 * Extends the notebook Yjs-based collaboration to dashboard widgets.
 * Each widget gets its own Y.Text/Y.Map for collaborative editing of:
 * - Chart specs (config, data transforms)
 * - Table specs (columns, sorting, filters)
 * - Text/markdown widgets
 * - Filter controls
 */

import * as Y from "yjs";

export interface WidgetCollabState {
  widgetId: string;
  type: "chart" | "table" | "text" | "filter" | "kpi" | "pivot";
  spec: Record<string, unknown>; // JSON-serializable widget specification
  version: number;
}

const WIDGETS_KEY = "widgets"; // Y.Map<string, Y.Map<string, unknown>> - widget specs by ID
const WIDGET_ORDER_KEY = "widgetOrder"; // Y.Array<string> - widget z-order
const WIDGET_LOCKS_KEY = "widgetLocks"; // Y.Map<string, { peerId: string; at: number }> - editing locks

export interface DashboardCollabEvents {
  onWidgetChange?: (widgetId: string, spec: Record<string, unknown>) => void;
  onWidgetLock?: (widgetId: string, peerId: string | null) => void;
  onWidgetOrderChange?: (order: string[]) => void;
  onPeersChange?: (peers: DashboardPeer[]) => void;
}

export interface DashboardPeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  widgetId?: string; // Currently focused widget
  cursor?: { x: number; y: number }; // Viewport cursor position
}

const PRESENCE_KEY = "__presence";
const PRESENCE_TTL_MS = 30_000;
const LOCK_TTL_MS = 10_000; // Auto-release lock after 10s inactivity

export class DashboardCollabRoom {
  readonly doc = new Y.Doc();
  readonly dashboardId: string;
  private connections = new Set<string>();
  private waiters = new Map<string, (update: Uint8Array, from: string) => void>();
  private events: DashboardCollabEvents;
  private presenceCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lockCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dashboardId: string, events: DashboardCollabEvents = {}) {
    this.dashboardId = dashboardId;
    this.events = events;

    // Cleanup stale presence
    this.presenceCleanupTimer = setInterval(() => this.cleanupPresence(), PRESENCE_TTL_MS);
    this.presenceCleanupTimer.unref?.();

    // Cleanup stale locks
    this.lockCleanupTimer = setInterval(() => this.cleanupLocks(), 5_000);
    this.lockCleanupTimer.unref?.();
  }

  private cleanupPresence(): void {
    const presence = this.doc.getMap(PRESENCE_KEY);
    const now = Date.now();
    let changed = false;
    for (const [id, raw] of presence.entries()) {
      const value = raw as { at: number };
      if (now - (value.at ?? 0) > PRESENCE_TTL_MS) {
        presence.delete(id);
        changed = true;
      }
    }
    if (changed) this.events.onPeersChange?.(this.peers());
  }

  private cleanupLocks(): void {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const now = Date.now();
    for (const [widgetId, raw] of locks.entries()) {
      const value = raw as { at: number; peerId: string };
      if (now - (value.at ?? 0) > LOCK_TTL_MS) {
        locks.delete(widgetId);
        // Notify per expiry — consumers track locks individually, so there is
        // no aggregate change flag to raise here.
        this.events.onWidgetLock?.(widgetId, null);
      }
    }
  }

  connect(peerId: string): void {
    this.connections.add(peerId);
  }

  disconnect(peerId: string): void {
    this.connections.delete(peerId);
    this.waiters.delete(peerId);
    // Remove presence
    this.doc.getMap(PRESENCE_KEY).delete(peerId);
    // Release any locks held by this peer
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    for (const [widgetId, raw] of locks.entries()) {
      const value = raw as { peerId: string };
      if (value.peerId === peerId) {
        locks.delete(widgetId);
        this.events.onWidgetLock?.(widgetId, null);
      }
    }
  }

  isConnected(peerId: string): boolean {
    return this.connections.has(peerId);
  }

  /** Full document state for joining client. */
  stateAsUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Apply a client update and return it for broadcast. */
  applyUpdate(update: Uint8Array): Uint8Array | null {
    const before = Y.encodeStateAsUpdate(this.doc);
    Y.applyUpdate(this.doc, update);
    const after = Y.encodeStateAsUpdate(this.doc);
    if (before.length === after.length && Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0) {
      return null;
    }
    return update;
  }

  subscribe(peerId: string, fn: (update: Uint8Array) => void): void {
    this.waiters.set(peerId, fn as unknown as (update: Uint8Array, from: string) => void);
  }

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

  /** Convergence update for a JOINING peer. */
  async joinState(): Promise<{ update: Uint8Array; peers: DashboardPeer[] }> {
    return { update: this.stateAsUpdate(), peers: this.peers() };
  }

  getAllLocks(): Record<string, { peerId: string; at: number }> {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const result: Record<string, { peerId: string; at: number }> = {};
    for (const [widgetId, raw] of locks.entries()) {
      const value = raw as { peerId: string; at: number };
      result[widgetId] = { peerId: value.peerId, at: value.at };
    }
    return result;
  }

  // ------------------------------------------------------------------------
  // Widget CRDT operations
  // ------------------------------------------------------------------------

  /** Get widget spec map (creates if missing). */
  private getWidgetMap(widgetId: string): Y.Map<unknown> {
    const widgets = this.doc.getMap(WIDGETS_KEY);
    let widgetMap = widgets.get(widgetId) as Y.Map<unknown> | undefined;
    if (!widgetMap) {
      widgetMap = new Y.Map();
      widgets.set(widgetId, widgetMap);
    }
    return widgetMap;
  }

  /** Set/update a widget's full spec (merged deeply). */
  setWidgetSpec(
    _peerId: string,
    widgetId: string,
    type: WidgetCollabState["type"],
    spec: Record<string, unknown>,
  ): void {
    const widgetMap = this.getWidgetMap(widgetId);
    this.doc.transact(() => {
      widgetMap.set("type", type);
      widgetMap.set("spec", JSON.stringify(spec));
      widgetMap.set("version", Number(widgetMap.get("version") ?? 0) + 1);
    });
    this.events.onWidgetChange?.(widgetId, spec);
  }

  /** Deep-merge a partial spec update (for incremental changes). */
  mergeWidgetSpec(_peerId: string, widgetId: string, partialSpec: Record<string, unknown>): Record<string, unknown> {
    const widgetMap = this.getWidgetMap(widgetId);
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(String(widgetMap.get("spec") ?? "{}"));
    } catch {
      current = {};
    }
    const merged = { ...current, ...partialSpec };
    this.doc.transact(() => {
      widgetMap.set("spec", JSON.stringify(merged));
      widgetMap.set("version", Number(widgetMap.get("version") ?? 0) + 1);
    });
    this.events.onWidgetChange?.(widgetId, merged);
    return merged;
  }

  /** Get a widget's current spec. */
  getWidgetSpec(widgetId: string): WidgetCollabState | null {
    const widgetMap = this.getWidgetMap(widgetId);
    const type = widgetMap.get("type") as WidgetCollabState["type"] | undefined;
    if (!type) return null;
    let spec: Record<string, unknown> = {};
    try {
      spec = JSON.parse(String(widgetMap.get("spec") ?? "{}"));
    } catch {
      spec = {};
    }
    return {
      widgetId,
      type,
      spec,
      version: Number(widgetMap.get("version") ?? 0),
    };
  }

  /** Get all widget specs in order. */
  getAllWidgets(): WidgetCollabState[] {
    const widgets = this.doc.getMap(WIDGETS_KEY);
    const order = this.doc.getArray(WIDGET_ORDER_KEY);
    const seen = new Set<string>();
    const result: WidgetCollabState[] = [];

    for (const id of order.toArray()) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const w = this.getWidgetSpec(key);
      if (w) result.push(w);
    }

    // Add any widgets not in order
    for (const [key] of widgets.entries()) {
      if (!seen.has(key)) {
        const w = this.getWidgetSpec(key);
        if (w) result.push(w);
      }
    }
    return result;
  }

  /** Add a new widget. */
  addWidget(_peerId: string, widget: WidgetCollabState): void {
    const widgetMap = this.getWidgetMap(widget.widgetId);
    this.doc.transact(() => {
      widgetMap.set("type", widget.type);
      widgetMap.set("spec", JSON.stringify(widget.spec));
      widgetMap.set("version", 1);
      const order = this.doc.getArray(WIDGET_ORDER_KEY);
      if (!order.toArray().includes(widget.widgetId)) {
        order.push([widget.widgetId]);
      }
    });
    this.events.onWidgetChange?.(widget.widgetId, widget.spec);
    this.events.onWidgetOrderChange?.(this.getWidgetOrder());
  }

  /** Remove a widget. */
  removeWidget(_peerId: string, widgetId: string): void {
    this.doc.transact(() => {
      this.doc.getMap(WIDGETS_KEY).delete(widgetId);
      const order = this.doc.getArray(WIDGET_ORDER_KEY);
      const index = order.toArray().findIndex((v) => String(v) === widgetId);
      if (index >= 0) order.delete(index, 1);
      // Release lock if held
      this.doc.getMap(WIDGET_LOCKS_KEY).delete(widgetId);
    });
    this.events.onWidgetLock?.(widgetId, null);
    this.events.onWidgetOrderChange?.(this.getWidgetOrder());
  }

  /** Reorder widgets. */
  reorderWidgets(_peerId: string, orderedIds: string[]): void {
    this.doc.transact(() => {
      const order = this.doc.getArray(WIDGET_ORDER_KEY);
      order.delete(0, order.length);
      for (const id of orderedIds) {
        order.push([id]);
      }
    });
    this.events.onWidgetOrderChange?.(this.getWidgetOrder());
  }

  getWidgetOrder(): string[] {
    return this.doc.getArray(WIDGET_ORDER_KEY).toArray().map(String);
  }

  // ------------------------------------------------------------------------
  // Locking (prevent simultaneous edits)
  // ------------------------------------------------------------------------

  /** Try to acquire a lock on a widget. Returns true if acquired. */
  acquireLock(peerId: string, widgetId: string): boolean {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const existing = locks.get(widgetId) as { peerId: string; at: number } | undefined;

    if (existing && existing.peerId !== peerId) {
      // Another peer holds the lock - check if stale
      if (Date.now() - existing.at < LOCK_TTL_MS) {
        return false; // Lock held by another active peer
      }
      // Stale lock - steal it
    }

    locks.set(widgetId, { peerId, at: Date.now() });
    this.events.onWidgetLock?.(widgetId, peerId);
    return true;
  }

  /** Release a lock (only if owner). */
  releaseLock(peerId: string, widgetId: string): boolean {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const existing = locks.get(widgetId) as { peerId: string } | undefined;
    if (existing && existing.peerId === peerId) {
      locks.delete(widgetId);
      this.events.onWidgetLock?.(widgetId, null);
      return true;
    }
    return false;
  }

  /** Refresh lock TTL (call periodically while editing). */
  refreshLock(peerId: string, widgetId: string): boolean {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const existing = locks.get(widgetId) as { peerId: string } | undefined;
    if (existing && existing.peerId === peerId) {
      locks.set(widgetId, { peerId, at: Date.now() });
      return true;
    }
    return false;
  }

  getLock(widgetId: string): { peerId: string; at: number } | null {
    const locks = this.doc.getMap(WIDGET_LOCKS_KEY);
    const value = locks.get(widgetId) as { peerId: string; at: number } | undefined;
    return value ?? null;
  }

  // ------------------------------------------------------------------------
  // Presence
  // ------------------------------------------------------------------------

  setPresence(
    peerId: string,
    value: { name: string; color: string; widgetId?: string; cursor?: { x: number; y: number } },
  ): DashboardPeer[] {
    const presence = this.doc.getMap(PRESENCE_KEY);
    presence.set(peerId, { ...value, at: Date.now() });
    return this.peers();
  }

  setCursor(peerId: string, x: number, y: number): DashboardPeer[] {
    const presence = this.doc.getMap(PRESENCE_KEY);
    const existing = presence.get(peerId) as { name: string; color: string; widgetId?: string } | undefined;
    if (!existing) return this.peers();
    presence.set(peerId, { ...existing, cursor: { x, y }, at: Date.now() });
    return this.peers();
  }

  peers(): DashboardPeer[] {
    const presence = this.doc.getMap(PRESENCE_KEY);
    const now = Date.now();
    const peers: DashboardPeer[] = [];
    for (const [id, raw] of presence.entries()) {
      const value = raw as {
        name: string;
        color: string;
        at: number;
        widgetId?: string;
        cursor?: { x: number; y: number };
      };
      if (!value || typeof value !== "object") continue;
      if (now - (value.at ?? 0) > PRESENCE_TTL_MS) {
        presence.delete(id);
        continue;
      }
      peers.push({
        id,
        name: value.name ?? "Anonymous",
        color: value.color ?? "#888",
        lastSeen: value.at ?? 0,
        widgetId: value.widgetId,
        cursor: value.cursor,
      });
    }
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  destroy(): void {
    if (this.presenceCleanupTimer) clearInterval(this.presenceCleanupTimer);
    if (this.lockCleanupTimer) clearInterval(this.lockCleanupTimer);
    this.waiters.clear();
    this.connections.clear();
    this.doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Room registry (per process)
// ---------------------------------------------------------------------------

const dashboardRooms = new Map<string, DashboardCollabRoom>();

export type DashboardRoomOptions = DashboardCollabEvents;

export function getDashboardCollabRoom(dashboardId: string, options: DashboardRoomOptions = {}): DashboardCollabRoom {
  let room = dashboardRooms.get(dashboardId);
  if (!room) {
    room = new DashboardCollabRoom(dashboardId, options);
    dashboardRooms.set(dashboardId, room);
  }
  return room;
}

export function dropDashboardCollabRoom(dashboardId: string): void {
  const room = dashboardRooms.get(dashboardId);
  if (room) {
    room.destroy();
    dashboardRooms.delete(dashboardId);
  }
}

export function activeDashboardCollabRooms(): string[] {
  return [...dashboardRooms.keys()];
}

/**
 * Seed a dashboard room from persisted dashboard JSON.
 * Expected dashboard.widgets format: { [widgetId]: { type, spec, ... } }
 */
export function seedDashboardRoom(
  room: DashboardCollabRoom,
  widgets: Record<string, { type: string; spec: Record<string, unknown> }>,
): void {
  room.doc.transact(() => {
    const widgetsMap = room.doc.getMap(WIDGETS_KEY);
    for (const [widgetId, widget] of Object.entries(widgets)) {
      let widgetMap = widgetsMap.get(widgetId) as Y.Map<unknown> | undefined;
      if (!widgetMap) {
        widgetMap = new Y.Map();
        widgetsMap.set(widgetId, widgetMap);
      }
      widgetMap.set("type", widget.type);
      widgetMap.set("spec", JSON.stringify(widget.spec));
      widgetMap.set("version", 1);
    }
    const order = room.doc.getArray(WIDGET_ORDER_KEY);
    for (const widgetId of Object.keys(widgets)) {
      if (!order.toArray().includes(widgetId)) {
        order.push([widgetId]);
      }
    }
  });
}

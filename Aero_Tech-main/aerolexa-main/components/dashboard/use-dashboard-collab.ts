"use client";

/**
 * Real-time dashboard widget collaboration client (WS4).
 * Full CRDT sync for widget specs, locks, presence, and cursors.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";

export interface DashboardPeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  widgetId?: string;
  cursor?: { x: number; y: number };
  role: "editor" | "viewer";
}

export interface WidgetCollabState {
  widgetId: string;
  /** DashboardWidget kind — kept as string so every widget kind can sync. */
  type: string;
  spec: Record<string, unknown>;
  version: number;
}

export interface WidgetLock {
  widgetId: string;
  peerId: string;
  at: number;
}

export interface DashboardCollab {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  online: boolean;
  peerId: string | null;
  role: "editor" | "viewer";
  peers: DashboardPeer[];
  widgets: WidgetCollabState[];
  widgetOrder: string[];
  locks: Record<string, WidgetLock>;
  peerCursors: Map<string, { widgetId: string; x: number; y: number; peerName: string; color: string }>;
  // Actions
  pushWidgetSpec: (widgetId: string, type: string, spec: Record<string, unknown>) => void;
  mergeWidgetSpec: (widgetId: string, partialSpec: Record<string, unknown>) => void;
  addWidget: (widget: WidgetCollabState) => void;
  removeWidget: (widgetId: string) => void;
  reorderWidgets: (order: string[]) => void;
  acquireLock: (widgetId: string) => boolean;
  releaseLock: (widgetId: string) => boolean;
  refreshLock: (widgetId: string) => boolean;
  setCursor: (widgetId: string, x: number, y: number) => void;
  setViewport: (widgetId: string, x: number, y: number) => void;
  pushNow: () => void;
  forceReconnect: () => void;
  pendingCount: number;
  lastSynced: number | null;
  canEdit: (widgetId?: string) => boolean;
}

const WIDGETS_KEY = "widgets";
const WIDGET_ORDER_KEY = "widgetOrder";
const WIDGET_LOCKS_KEY = "widgetLocks";
const PRESENCE_KEY = "__presence";
const PUSH_DEBOUNCE_MS = 120;
const RECONNECT_BASE_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const CURSOR_THROTTLE_MS = 50;

export function useDashboardCollab(
  dashboardId: string | null,
  enabled: boolean,
  initialRole: "editor" | "viewer" = "editor",
): DashboardCollab {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [peers, setPeers] = useState<DashboardPeer[]>([]);
  const [widgets, setWidgets] = useState<WidgetCollabState[]>([]);
  const [widgetOrder, setWidgetOrder] = useState<string[]>([]);
  const [locks, setLocks] = useState<Record<string, WidgetLock>>({});
  const [peerCursors, setPeerCursors] = useState<
    Map<string, { widgetId: string; x: number; y: number; peerName: string; color: string }>
  >(new Map());
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [online, setOnline] = useState(true);

  const peerIdRef = useRef<string | null>(null);
  const roleRef = useRef<"editor" | "viewer">(initialRole);
  const docRef = useRef<Y.Doc | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cursorThrottleRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const disposedRef = useRef(false);

  // `connect` and `scheduleReconnect` are mutually recursive, and the mount
  // effect tears the socket down whenever `connect` changes identity. Reading
  // the connection status straight from React state inside either callback
  // would therefore either capture a stale value or re-dial the stream on
  // every status flip. These mirrors keep the guards accurate without
  // introducing a dependency cycle.
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);

  const markConnected = useCallback((value: boolean) => {
    connectedRef.current = value;
    setConnected(value);
  }, []);

  const markConnecting = useCallback((value: boolean) => {
    connectingRef.current = value;
    setConnecting(value);
  }, []);

  // -----------------------------------------------------------------------
  // Read helpers
  // -----------------------------------------------------------------------
  const readWidgets = useCallback((): WidgetCollabState[] => {
    const doc = docRef.current;
    if (!doc) return [];
    const widgetsMap = doc.getMap(WIDGETS_KEY);
    const order = doc.getArray(WIDGET_ORDER_KEY);
    const seen = new Set<string>();
    const result: WidgetCollabState[] = [];

    for (const id of order.toArray()) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const widgetMap = widgetsMap.get(key) as Y.Map<unknown> | undefined;
      if (widgetMap) {
        const type = widgetMap.get("type") as string | undefined;
        if (type) {
          let spec: Record<string, unknown> = {};
          try {
            spec = JSON.parse(String(widgetMap.get("spec") ?? "{}"));
          } catch {
            spec = {};
          }
          result.push({
            widgetId: key,
            type,
            spec,
            version: Number(widgetMap.get("version") ?? 0),
          });
        }
      }
    }

    // Add any widgets not in order
    for (const [key, widgetMap] of widgetsMap.entries()) {
      if (seen.has(key)) continue;
      if (!(widgetMap instanceof Y.Map)) continue;
      const type = widgetMap.get("type") as string | undefined;
      if (!type) continue;
      let spec: Record<string, unknown> = {};
      try {
        spec = JSON.parse(String(widgetMap.get("spec") ?? "{}"));
      } catch {
        spec = {};
      }
      result.push({
        widgetId: key,
        type,
        spec,
        version: Number(widgetMap.get("version") ?? 0),
      });
    }
    return result;
  }, []);

  const readWidgetOrder = useCallback((): string[] => {
    const doc = docRef.current;
    if (!doc) return [];
    return doc.getArray(WIDGET_ORDER_KEY).toArray().map(String);
  }, []);

  const readLocks = useCallback((): Record<string, WidgetLock> => {
    const doc = docRef.current;
    if (!doc) return {};
    const locksMap = doc.getMap(WIDGET_LOCKS_KEY);
    const result: Record<string, WidgetLock> = {};
    for (const [widgetId, raw] of locksMap.entries()) {
      const value = raw as { peerId: string; at: number };
      result[widgetId] = { widgetId, peerId: value.peerId, at: value.at };
    }
    return result;
  }, []);

  const readPeerCursors = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return new Map();
    const presence = doc.getMap(PRESENCE_KEY);
    const now = Date.now();
    const cursors = new Map<string, { widgetId: string; x: number; y: number; peerName: string; color: string }>();
    for (const [id, raw] of presence.entries()) {
      const value = raw as {
        name: string;
        color: string;
        at: number;
        widgetId?: string;
        cursor?: { x: number; y: number };
      };
      if (!value || typeof value !== "object") continue;
      if (now - (value.at ?? 0) > 30_000) continue;
      if (id === peerIdRef.current) continue;
      if (value.widgetId && value.cursor) {
        cursors.set(id, {
          widgetId: value.widgetId,
          x: value.cursor.x,
          y: value.cursor.y,
          peerName: value.name ?? "Anonymous",
          color: value.color ?? "#888",
        });
      }
    }
    return cursors;
  }, []);

  // -----------------------------------------------------------------------
  // Push to server
  // -----------------------------------------------------------------------
  const pushNow = useCallback(async () => {
    const doc = docRef.current;
    const peerId = peerIdRef.current;
    if (!doc || !peerId || pendingRef.current || !dashboardId) return;

    pendingRef.current = true;
    setPendingCount(1);
    try {
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
      const res = await fetch(`/api/dashboards/${dashboardId}/collab/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update, peerId }),
        keepalive: true,
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (data.ok) {
        setLastSynced(Date.now());
      }
    } catch {
      // Silent fail - will retry
    } finally {
      pendingRef.current = false;
      setPendingCount(0);
    }
  }, [dashboardId]);

  const schedulePush = useCallback(() => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    // Local edits are queued but not yet acknowledged by the server, so the
    // consumer-visible `pendingCount` is 1 until the flush completes.
    setPendingCount(1);
    pushTimer.current = setTimeout(pushNow, PUSH_DEBOUNCE_MS);
  }, [pushNow]);

  // -----------------------------------------------------------------------
  // Online/offline
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOnline(navigator.onLine);
    const onOnline = () => {
      setOnline(true);
      setReconnecting(false);
      reconnectAttempt.current = 0;
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // -----------------------------------------------------------------------
  // Connection lifecycle with recovery
  // -----------------------------------------------------------------------
  const connect = useCallback(() => {
    if (!dashboardId || !enabled || disposedRef.current) return;
    if (connectingRef.current || connectedRef.current) return;

    markConnecting(true);
    const doc = new Y.Doc();
    docRef.current = doc;

    let es: EventSource | null = null;

    const announcePresence = () => {
      const presence = doc.getMap(PRESENCE_KEY);
      const peerId = peerIdRef.current;
      if (!peerId) return;
      const existing = presence.get(peerId) as { name?: string; color?: string; role?: string } | undefined;
      presence.set(peerId, {
        name: existing?.name ?? "You",
        color: existing?.color ?? "#5AA8AA",
        role: roleRef.current,
        at: Date.now(),
      });
      schedulePush();
    };

    const applyServerUpdate = (b64: string) => {
      try {
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, "base64")), "server");
        setWidgets(readWidgets());
        setWidgetOrder(readWidgetOrder());
        setLocks(readLocks());
        setPeerCursors(readPeerCursors());
      } catch {
        // Malformed update - ignore
      }
    };

    doc.on("update", () => {
      setWidgets(readWidgets());
      setWidgetOrder(readWidgetOrder());
      setLocks(readLocks());
      setPeerCursors(readPeerCursors());
      schedulePush();
    });

    es = new EventSource(`/api/dashboards/${dashboardId}/collab`);
    esRef.current = es;

    es.addEventListener("state", (evt) => {
      if (disposedRef.current) return;
      const data = JSON.parse((evt as MessageEvent).data) as {
        peerId: string;
        update: string;
        peers: DashboardPeer[];
        widgets: WidgetCollabState[];
        widgetOrder: string[];
        locks: Record<string, WidgetLock>;
        role: "editor" | "viewer";
      };
      peerIdRef.current = data.peerId;
      roleRef.current = data.role ?? initialRole;
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(data.update, "base64")), "server");
      markConnected(true);
      markConnecting(false);
      setReconnecting(false);
      reconnectAttempt.current = 0;
      setPeers(data.peers ?? []);
      setWidgets(data.widgets ?? []);
      setWidgetOrder(data.widgetOrder ?? []);
      setLocks(data.locks ?? {});
      announcePresence();
    });

    es.addEventListener("update", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { update: string };
      if (!disposedRef.current) applyServerUpdate(data.update);
    });

    // These two events are pure invalidations — the authoritative state is
    // re-read from the CRDT rather than taken from the event payload.
    es.addEventListener("widget:change", () => {
      if (!disposedRef.current) setWidgets(readWidgets());
    });

    es.addEventListener("widget:lock", () => {
      if (!disposedRef.current) setLocks(readLocks());
    });

    es.addEventListener("widget:order", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { order: string[] };
      if (!disposedRef.current) setWidgetOrder(data.order);
    });

    es.addEventListener("peers", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { peers: DashboardPeer[] };
      if (!disposedRef.current) setPeers(data.peers ?? []);
    });

    es.onerror = () => {
      if (disposedRef.current) return;
      markConnected(false);
      markConnecting(false);
      es?.close();
      scheduleReconnectRef.current?.();
    };

    announcePresence();

    heartbeatTimer.current = setInterval(announcePresence, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      es?.close();
      esRef.current = null;
      doc.destroy();
      docRef.current = null;
      markConnected(false);
      markConnecting(false);
      setPeers([]);
      setWidgets([]);
      setWidgetOrder([]);
      setLocks({});
    };
  }, [
    dashboardId,
    enabled,
    initialRole,
    readWidgets,
    readWidgetOrder,
    readLocks,
    readPeerCursors,
    schedulePush,
    markConnected,
    markConnecting,
  ]);

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current || connectedRef.current || connectingRef.current) return;
    // A timer already in flight means a retry is already pending; stacking a
    // second one would multiply the dial rate on a flapping connection.
    if (reconnectTimer.current) return;
    setReconnecting(true);
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt.current), MAX_RECONNECT_MS);
    reconnectAttempt.current += 1;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      if (!disposedRef.current) {
        connect();
      }
    }, delay);
  }, [connect]);

  // Publish the latest scheduler so `connect` can reach it without taking a
  // dependency on it (see the note on `scheduleReconnectRef` above).
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  const forceReconnect = useCallback(() => {
    reconnectAttempt.current = 0;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (docRef.current) {
      docRef.current.destroy();
      docRef.current = null;
    }
    markConnected(false);
    setReconnecting(false);
    connect();
  }, [connect, markConnected]);

  // -----------------------------------------------------------------------
  // Mount connection
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!dashboardId || !enabled) return;
    const cleanup = connect();
    return () => {
      disposedRef.current = true;
      cleanup?.();
    };
  }, [dashboardId, enabled, connect]);

  // -----------------------------------------------------------------------
  // Widget operations
  // -----------------------------------------------------------------------
  const pushWidgetSpec = useCallback(
    (widgetId: string, type: string, spec: Record<string, unknown>) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;
      if (roleRef.current === "viewer") return;

      const widgetsMap = doc.getMap(WIDGETS_KEY);
      let widgetMap = widgetsMap.get(widgetId) as Y.Map<unknown> | undefined;
      if (!widgetMap) {
        widgetMap = new Y.Map();
        widgetsMap.set(widgetId, widgetMap);
      }
      doc.transact(() => {
        widgetMap.set("type", type);
        widgetMap.set("spec", JSON.stringify(spec));
        widgetMap.set("version", Number(widgetMap.get("version") ?? 0) + 1);
      });
      setWidgets(readWidgets());
      schedulePush();
    },
    [readWidgets, schedulePush],
  );

  const mergeWidgetSpec = useCallback(
    (widgetId: string, partialSpec: Record<string, unknown>) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;
      if (roleRef.current === "viewer") return;

      const widgetsMap = doc.getMap(WIDGETS_KEY);
      let widgetMap = widgetsMap.get(widgetId) as Y.Map<unknown> | undefined;
      if (!widgetMap) {
        widgetMap = new Y.Map();
        widgetsMap.set(widgetId, widgetMap);
      }
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(String(widgetMap.get("spec") ?? "{}"));
      } catch {
        current = {};
      }
      const merged = { ...current, ...partialSpec };
      doc.transact(() => {
        widgetMap.set("spec", JSON.stringify(merged));
        widgetMap.set("version", Number(widgetMap.get("version") ?? 0) + 1);
      });
      setWidgets(readWidgets());
      schedulePush();
    },
    [readWidgets, schedulePush],
  );

  const addWidget = useCallback(
    (widget: WidgetCollabState) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;
      if (roleRef.current === "viewer") return;

      const widgetsMap = doc.getMap(WIDGETS_KEY);
      let widgetMap = widgetsMap.get(widget.widgetId) as Y.Map<unknown> | undefined;
      if (!widgetMap) {
        widgetMap = new Y.Map();
        widgetsMap.set(widget.widgetId, widgetMap);
      }
      doc.transact(() => {
        widgetMap.set("type", widget.type);
        widgetMap.set("spec", JSON.stringify(widget.spec));
        widgetMap.set("version", 1);
        const order = doc.getArray(WIDGET_ORDER_KEY);
        if (!order.toArray().includes(widget.widgetId)) {
          order.push([widget.widgetId]);
        }
      });
      setWidgets(readWidgets());
      setWidgetOrder(readWidgetOrder());
      schedulePush();
    },
    [readWidgets, readWidgetOrder, schedulePush],
  );

  const removeWidget = useCallback(
    (widgetId: string) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;
      if (roleRef.current === "viewer") return;

      doc.transact(() => {
        doc.getMap(WIDGETS_KEY).delete(widgetId);
        const order = doc.getArray(WIDGET_ORDER_KEY);
        const index = order.toArray().findIndex((v) => String(v) === widgetId);
        if (index >= 0) order.delete(index, 1);
        doc.getMap(WIDGET_LOCKS_KEY).delete(widgetId);
      });
      setWidgets(readWidgets());
      setWidgetOrder(readWidgetOrder());
      setLocks(readLocks());
      schedulePush();
    },
    [readWidgets, readWidgetOrder, readLocks, schedulePush],
  );

  const reorderWidgets = useCallback(
    (order: string[]) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;
      if (roleRef.current === "viewer") return;

      doc.transact(() => {
        const orderArr = doc.getArray(WIDGET_ORDER_KEY);
        orderArr.delete(0, orderArr.length);
        for (const id of order) {
          orderArr.push([id]);
        }
      });
      setWidgetOrder(order);
      schedulePush();
    },
    [schedulePush],
  );

  const acquireLock = useCallback(
    (widgetId: string): boolean => {
      // Send lock acquire to server
      fetch(`/api/dashboards/${dashboardId}/collab/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peerIdRef.current, lock: { widgetId, action: "acquire" } }),
        keepalive: true,
      }).catch(() => undefined);
      return true; // Optimistic
    },
    [dashboardId],
  );

  const releaseLock = useCallback(
    (widgetId: string): boolean => {
      fetch(`/api/dashboards/${dashboardId}/collab/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peerIdRef.current, lock: { widgetId, action: "release" } }),
        keepalive: true,
      }).catch(() => undefined);
      return true;
    },
    [dashboardId],
  );

  const refreshLock = useCallback(
    (widgetId: string): boolean => {
      fetch(`/api/dashboards/${dashboardId}/collab/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peerIdRef.current, lock: { widgetId, action: "refresh" } }),
        keepalive: true,
      }).catch(() => undefined);
      return true;
    },
    [dashboardId],
  );

  const setCursor = useCallback(
    (widgetId: string, x: number, y: number) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;

      const presence = doc.getMap(PRESENCE_KEY);
      const existing = presence.get(peerId) as { name?: string; color?: string; widgetId?: string } | undefined;
      presence.set(peerId, {
        ...existing,
        name: existing?.name ?? "You",
        color: existing?.color ?? "#5AA8AA",
        widgetId,
        cursor: { x, y },
        at: Date.now(),
      });
      // Throttle cursor broadcasts
      const key = `${peerId}:${widgetId}`;
      if (cursorThrottleRef.current.has(key)) {
        clearTimeout(cursorThrottleRef.current.get(key)!);
      }
      cursorThrottleRef.current.set(
        key,
        setTimeout(() => schedulePush(), CURSOR_THROTTLE_MS),
      );
    },
    [schedulePush],
  );

  const setViewport = useCallback(
    (widgetId: string, x: number, y: number) => {
      setCursor(widgetId, x, y);
    },
    [setCursor],
  );

  const canEdit = useCallback(
    (widgetId?: string) => {
      if (roleRef.current === "viewer") return false;
      if (!widgetId) return true;
      // Check if another peer has a lock on this widget
      const lock = locks[widgetId];
      if (lock && lock.peerId !== peerIdRef.current) {
        // Check if lock is stale
        if (Date.now() - lock.at < 10_000) {
          return false;
        }
      }
      return true;
    },
    [locks],
  );

  return {
    connected,
    connecting,
    reconnecting,
    online,
    peerId: peerIdRef.current,
    role: roleRef.current,
    peers: peers.filter((p) => p.id !== peerIdRef.current),
    widgets,
    widgetOrder,
    locks,
    peerCursors,
    pushWidgetSpec,
    mergeWidgetSpec,
    addWidget,
    removeWidget,
    reorderWidgets,
    acquireLock,
    releaseLock,
    refreshLock,
    setCursor,
    setViewport,
    pushNow,
    forceReconnect,
    pendingCount,
    lastSynced,
    canEdit,
  };
}

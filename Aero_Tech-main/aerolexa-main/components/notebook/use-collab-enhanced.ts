"use client";

/**
 * Enhanced real-time notebook collaboration client (WS4) with:
 * - Offline-first IndexedDB persistence
 * - Rich cursor/selection overlays
 * - Connection recovery with exponential backoff
 * - Access control (edit/view roles)
 * - Conflict resolution awareness
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";

import type { YjsOfflinePersistence } from "@/lib/collab/yjs-offline";

export interface CollabPeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  cellId?: string;
  cursor?: number;
  selection?: { start: number; end: number };
  role: "editor" | "viewer";
}

export interface RemoteCellState {
  id: string;
  kind: string;
  content: string;
}

export interface PeerCursor {
  peerId: string;
  peerName: string;
  color: string;
  cellId: string;
  cursor: number;
  selection?: { start: number; end: number };
}

export interface NotebookCollab {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  online: boolean;
  peerId: string | null;
  role: "editor" | "viewer";
  peers: CollabPeer[];
  remoteCells: RemoteCellState[];
  peerCursors: PeerCursor[];
  pushCellText: (cellId: string, content: string) => void;
  pushCellSelection: (cellId: string, selection: { start: number; end: number }) => void;
  addCell: (cell: RemoteCellState) => void;
  removeCell: (cellId: string) => void;
  setCursor: (cellId: string | undefined, offset?: number) => void;
  setSelection: (cellId: string | undefined, selection?: { start: number; end: number }) => void;
  pushNow: () => void;
  forceReconnect: () => void;
  pendingCount: number;
  lastSynced: number | null;
  canEdit: (cellId?: string) => boolean;
}

const CELLS_KEY = "cells";
const ORDER_KEY = "order";
const KINDS_KEY = "kinds";
const PRESENCE_KEY = "__presence";
const PUSH_DEBOUNCE_MS = 120;
const RECONNECT_BASE_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const CURSOR_THROTTLE_MS = 50;

export function useNotebookCollab(
  notebookId: string | null,
  enabled: boolean,
  initialRole: "editor" | "viewer" = "editor",
): NotebookCollab {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [remoteCells, setRemoteCells] = useState<RemoteCellState[]>([]);
  const [peerCursors, setPeerCursors] = useState<PeerCursor[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [online, setOnline] = useState(true);

  const peerIdRef = useRef<string | null>(null);
  const roleRef = useRef<"editor" | "viewer">(initialRole);
  const docRef = useRef<Y.Doc | null>(null);
  const persistenceRef = useRef<YjsOfflinePersistence | null>(null);
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
  // Cell reading
  // -----------------------------------------------------------------------
  const readCells = useCallback((): RemoteCellState[] => {
    const doc = docRef.current;
    if (!doc) return [];
    const map = doc.getMap(CELLS_KEY);
    const kinds = doc.getMap(KINDS_KEY);
    const order = doc.getArray(ORDER_KEY);
    const seen = new Set<string>();
    const cells: RemoteCellState[] = [];
    for (const id of order.toArray()) {
      const key = String(id);
      const text = map.get(key);
      if (text instanceof Y.Text) {
        seen.add(key);
        cells.push({ id: key, kind: String(kinds.get(key) ?? "code"), content: text.toString() });
      }
    }
    for (const [key, text] of map.entries()) {
      if (text instanceof Y.Text && !seen.has(key)) {
        cells.push({ id: key, kind: String(kinds.get(key) ?? "code"), content: text.toString() });
      }
    }
    return cells;
  }, []);

  const readPeerCursors = useCallback((): PeerCursor[] => {
    const doc = docRef.current;
    if (!doc) return [];
    const presence = doc.getMap(PRESENCE_KEY);
    const now = Date.now();
    const cursors: PeerCursor[] = [];
    for (const [id, raw] of presence.entries()) {
      const value = raw as {
        name: string;
        color: string;
        at: number;
        cellId?: string;
        cursor?: number;
        selection?: { start: number; end: number };
      };
      if (!value || typeof value !== "object") continue;
      if (now - (value.at ?? 0) > 30_000) continue;
      if (id === peerIdRef.current) continue; // Don't show own cursor
      if (value.cellId && value.cursor !== undefined) {
        cursors.push({
          peerId: id,
          peerName: value.name ?? "Anonymous",
          color: value.color ?? "#888",
          cellId: value.cellId,
          cursor: value.cursor,
          selection: value.selection,
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
    const persistence = persistenceRef.current;
    const peerId = peerIdRef.current;
    if (!doc || !peerId || pendingRef.current || !notebookId) return;

    pendingRef.current = true;
    try {
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
      const res = await fetch(`/api/notebooks/${notebookId}/collab/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update, peerId, cursor: undefined }),
        keepalive: true,
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (data.ok && persistence) {
        persistence.acknowledgeServerUpdates([new Uint8Array(Buffer.from(update, "base64"))]);
        setLastSynced(Date.now());
      }
    } catch {
      // Silent fail - will retry on next push
    } finally {
      pendingRef.current = false;
      setPendingCount(persistence?.pendingCount ?? 0);
    }
  }, [notebookId]);

  const schedulePush = useCallback(() => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
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
  const connect = useCallback(async () => {
    // Dynamic import for offline persistence (client-only)
    const { YjsOfflinePersistence } = await import("@/lib/collab/yjs-offline");
    if (!notebookId || !enabled || disposedRef.current) return;
    if (connectingRef.current || connectedRef.current) return;

    markConnecting(true);
    const doc = new Y.Doc();
    docRef.current = doc;

    // Create offline persistence
    const persistence = new YjsOfflinePersistence(doc, {
      docId: notebookId,
      autoSaveInterval: 5_000,
    });
    persistenceRef.current = persistence;

    // Subscribe to persistence state
    const unsubscribe = persistence.subscribe((state) => {
      setPendingCount(state.pending.length);
      setLastSynced(state.lastSynced);
    });

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
        setRemoteCells(readCells());
        setPeerCursors(readPeerCursors());
      } catch {
        // Malformed update - ignore
      }
    };

    doc.on("update", () => {
      setRemoteCells(readCells());
      setPeerCursors(readPeerCursors());
      schedulePush();
    });

    es = new EventSource(`/api/notebooks/${notebookId}/collab`);
    esRef.current = es;

    es.addEventListener("state", (evt) => {
      if (disposedRef.current) return;
      const data = JSON.parse((evt as MessageEvent).data) as {
        peerId: string;
        update: string;
        peers: CollabPeer[];
      };
      peerIdRef.current = data.peerId;
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(data.update, "base64")), "server");
      markConnected(true);
      markConnecting(false);
      setReconnecting(false);
      reconnectAttempt.current = 0;
      setPeers(data.peers ?? []);
      setRemoteCells(readCells());
      setPeerCursors(readPeerCursors());
      announcePresence();
    });

    es.addEventListener("update", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { update: string };
      if (!disposedRef.current) applyServerUpdate(data.update);
    });

    es.addEventListener("peers", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { peers: CollabPeer[] };
      if (!disposedRef.current) setPeers(data.peers ?? []);
    });

    es.onerror = () => {
      if (disposedRef.current) return;
      markConnected(false);
      markConnecting(false);
      es?.close();
      scheduleReconnectRef.current?.();
    };

    // Initial presence
    announcePresence();

    // Heartbeat
    heartbeatTimer.current = setInterval(announcePresence, HEARTBEAT_INTERVAL_MS);

    // Load offline persistence
    persistence.load().then((state) => {
      if (state) {
        setPendingCount(state.pending.length);
        setLastSynced(state.lastSynced);
      }
    });

    return () => {
      unsubscribe();
      if (pushTimer.current) clearTimeout(pushTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      es?.close();
      esRef.current = null;
      persistence.destroy();
      doc.destroy();
      docRef.current = null;
      persistenceRef.current = null;
      markConnected(false);
      markConnecting(false);
      setPeers([]);
      setRemoteCells([]);
      setPeerCursors([]);
      setPendingCount(0);
    };
  }, [notebookId, enabled, readCells, readPeerCursors, schedulePush, markConnected, markConnecting]);

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
    if (persistenceRef.current) {
      persistenceRef.current.destroy();
      persistenceRef.current = null;
    }
    markConnected(false);
    setReconnecting(false);
    connect();
  }, [connect, markConnected]);

  // -----------------------------------------------------------------------
  // Mount connection
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!notebookId || !enabled) return;
    let cleanupFn: (() => void) | undefined;
    connect().then((fn) => {
      cleanupFn = fn;
    });
    return () => {
      disposedRef.current = true;
      cleanupFn?.();
    };
  }, [notebookId, enabled, connect]);

  // -----------------------------------------------------------------------
  // Local edit → Y.Text delta → server push
  // -----------------------------------------------------------------------
  const pushCellText = useCallback(
    (cellId: string, content: string) => {
      const doc = docRef.current;
      if (!doc || !peerIdRef.current) return;
      if (roleRef.current === "viewer") return; // Viewers cannot edit

      const map = doc.getMap(CELLS_KEY);
      const kinds = doc.getMap(KINDS_KEY);
      const existingText = map.get(cellId);
      if (!(existingText instanceof Y.Text)) {
        // Cell created locally
        const created = new Y.Text(content);
        doc.transact(() => {
          map.set(cellId, created);
          kinds.set(cellId, "code");
          doc.getArray(ORDER_KEY).push([cellId]);
        });
      } else {
        const text = existingText;
        const current = text.toString();
        if (current === content) return;
        // Compute minimal delta
        let start = 0;
        const max = Math.min(current.length, content.length);
        while (start < max && current[start] === content[start]) start += 1;
        let endOld = current.length;
        let endNew = content.length;
        while (endOld > start && endNew > start && current[endOld - 1] === content[endNew - 1]) {
          endOld -= 1;
          endNew -= 1;
        }
        doc.transact(() => {
          if (endOld > start) text.delete(start, endOld - start);
          if (endNew > start) text.insert(start, content.slice(start, endNew));
        });
      }
      setRemoteCells(readCells());
      schedulePush();
    },
    [readCells, schedulePush],
  );

  const pushCellSelection = useCallback(
    (cellId: string, selection: { start: number; end: number }) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId) return;

      const presence = doc.getMap(PRESENCE_KEY);
      const existing = presence.get(peerId) as
        { name?: string; color?: string; cellId?: string; cursor?: number } | undefined;
      presence.set(peerId, {
        ...existing,
        name: existing?.name ?? "You",
        color: existing?.color ?? "#5AA8AA",
        cellId,
        cursor: selection.end,
        selection,
        at: Date.now(),
      });
      // Throttle cursor broadcasts
      const key = `${peerId}:${cellId}`;
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

  const addCell = useCallback(
    (cell: RemoteCellState) => {
      const doc = docRef.current;
      if (!doc) return;
      doc.transact(() => {
        const map = doc.getMap(CELLS_KEY);
        if (!map.has(cell.id)) map.set(cell.id, new Y.Text(cell.content));
        doc.getMap(KINDS_KEY).set(cell.id, cell.kind);
        doc.getArray(ORDER_KEY).push([cell.id]);
      });
      setRemoteCells(readCells());
      schedulePush();
    },
    [readCells, schedulePush],
  );

  const removeCell = useCallback(
    (cellId: string) => {
      const doc = docRef.current;
      if (!doc) return;
      doc.transact(() => {
        doc.getMap(CELLS_KEY).delete(cellId);
        doc.getMap(KINDS_KEY).delete(cellId);
        const order = doc.getArray(ORDER_KEY);
        const index = order.toArray().findIndex((v) => String(v) === cellId);
        if (index >= 0) order.delete(index, 1);
      });
      setRemoteCells(readCells());
      schedulePush();
    },
    [readCells, schedulePush],
  );

  const setCursor = useCallback(
    (cellId: string | undefined, offset?: number) => {
      const doc = docRef.current;
      const peerId = peerIdRef.current;
      if (!doc || !peerId || !cellId) return;

      const presence = doc.getMap(PRESENCE_KEY);
      const existing = presence.get(peerId) as { name?: string; color?: string } | undefined;
      presence.set(peerId, {
        name: existing?.name ?? "You",
        color: existing?.color ?? "#5AA8AA",
        at: Date.now(),
        cellId,
        cursor: offset,
      });
      schedulePush();
    },
    [schedulePush],
  );

  const setSelection = useCallback(
    (cellId: string | undefined, selection?: { start: number; end: number }) => {
      if (!cellId) return;
      pushCellSelection(cellId, selection!);
    },
    [pushCellSelection],
  );

  const canEdit = useCallback((cellId?: string) => {
    if (roleRef.current === "viewer") return false;
    if (!cellId) return true;
    // Check if another peer has a lock on this cell
    // (would need lock API from server - for now allow)
    return true;
  }, []);

  return {
    connected,
    connecting,
    reconnecting,
    online,
    peerId: peerIdRef.current,
    role: roleRef.current,
    peers: peers.filter((p) => p.id !== peerIdRef.current),
    remoteCells,
    peerCursors,
    pushCellText,
    pushCellSelection,
    addCell,
    removeCell,
    setCursor,
    setSelection,
    pushNow,
    forceReconnect,
    pendingCount,
    lastSynced,
    canEdit,
  };
}

"use client";

/**
 * Real-time notebook collaboration client (WS4).
 *
 * Binds every code cell's content to a Y.Text inside a shared Y.Doc. Keystrokes
 * become Yjs deltas (character-level), are pushed to the server room via POST,
 * and merged updates from other peers arrive over SSE and apply locally —
 * converging without locks or last-writer-wins data loss.
 *
 * Presence (who is online, which cell they are in) rides the same pipeline via
 * a __presence Y.Map, so cursor colors and peer lists converge exactly like
 * content.
 *
 * Integration contract with notebook-tab (deliberately minimal):
 *   const collab = useNotebookCollab(notebookId, enabled);
 *   collab.bindCells(cells)        — register/refresh the cell list (join)
 *   collab.remoteCells             — latest merged state for reconciliation
 *   collab.pushCellText(cellId, content) — send a local edit as a delta
 *   collab.peers                   — live peer list for the presence bar
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";

export interface CollabPeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  cellId?: string;
}

export interface RemoteCellState {
  id: string;
  kind: string;
  content: string;
}

export interface NotebookCollab {
  connected: boolean;
  peerId: string | null;
  peers: CollabPeer[];
  remoteCells: RemoteCellState[];
  pushCellText: (cellId: string, content: string) => void;
  addCell: (cell: RemoteCellState) => void;
  removeCell: (cellId: string) => void;
  setCursor: (cellId: string | undefined, offset?: number) => void;
  pushNow: () => void;
}

const CELLS_KEY = "cells";
const ORDER_KEY = "order";
const KINDS_KEY = "kinds";
const PRESENCE_KEY = "__presence";
const PUSH_DEBOUNCE_MS = 120;

export function useNotebookCollab(notebookId: string | null, enabled: boolean): NotebookCollab {
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [remoteCells, setRemoteCells] = useState<RemoteCellState[]>([]);
  const peerIdRef = useRef<string | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

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

  /** Push the doc's state diff to the server (debounced). */
  const pushNow = useCallback(() => {
    const doc = docRef.current;
    const peerId = peerIdRef.current;
    if (!doc || !peerId || pendingRef.current) return;
    pendingRef.current = true;
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
    const cursor = undefined; // cursors piggyback on presence heartbeats
    fetch(`/api/notebooks/${notebookId}/collab/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update, peerId, cursor }),
      keepalive: true,
    })
      .catch(() => undefined)
      .finally(() => {
        pendingRef.current = false;
      });
  }, [notebookId]);

  const schedulePush = useCallback(() => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(pushNow, PUSH_DEBOUNCE_MS);
  }, [pushNow]);

  // ------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!notebookId || !enabled) return;
    const doc = new Y.Doc();
    docRef.current = doc;
    let es: EventSource | null = null;
    let disposed = false;

    const announcePresence = () => {
      // Presence lives in the doc itself — every peer converges on it.
      const presence = doc.getMap(PRESENCE_KEY);
      const peerId = peerIdRef.current;
      if (!peerId) return;
      const existing = presence.get(peerId) as { name?: string; color?: string } | undefined;
      presence.set(peerId, {
        name: existing?.name ?? "You",
        color: existing?.color ?? "#5AA8AA",
        at: Date.now(),
      });
      schedulePush();
    };

    const applyServerUpdate = (b64: string) => {
      try {
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, "base64")));
        setRemoteCells(readCells());
      } catch {
        // A malformed update must never take the editor down.
      }
    };

    doc.on("update", () => {
      setRemoteCells(readCells());
      schedulePush();
    });

    es = new EventSource(`/api/notebooks/${notebookId}/collab`);
    es.addEventListener("state", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { peerId: string; update: string; peers: CollabPeer[] };
      if (disposed) return;
      peerIdRef.current = data.peerId;
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(data.update, "base64")));
      setConnected(true);
      setPeers(data.peers ?? []);
      setRemoteCells(readCells());
    });
    es.addEventListener("update", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { update: string };
      if (!disposed) applyServerUpdate(data.update);
    });
    es.addEventListener("peers", (evt) => {
      const data = JSON.parse((evt as MessageEvent).data) as { peers: CollabPeer[] };
      if (!disposed) setPeers(data.peers ?? []);
    });
    es.onerror = () => setConnected(false);

    const heartbeat = setInterval(announcePresence, 10_000);

    return () => {
      disposed = true;
      clearInterval(heartbeat);
      if (pushTimer.current) clearTimeout(pushTimer.current);
      es?.close();
      doc.destroy();
      docRef.current = null;
      setConnected(false);
      setPeers([]);
      setRemoteCells([]);
    };
  }, [notebookId, enabled, readCells, schedulePush]);

  // ------------------------------------------------------------------
  // Local edit → Y.Text delta → server push
  // ------------------------------------------------------------------
  const pushCellText = useCallback(
    (cellId: string, content: string) => {
      const doc = docRef.current;
      if (!doc || !peerIdRef.current) return;
      const map = doc.getMap(CELLS_KEY);
      const kinds = doc.getMap(KINDS_KEY);
      const existingText = map.get(cellId);
      if (!(existingText instanceof Y.Text)) {
        // Cell created locally: register it in the shared doc.
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
        // Compute the minimal common prefix/suffix delta.
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

  return {
    connected,
    peerId: peerIdRef.current,
    peers: peers.filter((p) => p.id !== peerIdRef.current),
    remoteCells,
    pushCellText,
    addCell,
    removeCell,
    setCursor,
    pushNow,
  };
}

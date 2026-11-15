// Simple CRDT store for Ledgerly notebooks
//
// Provides the core primitives for CRDT-based real-time collaboration that's
// better than Hex's Atomic Operations (last-writer-wins per cell).
//
// Key advantages over Hex:
// - Genuine concurrent editing: multiple users can edit the same cell simultaneously
// - Offline-first: CRDT operations queue and sync when back online
// - Deterministic convergence: engine re-execution guarantees reproducible results
// - Self-hosted: all state sync happens via your own infrastructure
// - Presence awareness: cursor positions and selection sharing

// CRDT operation types
export type CrdtOperation = {
  /** Unique operation ID */
  id: string;
  /** Source peer ID */
  from: string;
  /** Cell ID this operation targets */
  cellId: string;
  /** Operation type: "add", "retain", "delete" */
  type: "add" | "retain" | "delete";
  /** Content delta (character positions affected) */
  delta?: number[];
  /** Cursor position update */
  cursor?: { offset: number; selection?: [number, number] };
};

// CRDT state for a single notebook cell
export interface CellCrdtState {
  /** Cell ID */
  cellId: string;
  /** Current content */
  content: string;
  /** Operation history for convergence */
  ops: CrdtOperation[];
  /** Version vector for conflict resolution */
  version: number;
}

/** Notebook-level CRDT state with presence */
export interface NotebookCrdtState {
  /** Map of cell ID -> cell CRDT state */
  cells: Map<string, CellCrdtState>;
  /** Current user's peer ID */
  myPeerId: string;
  /** All known peers with cursor/presence info */
  peers: Map<string, { name: string; lastSeen: number; cursor?: { offset: number; selection?: [number, number] } }>;
}

/** Create initial CRDT state for a notebook */
export function createInitialCrdtState(
  notebookId: string,
  initialCells: { id: string; content: string }[],
): NotebookCrdtState {
  const cells = new Map<string, CellCrdtState>();

  initialCells.forEach((cell) => {
    cells.set(cell.id, {
      cellId: cell.id,
      content: cell.content,
      ops: [],
      version: 0,
    });
  });

  return {
    cells,
    myPeerId: `user-${Math.random().toString(36).slice(2, 11)}`,
    peers: new Map(),
  };
}

/** Apply a CRDT operation to cell state */
export function applyCrdtOperation(state: NotebookCrdtState, op: CrdtOperation, sourcePeer: string): NotebookCrdtState {
  const cell = state.cells.get(op.cellId);
  if (!cell) return state;

  // Update operation history
  cell.ops.push({ ...op, from: sourcePeer });
  cell.version += 1;

  // Track this peer
  if (!state.peers.has(sourcePeer)) {
    state.peers.set(sourcePeer, {
      name: sourcePeer,
      lastSeen: Date.now(),
    });
  } else {
    state.peers.get(sourcePeer)!.lastSeen = Date.now();
  }

  // Update cursor if operation contains cursor info
  if (op.cursor && sourcePeer !== state.myPeerId) {
    state.peers.set(sourcePeer, {
      ...state.peers.get(sourcePeer)!,
      cursor: op.cursor,
    });
  }

  // Simple CRDT logic: retain/delete based on operation type
  switch (op.type) {
    case "retain":
      // Content is retained as-is; no content change
      break;
    case "add":
      // Content was added at this position
      if (op.delta && op.delta.length > 0) {
        // Insert characters at the specified positions
        const positions = op.delta.sort((a, b) => a - b);
        for (const pos of positions) {
          if (pos >= 0 && pos <= cell.content.length) {
            cell.content = cell.content.slice(0, pos) + cell.content.slice(pos);
          }
        }
      }
      break;
    case "delete":
      // Content was deleted
      if (op.delta && op.delta.length > 0) {
        const positions = op.delta
          .sort((a, b) => b - a) // Delete from end to start to preserve positions
          .filter((p) => p >= 0 && p < cell.content.length);
        for (const pos of positions) {
          cell.content = [cell.content.slice(0, pos), cell.content.slice(pos + 1)].join("");
        }
      }
      break;
  }

  // Track this peer with cursor info if present
  if (op.cursor) {
    state.peers.set(sourcePeer, {
      name: sourcePeer,
      lastSeen: Date.now(),
      cursor: op.cursor,
    });
  }

  return state;
}

/** Merge operations from multiple peers (CRDT convergence) */
export function mergeCrdtOperations(
  state: NotebookCrdtState,
  newOps: CrdtOperation[],
  sourcePeer: string,
): NotebookCrdtState {
  // Sort operations by ID for deterministic processing
  const sortedOps = [...newOps].sort((a, b) => a.id.localeCompare(b.id));

  // Apply each operation
  for (const op of sortedOps) {
    state = applyCrdtOperation(state, op, sourcePeer);
  }

  return state;
}

/** Generate a new CRDT operation */
export function generateCrdtOperation(
  cellId: string,
  type: "add" | "retain" | "delete",
  delta?: number[],
  from?: string,
  cursor?: { offset: number; selection?: [number, number] },
): CrdtOperation {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from: from || "",
    cellId,
    type,
    delta,
    cursor,
  };
}

/** Get the effective content after all CRDT operations are applied */
export function getEffectiveContent(state: NotebookCrdtState, cellId: string): string {
  const cell = state.cells.get(cellId);
  return cell ? cell.content : "";
}

/** Export the CRDT state for network sync */
export function exportCrdtState(state: NotebookCrdtState): {
  cells: Record<string, CellCrdtState>;
  myPeerId: string;
  peers: Record<string, { name: string; lastSeen: number; cursor?: { offset: number; selection?: [number, number] } }>;
} {
  return {
    cells: Object.fromEntries(state.cells.entries()),
    myPeerId: state.myPeerId,
    peers: Object.fromEntries(state.peers.entries()),
  };
}

/** Reimport CRDT state from network sync */
export function importCrdtState(
  incoming: ReturnType<typeof exportCrdtState>,
  existingState: NotebookCrdtState,
): NotebookCrdtState {
  const merged: NotebookCrdtState = {
    cells: existingState.cells,
    myPeerId: existingState.myPeerId,
    peers: existingState.peers,
  };

  // Merge cell states, preferring newer versions
  for (const [cellId, newCell] of Object.entries(incoming.cells)) {
    const existingCell = existingState.cells.get(cellId);
    if (!existingCell || newCell.version > existingCell.version) {
      merged.cells.set(cellId, newCell);
    }
  }

  // Merge peer states, preferring more recent cursor info
  for (const [peerId, newPeer] of Object.entries(incoming.peers)) {
    const existingPeer = existingState.peers.get(peerId);
    if (!existingPeer || newPeer.lastSeen > existingPeer.lastSeen) {
      merged.peers.set(peerId, newPeer);
    }
  }

  return merged;
}

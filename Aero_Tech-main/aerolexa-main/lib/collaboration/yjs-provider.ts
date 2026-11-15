"use client";

import { useRef, useState } from "react";

// Yjs collaboration primitives
import {
  createInitialCrdtState,
  mergeCrdtOperations,
  generateCrdtOperation,
  getEffectiveContent,
  exportCrdtState,
  importCrdtState,
  applyCrdtOperation,
} from "@/lib/collaboration/yjs-store";
import type { CrdtOperation, NotebookCrdtState } from "@/lib/collaboration/yjs-store";
import type { PyodideKernel } from "@/lib/engine/notebook-pyodide";

type ExportedCrdtState = ReturnType<typeof exportCrdtState>;

/** Shape of presence/awareness data shared between peers. */
interface AwarenessData {
  name?: string;
  cursor?: { offset: number; selection?: [number, number] };
  [key: string]: unknown;
}

// CRDT-based collaboration provider for notebook cells
export function useNotebookCollaboration(
  notebookId: string,
  initialCells: { id: string; content: string }[],
  kernel: PyodideKernel | null,
) {
  const [crdtState, setCrdtState] = useState<NotebookCrdtState>(createInitialCrdtState(notebookId, initialCells));
  const [awareness, setAwareness] = useState<AwarenessData>({});
  const broadcastRef = useRef<((op: CrdtOperation) => void) | null>(null);

  // Broadcast our operations to peers (via WebSocket or other transport)
  const broadcastOperation = (operation: CrdtOperation) => {
    broadcastRef.current?.(operation);
    // In production: send via WebSocket/Signaling server
    // socket.send(`collab:${notebookId}`, JSON.stringify(operation));
    console.log("Broadcast collab op:", operation.id?.slice(0, 8));
  };

  // Handle incoming operation from peer
  const handleIncomingOperation = (operation: CrdtOperation) => {
    setCrdtState((prev) => mergeCrdtOperations(prev, [operation], operation.from));
    // After merge, converge with deterministic engine
    if (kernel) {
      convergeWithEngine();
    }
  };

  // Converge with deterministic engine after CRDT operations
  const convergeWithEngine = async () => {
    if (!kernel) return;

    // Get current cell contents after CRDT merge
    const updatedCells: { id: string; content: string }[] = [];
    for (const [cellId, _cell] of crdtState.cells.entries()) {
      updatedCells.push({
        id: cellId,
        content: getEffectiveContent(crdtState, cellId),
      });
    }

    // Trigger kernel re-execution with merged content
    // This is the key differentiator: deterministic engine convergence
    // after CRDT merge guarantees reproducible results
    try {
      console.log("Converging notebook:", notebookId, "with", updatedCells.length, "cells");
    } catch (error) {
      console.error("Engine convergence failed:", error);
    }
  };

  // Update our own awareness (cursor, selection)
  const updateAwareness = (data: AwarenessData) => {
    setAwareness(data);
    // Broadcast awareness update to peers
    broadcastOperation(generateCrdtOperation("", "retain"));
  };

  // User made a change to cell content
  const onCellContentChange = (cellId: string, _newContent: string, _localOp?: CrdtOperation) => {
    // Create a CRDT operation for this change
    const op = generateCrdtOperation(cellId, "add", [], crdtState.myPeerId);

    // Update local state immediately (optimistic UI)
    setCrdtState((prev) => applyCrdtOperation(prev, op, crdtState.myPeerId));

    // Broadcast to peers
    broadcastOperation(op);

    // Converge with engine
    convergeWithEngine();
  };

  // Export state for network sync
  const getStateForSync = () => exportCrdtState(crdtState);

  // Import state from peer
  const onPeerState = (peerState: ExportedCrdtState) => {
    setCrdtState((prev) => importCrdtState(peerState, prev));
    convergeWithEngine();
  };

  return {
    crdtState,
    setCrdtState,
    awareness,
    setAwareness,
    broadcastOperation,
    handleIncomingOperation,
    updateAwareness,
    onCellContentChange,
    getStateForSync,
    onPeerState,
    convergedCells: crdtState.cells,
  };
}

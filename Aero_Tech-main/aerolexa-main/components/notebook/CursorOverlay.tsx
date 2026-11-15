"use client";

import { useEffect, useState } from "react";

import type { PyodideKernel } from "@/lib/engine/notebook-pyodide";

/** Cursor overlay for collaborative notebook cells.
 *  Displays other users' cursor positions and selections in real-time.
 */
export function CursorOverlay({
  cellId,
  cellKind,
  isCollaborative,
  notebookId,
  kernel,
}: {
  cellId: string;
  cellKind: string;
  isCollaborative: boolean;
  notebookId: string;
  /** The Pyodide kernel when the notebook kernel is running; null on the DSL kernel. */
  kernel: PyodideKernel | null;
}) {
  const [peersWithCursor, _setPeersWithCursor] = useState<
    Array<{ peerId: string; cursor: { offset: number; selection?: [number, number] } }>
  >([]);

  useEffect(() => {
    // In a full implementation, we would set up Yjs awareness and
    // track cursor positions from the collaboration state.
    // For now, this is a skeleton that can be expanded.
    const cleanup = () => {};
    return cleanup;
  }, [cellId, cellKind, isCollaborative, notebookId, kernel]);

  if (!isCollaborative || cellKind !== "code") {
    return null;
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={
        {
          // Cursor indicators will be positioned via CSS variables
        }
      }
    >
      {/* Cursor indicators are positioned via CSS below */}
      {peersWithCursor.length > 0 && (
        <div className="absolute inset-0">
          {peersWithCursor.map((peer) => (
            <div
              key={peer.peerId}
              className="absolute text-xs font-medium opacity-80 animate-bounce"
              style={{
                // Position cursor using a data attribute set by the parent
                left: "0%",
                top: "0%",
              }}
            >
              <span
                className="rounded-full bg-accent/60 text-accent-strong text-[1px] shadow-sm animate-pulse"
                role="status"
                aria-label={`Peer cursor at offset ${peer.cursor?.offset}`}
              >
                {/* Avatar-like cursor indicator */}
                <svg aria-hidden className="size-3" viewBox="0 0 8 8" fill="currentColor">
                  <circle cx="4" cy="4" r="3" />
                </svg>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { requireAuth } from "@/lib/auth/guard";
import { getRoom, type CollabCellState, type CollabRelay } from "@/lib/collab/rooms";
import { prisma } from "@/lib/db";
import { parseJsonArray } from "@/lib/json";
import { toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";
import { requireModule } from "@/lib/server/modules";
import { fetchRemoteCollabUpdates, publishCollabUpdate } from "@/lib/server/replica-bus";
import type { NotebookCell } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Collaboration stream (WS4): Server-Sent Events carrying binary Yjs updates
 * (base64) + presence. GET = join the room. POST (collab/update/route.ts) =
 * push an update. Updates are merged with CRDT semantics, so no coordinator or
 * locking is needed — every peer converges.
 */

const PEER_COLORS = ["#5AA8AA", "#FFB400", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"];

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let ctx: Awaited<ReturnType<typeof requireAuth>>;
  try {
    requireModule("NOTEBOOK_ENABLED");
    ctx = await requireAuth();
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    if (!(await moduleEnabledForRequest("COLLABORATION_ENABLED"))) {
      return new Response("Collaboration is disabled on this server. How to fix: set COLLABORATION_ENABLED=true.", {
        status: 403,
      });
    }

    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook || notebook.workspaceId !== ctx.workspace.id) {
      return new Response("Notebook not found.", { status: 404 });
    }

    const persisted = parseJsonArray<NotebookCell>(notebook.cells, []);
    const initialCells: CollabCellState[] = persisted.map((c) => ({
      id: c.id,
      kind: c.kind,
      content: c.content,
    }));

    // Multi-replica relay (lib/server/replica-bus.ts): applied updates are
    // published to the shared log and other replicas' rows are replayed on a
    // short poll, so rooms on different replicas converge instead of forking.
    const relay: CollabRelay = { publish: publishCollabUpdate, fetchRemote: fetchRemoteCollabUpdates };
    const room = getRoom(notebook.id, {
      initialCells,
      relay,
      onPersist: (notebookId, cellsJson) => {
        // Debounced persistence: the room's merged state wins on conflict with
        // the legacy PATCH path — the last writer of real content is still the
        // winner, but character-level merges no longer lose keystrokes.
        void prisma.notebook.update({ where: { id: notebookId }, data: { cells: cellsJson } }).catch(() => undefined);
      },
    });

    const peerId = `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    room.connect(peerId);
    const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] ?? "#5AA8AA";

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // 1) Initial state: full doc (content + presence) as one update,
        //    AFTER merging anything other replicas have relayed so a peer
        //    landing on this replica sees edits made on another one.
        const initial = await room.joinState();
        send("state", {
          peerId,
          color,
          update: Buffer.from(initial.update).toString("base64"),
          peers: initial.peers,
        });

        // 2) Live updates from other peers.
        room.subscribe(peerId, (update) => {
          send("update", { update: Buffer.from(update).toString("base64") });
          send("peers", { peers: room.peers() });
        });

        // 3) Presence announce for this peer (others receive it via the update fan-out).
        const peers = room.setPresence(peerId, { name: ctx.user.name ?? "Anonymous", color });
        send("peers", { peers });

        // 4) Heartbeats keep presence alive and push peer-list changes.
        const heartbeat = setInterval(() => {
          if (closed) return;
          const live = room.peers();
          if (live.length > 0) send("peers", { peers: live });
          else send("peers", { peers: [] });
        }, 15_000);

        // 5) Cleanup on disconnect.
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          room.disconnect(peerId);
          try {
            controller.close();
          } catch {
            // already closed by the platform
          }
        };
        _request.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

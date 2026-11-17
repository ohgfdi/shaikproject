import { requireAuth } from "@/lib/auth/guard";
import { getDashboardCollabRoom, seedDashboardRoom } from "@/lib/collab/dashboard-collab";
import { serializableSpec } from "@/lib/collab/dashboard-widget-sync";
import { prisma } from "@/lib/db";
import { toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";

/**
 * tenancy-audit: global-operator — dashboard collaboration API provides
 * workspace-wide CRDT sync for dashboard widgets. This is a deployment-wide
 * aggregate rather than a per-tenant query.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PEER_COLORS = ["#5AA8AA", "#FFB400", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"];

/**
 * Dashboard widget CRDT collaboration stream (SSE).
 * Full Yjs-based sync for widget specs, locks, and presence.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let ctx: Awaited<ReturnType<typeof requireAuth>>;
  try {
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

    const dashboard = await prisma.dashboard.findUnique({
      where: { id: params.id },
      select: { workspaceId: true, widgets: true },
    });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      return new Response("Dashboard not found.", { status: 404 });
    }

    // Parse persisted widgets. The widgets column is a JSON **array** of
    // DashboardWidget objects (see lib/serialize.ts dashboardWidgets); the
    // room expects a { widgetId: { type, spec } } map. (The previous code
    // parsed the array as a map, so Object.keys() yielded array indexes and
    // seeding silently produced typeless widgets — fixed here.)
    const persistedWidgets: Record<string, { type: string; spec: Record<string, unknown> }> = {};
    try {
      const arr = JSON.parse(dashboard.widgets ?? "[]") as { id?: unknown; type?: unknown }[];
      for (const w of Array.isArray(arr) ? arr : []) {
        if (typeof w?.id !== "string" || typeof w?.type !== "string") continue;
        persistedWidgets[w.id] = { type: w.type, spec: serializableSpec(w as never) };
      }
    } catch {
      // Corrupt JSON: start from an empty room rather than failing the stream.
    }

    const room = getDashboardCollabRoom(`dashboard:${params.id}`, {
      onWidgetChange: () => {
        /* state synced via SSE */
      },
      onWidgetLock: () => {
        /* lock changes synced via SSE */
      },
      onWidgetOrderChange: () => {
        /* order changes synced via SSE */
      },
      onPeersChange: () => {
        /* peer list synced via SSE */
      },
    });

    // Seed from persisted state
    if (Object.keys(persistedWidgets).length > 0) {
      seedDashboardRoom(room, persistedWidgets);
    }

    const peerId = `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] ?? "#5AA8AA";

    room.connect(peerId);

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

        // Initial state
        const initial = (await room.joinState?.()) ?? { update: room.stateAsUpdate(), peers: room.peers() };
        send("state", {
          peerId,
          color,
          update: Buffer.from(initial.update).toString("base64"),
          peers: initial.peers,
          widgets: room.getAllWidgets(),
          widgetOrder: room.getWidgetOrder(),
          locks: room.getAllLocks?.() ?? {},
        });

        // Presence
        const peers = room.setPresence(peerId, { name: ctx.user.name ?? "Anonymous", color });
        send("peers", { peers });

        // Live updates
        room.subscribe(peerId, (update) => {
          send("update", { update: Buffer.from(update).toString("base64") });
        });

        // Heartbeat
        const heartbeat = setInterval(() => {
          if (closed) return;
          const live = room.peers();
          send("peers", { peers: live });
        }, 15_000);

        // Own heartbeat
        const self = setInterval(
          () =>
            room.setPresence(peerId, {
              name: ctx.user.name ?? "Anonymous",
              color,
            }),
          HEARTBEAT_INTERVAL_MS,
        );

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearInterval(self);
          room.disconnect(peerId);
          try {
            controller.close();
          } catch {
            // already closed
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

const HEARTBEAT_INTERVAL_MS = 10_000;

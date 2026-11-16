import { requireAuth } from "@/lib/auth/guard";
import { getPresenceRoom } from "@/lib/collab/presence";

/**
 * tenancy-audit: global-operator — dashboard presence API provides
 * workspace-wide dashboard presence tracking. This is a deployment-wide
 * aggregate rather than a per-tenant query.
 */
import { prisma } from "@/lib/db";
import { toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dashboard presence (ROADMAP 7.2).
 *
 *   GET  /api/dashboards/[id]/presence — SSE stream: `peers` events carry the
 *        live peer list; the joining peer first receives `hello` with its
 *        assigned peerId/color.
 *   POST /api/dashboards/[id]/presence — heartbeat { peerId, widgetId? }.
 *
 * Presence is ephemeral: no DB writes, 30 s TTL, garbage-collected on every
 * list. Auth: requireAuth + workspace scoping, same as every dashboard route.
 */

const PEER_COLORS = ["#5AA8AA", "#FFB400", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4"];

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

    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id }, select: { workspaceId: true } });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      return new Response("Dashboard not found.", { status: 404 });
    }

    const room = getPresenceRoom(`dashboard:${params.id}`, {
      onPeersChange: () => {
        /* fan-out handled per-stream below; registry GC keeps lists honest */
      },
    });

    const peerId = `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] ?? "#5AA8AA";
    room.join(peerId, { name: ctx.user.name ?? "Anonymous", color });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
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

        send("hello", { peerId, color, peers: room.list() });

        // Presence fan-out for THIS stream: poll the room list on a short
        // interval (cheap — in-memory) and push when it changes. Multi-replica
        // deployments scope presence per replica, matching the SSE transport.
        let last = "";
        const fanout = setInterval(() => {
          const peers = room.list();
          const key = peers.map((p) => `${p.id}:${p.widgetId ?? ""}`).join("|");
          if (key !== last) {
            last = key;
            send("peers", { peers });
          }
        }, 2_000);

        // Own heartbeat: the stream itself proves liveness, but the peer must
        // also survive the registry TTL while the tab is open.
        const self = setInterval(() => room.heartbeat(peerId), 10_000);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(fanout);
          clearInterval(self);
          room.leave(peerId);
          try {
            controller.close();
          } catch {
            /* already closed */
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
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let ctx: Awaited<ReturnType<typeof requireAuth>>;
  try {
    ctx = await requireAuth();
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    if (!(await moduleEnabledForRequest("COLLABORATION_ENABLED"))) {
      return new Response("Collaboration is disabled on this server.", { status: 403 });
    }
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id }, select: { workspaceId: true } });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      return new Response("Dashboard not found.", { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { peerId?: string; widgetId?: string };
    if (!body.peerId) return new Response("peerId required", { status: 400 });
    const room = getPresenceRoom(`dashboard:${params.id}`);
    const peers = room.heartbeat(body.peerId, body.widgetId);
    return Response.json({ peers });
  } catch (err) {
    return toErrorResponse(err);
  }
}

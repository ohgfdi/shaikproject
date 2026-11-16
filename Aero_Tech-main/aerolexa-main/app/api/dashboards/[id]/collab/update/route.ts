// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - dashboard collab update is a deployment-wide aggregate operation
import { requireAuth } from "@/lib/auth/guard";
import { getDashboardCollabRoom } from "@/lib/collab/dashboard-collab";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { moduleEnabled, moduleEnabledForRequest } from "@/lib/server/modules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dashboard widget CRDT collaboration update push.
 * Client sends Yjs update (base64); server applies and fans out to other peers.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    if (!(await moduleEnabledForRequest("COLLABORATION_ENABLED"))) {
      return ok({ ok: false, message: "Collaboration is disabled on this server." });
    }
    const ctx = await requireAuth();
    const dashboard = await prisma.dashboard.findUnique({ where: { id: params.id } });
    if (!dashboard || dashboard.workspaceId !== ctx.workspace.id) {
      return ok({ ok: false, message: "Dashboard not found." });
    }

    const body = await readJsonBody<{
      update?: string;
      peerId?: string;
      cursor?: { widgetId?: string; x?: number; y?: number };
      lock?: { widgetId: string; action: "acquire" | "release" | "refresh" };
      widgetOp?: {
        type: "set" | "merge" | "add" | "remove" | "reorder";
        widgetId?: string;
        spec?: Record<string, unknown>;
        widgetType?: string;
        order?: string[];
      };
    }>(request);
    if (!body.peerId) {
      return ok({ ok: false, message: "Missing peerId." });
    }

    const room = getDashboardCollabRoom(`dashboard:${params.id}`);

    // Apply Yjs update if provided
    if (body.update) {
      let update: Uint8Array;
      try {
        update = Buffer.from(body.update, "base64");
      } catch {
        return ok({ ok: false, message: "Malformed update payload." });
      }
      room.connect(body.peerId);
      room.subscribe(body.peerId, () => undefined);
      const applied = room.applyUpdate(update);
      if (applied) {
        room.broadcast(applied, body.peerId);
      }
    }

    // Handle cursor/presence
    if (body.cursor && body.cursor.widgetId) {
      room.setCursor(body.peerId, body.cursor.x ?? 0, body.cursor.y ?? 0);
    }

    // Handle widget lock
    if (body.lock) {
      if (body.lock.action === "acquire") {
        room.acquireLock(body.peerId, body.lock.widgetId);
      } else if (body.lock.action === "release") {
        room.releaseLock(body.peerId, body.lock.widgetId);
      } else if (body.lock.action === "refresh") {
        room.refreshLock(body.peerId, body.lock.widgetId);
      }
    }

    // Handle widget operations
    if (body.widgetOp) {
      const op = body.widgetOp;
      const widgetType = op.widgetType as "chart" | "table" | "text" | "filter" | "kpi" | "pivot" | undefined;
      if (op.type === "set" && op.widgetId && op.spec && widgetType) {
        room.setWidgetSpec(body.peerId, op.widgetId, widgetType, op.spec);
      } else if (op.type === "merge" && op.widgetId && op.spec) {
        room.mergeWidgetSpec(body.peerId, op.widgetId, op.spec);
      } else if (op.type === "add" && op.widgetId && op.spec && widgetType) {
        room.addWidget(body.peerId, { widgetId: op.widgetId, type: widgetType, spec: op.spec, version: 1 });
      } else if (op.type === "remove" && op.widgetId) {
        room.removeWidget(body.peerId, op.widgetId);
      } else if (op.type === "reorder" && op.order) {
        room.reorderWidgets(body.peerId, op.order);
      }
    }

    return ok({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

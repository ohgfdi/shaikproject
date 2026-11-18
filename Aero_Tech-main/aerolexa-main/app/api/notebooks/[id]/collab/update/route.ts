import { requireAuth } from "@/lib/auth/guard";
import { getRoom } from "@/lib/collab/rooms";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { moduleEnabledForRequest } from "@/lib/server/modules";
import { requireModule } from "@/lib/server/modules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Collaboration update push (WS4). A client sends its Yjs update (base64);
 * the server applies it to the room's doc and fans it out to every other
 * connected peer's SSE stream. Applying an update twice is harmless (Yjs is
 * idempotent), so at-least-once delivery is correct by construction.
 */

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    if (!(await moduleEnabledForRequest("COLLABORATION_ENABLED"))) {
      return ok({ ok: false, message: "Collaboration is disabled on this server." });
    }
    const ctx = await requireAuth();
    const notebook = await prisma.notebook.findUnique({ where: { id: params.id } });
    if (!notebook || notebook.workspaceId !== ctx.workspace.id) {
      return ok({ ok: false, message: "Notebook not found." });
    }

    const body = await readJsonBody<{
      update?: string;
      peerId?: string;
      cursor?: { cellId?: string; offset?: number };
    }>(request);
    if (!body.update || !body.peerId) {
      return ok({ ok: false, message: "Missing update or peerId." });
    }

    const room = getRoom(notebook.id);
    let update: Uint8Array;
    try {
      update = Buffer.from(body.update, "base64");
    } catch {
      return ok({ ok: false, message: "Malformed update payload." });
    }

    // Apply + broadcast: the room returns the update only when it changed the
    // doc (idempotent replays are dropped and not re-fanned-out).
    room.connect(body.peerId);
    room.subscribe(body.peerId, () => undefined); // POST clients don't receive here; SSE owns their stream
    const applied = room.applyUpdate(update);
    if (applied) {
      room.broadcast(applied, body.peerId);
    }

    if (body.cursor && body.cursor.cellId) {
      room.setCursor(body.peerId, body.cursor.cellId, body.cursor.offset);
    }

    return ok({ ok: true, applied: !!applied });
  } catch (err) {
    return toErrorResponse(err);
  }
}

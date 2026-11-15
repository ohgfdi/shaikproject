import { ApiError, requireAuth } from "@/lib/auth/guard";
import type { ChatSource } from "@/lib/chat/engine";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Single-conversation operations for /api/chat/[id].
 *
 * GET    — the full thread (server-authoritative history + sources).
 * PATCH  — rename { title }.
 * DELETE — remove the conversation.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { chat } = await loadChatOrThrow(props);
    return ok({
      id: chat.id,
      title: chat.title,
      webSearch: chat.webSearch,
      model: chat.model,
      updatedAt: chat.updatedAt.toISOString(),
      messages: chat.messages.map((m) => ({
        role: m.role === "assistant" || m.role === "user" ? m.role : "user",
        content: m.content,
        sources: sourcesOf(m.sources),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { chat } = await loadChatOrThrow(props);
    const body = await readJsonBody<{ title?: unknown }>(request);
    const title = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > 120) {
      throw new ApiError(400, "VALIDATION", "Title must be 1–120 characters.");
    }
    const updated = await prisma.chat.update({ where: { id: chat.id }, data: { title } });
    return ok({ id: updated.id, title: updated.title });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const { chat } = await loadChatOrThrow(props);
    await prisma.chat.delete({ where: { id: chat.id } });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function loadChatOrThrow(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await requireAuth();
  const chat = await prisma.chat.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!chat || chat.userId !== ctx.user.id || chat.workspaceId !== ctx.workspace.id) {
    throw new ApiError(404, "NOT_FOUND", "Conversation not found.");
  }
  return { ctx, chat };
}

function sourcesOf(raw: string | null): ChatSource[] {
  if (!raw) return [];
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (s): s is ChatSource =>
      !!s &&
      typeof s === "object" &&
      typeof (s as { url?: unknown }).url === "string" &&
      typeof (s as { title?: unknown }).title === "string",
  );
}

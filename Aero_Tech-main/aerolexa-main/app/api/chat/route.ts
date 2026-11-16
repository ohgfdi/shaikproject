import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import {
  buildStreamRequest,
  decideSearch,
  runWebSearches,
  titleForChat,
  type ChatMessage,
  type ChatParticipantContext,
  type WebSearchContext,
} from "@/lib/chat/engine";
import { buildWorkspaceIndex, type RagFact, type RagHit } from "@/lib/chat/rag";
import { getWorkspaceIndex, retrieveWorkspaceFacts } from "@/lib/chat/workspace-retrieval";
import { firstAvailableLLMProvider, getChatProviderChain, type LLMProvider } from "@/lib/llm/providers";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";
import { withTenantDb } from "@/lib/server/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Copilot chat — a ChatGPT-style, streaming assistant with optional live web
 * search. Conversations are persisted (Prisma `Chat`/`ChatMessage`) so a user
 * can reload the page and resume a thread; the server rebuilds conversation
 * history authoritatively from the database rather than trusting client state.
 *
 * POST /api/chat
 *   Body: { message: string, conversationId?: string, webSearch?: boolean, model?: string }
 *   - `message`        the new user turn (the rest of the thread is loaded
 *                      from the DB when conversationId is given).
 *   - `conversationId` resume an existing thread, else a new one is created.
 *   - `webSearch`      enable the live web lookups (default: true).
 *   - `model`          "provider:model" preferred model; falls back through the
 *                      configured provider chain when unreachable.
 *
 *   SSE events:
 *     conversation { id, title, created } — thread id (create on first turn)
 *     search       { queries }            — the web lookups being run, live
 *     sources      { used, backend, queries, sources } — real results (if any)
 *     delta        { text }               — one token chunk
 *     done         { provider, model, web, latencyMs }
 *     error        { message }
 *
 * GET /api/chat — the caller's recent conversations (most recent first).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "copilot", RATE_LIMITS.copilot);

    const body = await readJsonBody<{
      message?: unknown;
      conversationId?: unknown;
      webSearch?: unknown;
      model?: unknown;
    }>(request);

    const message = sanitizeMessage(body.message);
    const webSearch = body.webSearch === undefined ? true : body.webSearch === true;
    const conversationId =
      typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined;
    const requestedModel = typeof body.model === "string" && body.model ? body.model : undefined;

    const thread = await loadOrCreateConversation(ctx, conversationId, message, webSearch, requestedModel);
    const chain = getChatProviderChain(thread.model ?? requestedModel);
    const provider = await firstAvailableLLMProvider(chain);
    if (!provider) {
      throw new ApiError(
        503,
        "LLM_UNAVAILABLE",
        "Claude is not configured or not reachable. Set ANTHROPIC_API_KEY (and AI_MODEL_MAIN) on the server, then retry.",
      );
    }

    const personalContext = await buildParticipantContext(ctx);
    // Workspace retrieval over the TTL-cached, metadata-only index: BM25 ⊕
    // dense embeddings (RRF) when EMBEDDING_PROVIDER is configured, the
    // deterministic BM25 ⊕ TF-IDF-cosine hybrid otherwise. Provider failures
    // degrade to the deterministic path — honestly, never silently.
    const index = await getWorkspaceIndex(ctx.workspace.id, () => ragIndex);
    const retrieval = await retrieveWorkspaceFacts(message, index, 5);
    const ragHits = retrieval.hits;
    const stream = runChatStream({ provider, chain, thread, message, webSearch, personalContext, ragHits, ctx });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET() {
  try {
    const ctx = await requireAuth();
    const chats = await withTenantDb(ctx, (db) =>
      db.chat.findMany({
        where: { workspaceId: ctx.workspace.id, userId: ctx.user.id },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: { messages: { orderBy: { createdAt: "asc" } } },
      }),
    );
    return ok({
      chats: chats.map((c) => ({
        id: c.id,
        title: c.title,
        webSearch: c.webSearch,
        model: c.model,
        updatedAt: c.updatedAt.toISOString(),
        messageCount: c.messages.length,
        preview: previewOf(c.messages),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "VALIDATION", "Say something to the copilot.");
  }
  const content = raw.trim().slice(0, 6000);
  if (!content) {
    throw new ApiError(400, "VALIDATION", "Say something to the copilot.");
  }
  return content;
}

interface LoadedThread {
  chatId: string;
  title: string;
  webSearch: boolean;
  model?: string;
  history: ChatMessage[];
  created: boolean;
}

async function loadOrCreateConversation(
  ctx: AuthContext,
  conversationId: string | undefined,
  message: string,
  webSearch: boolean,
  requestedModel: string | undefined,
): Promise<LoadedThread> {
  if (conversationId) {
    const chat = await withTenantDb(ctx, (db) =>
      db.chat.findUnique({
        where: { id: conversationId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      }),
    );
    if (!chat || chat.userId !== ctx.user.id || chat.workspaceId !== ctx.workspace.id) {
      throw new ApiError(404, "NOT_FOUND", "Conversation not found.");
    }
    const history = (chat.messages ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      .slice(-30);
    return {
      chatId: chat.id,
      title: chat.title,
      webSearch,
      model: requestedModel ?? chat.model ?? undefined,
      history,
      created: false,
    };
  }

  const chat = await withTenantDb(ctx, (db) =>
    db.chat.create({
      data: {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        title: titleForChat([{ role: "user" as const, content: message }]),
        webSearch,
        model: requestedModel ?? null,
      },
    }),
  );
  return {
    chatId: chat.id,
    title: chat.title,
    webSearch: chat.webSearch,
    model: chat.model ?? undefined,
    history: [],
    created: true,
  };
}

/**
 * Factual user/workspace context for the prompt — names and counts only —
 * plus the retrieval index the RAG block is built from. One parallel batch
 * of metadata-only queries; no row data is ever read.
 */
async function buildParticipantContext(ctx: AuthContext): Promise<ChatParticipantContext> {
  const [projects, datasets, dashboards, reports, analyses] = await withTenantDb(ctx, (db) =>
    Promise.all([
      db.project.findMany({
        where: { workspaceId: ctx.workspace.id },
        orderBy: { updatedAt: "desc" },
        take: 6,
        select: { id: true, name: true },
      }),
      db.dataset.findMany({
        where: { workspaceId: ctx.workspace.id },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { name: true, rowCount: true, columnCount: true, columns: true },
      }),
      db.dashboard.findMany({
        where: { workspaceId: ctx.workspace.id },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, title: true },
      }),
      db.report.findMany({
        where: { workspaceId: ctx.workspace.id },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: { id: true, title: true },
      }),
      db.analysis.findMany({
        where: { workspaceId: ctx.workspace.id },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, title: true, kind: true },
      }),
    ]),
  );

  // Metadata-only RAG index (see lib/chat/rag.ts): datasets carry their
  // column names as retrieval keywords so "which dataset has invoice dates"
  // retrieves the right file — without reading any row.
  ragIndex = buildWorkspaceIndex({
    datasets: datasets.map((d) => ({
      id: "",
      name: d.name,
      rowCount: d.rowCount,
      columnCount: d.columnCount,
      columnNames: parseColumnNames(d.columns),
    })),
    projects,
    dashboards,
    reports,
    analyses,
  });

  return {
    userName: ctx.user.name,
    workspaceName: ctx.workspace.name,
    organization: ctx.user.organization,
    industry: ctx.user.industry,
    projects,
    datasets,
  };
}

/** Workspace-scoped retrieval index, rebuilt per request (metadata only). */
let ragIndex: RagFact[] = [];

/** Extract column names from the Dataset.columns JSON (ColumnDef[]). */
function parseColumnNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : null))
      .filter((n): n is string => typeof n === "string")
      .slice(0, 40);
  } catch {
    return [];
  }
}

function previewOf(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i]!.content.replace(/\s+/g, " ").trim();
    if (text) return text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
  }
  return "";
}

function sse(name: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface StreamOpts {
  provider: LLMProvider;
  chain: LLMProvider[];
  thread: LoadedThread;
  message: string;
  webSearch: boolean;
  personalContext: ChatParticipantContext;
  ragHits: RagHit[];
  ctx: AuthContext;
}

function runChatStream(opts: StreamOpts): ReadableStream<Uint8Array> {
  const started = Date.now();
  const conversation: ChatMessage[] = [...opts.thread.history, { role: "user", content: opts.message }];

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: string, data: unknown) => {
        try {
          if (controller.desiredSize !== null) controller.enqueue(sse(event, data));
        } catch {
          // Stream closed — stop writing.
        }
      };

      // Persist the user turn first so a reload after a mid-stream error still
      // shows the question.
      try {
        await withTenantDb(opts.ctx, (db) =>
          db.chatMessage.create({
            data: { chatId: opts.thread.chatId, role: "user", content: opts.message },
          }),
        );
      } catch {
        // Persistence is best-effort; never fail the user's chat because of it.
      }

      push("conversation", {
        id: opts.thread.chatId,
        title: opts.thread.title,
        created: opts.thread.created,
      });

      let web: WebSearchContext = { used: false, backend: "none", queries: [], sources: [] };
      try {
        if (opts.webSearch) {
          const queries = await decideSearch(opts.provider, conversation);
          push("search", { queries });
          web = await runWebSearches(queries);
          push("sources", web);
        }
      } catch {
        web = { used: false, backend: "none", queries: [], sources: [] };
      }

      const { systemPrompt, userPrompt } = buildStreamRequest(conversation, web, opts.personalContext, opts.ragHits);
      const request = { systemPrompt, userPrompt, maxTokens: 1200, temperature: 0.7, timeout: 60000 };

      // Provider failover chain: walk candidates until one produces output.
      let active: LLMProvider = opts.provider;
      let fullText = "";
      let streamed = false;
      let lastError: unknown = null;
      const battery: LLMProvider[] = [opts.provider, ...opts.chain.filter((p) => p !== opts.provider)];

      for (const candidate of battery) {
        try {
          if (candidate.generateStream) {
            for await (const token of candidate.generateStream(request)) {
              streamed = true;
              if (token) {
                fullText += token;
                push("delta", { text: token });
              }
            }
          } else {
            const res = await candidate.generate(request);
            streamed = true;
            fullText = res.content;
            if (fullText) push("delta", { text: fullText });
          }
          active = candidate;
          break;
        } catch (err) {
          lastError = err;
          if (streamed) break; // mid-stream failure cannot be spliced seamlessly
        }
      }

      if (!streamed) {
        push("error", { message: errorMessage(lastError) });
        controller.close();
        return;
      }

      push("done", {
        provider: active.name,
        model: active.model,
        web,
        latencyMs: Date.now() - started,
      });
      controller.close();

      // Persist the assistant answer + the sources it was allowed to cite.
      try {
        await withTenantDb(opts.ctx, (db) =>
          db.chatMessage.create({
            data: {
              chatId: opts.thread.chatId,
              role: "assistant",
              content: fullText,
              sources: web.used && web.sources.length > 0 ? JSON.stringify(web.sources) : null,
            },
          }),
        );
        const actualModel = `${active.name}:${active.model}`;
        if (opts.thread.model !== actualModel) {
          await withTenantDb(opts.ctx, (db) =>
            db.chat.update({
              where: { id: opts.thread.chatId },
              data: { model: actualModel },
            }),
          );
        }
      } catch {
        // Best-effort persistence.
      }

      await logActivity(opts.ctx, "COPILOT", "Copilot chat answered (streamed)", null, {
        model: `${active.name}:${active.model}`,
        webSearch: web.used,
        sources: web.sources.length,
        conversationId: opts.thread.chatId,
        latencyMs: Date.now() - started,
      }).catch(() => undefined);
    },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "The model could not generate a response. Please try again.";
}

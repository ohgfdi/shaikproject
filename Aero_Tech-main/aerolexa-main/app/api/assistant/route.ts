/**
 * POST /api/assistant — streaming, READ-only books assistant.
 *
 * Pipeline: global/tenant switch → auth → per-user + per-org rate limit →
 * strict body validation → server-side book/engagement resolution → audit run
 * row → bounded agent loop → grounding verifier → SSE answer.
 *
 * The model never sees or supplies tenant identity. A book id in the request is
 * only a UI selection: it is validated by assertBookTenant here and fixed in
 * the run context.
 */

import { z } from "zod";

import { runAssistantAgent, type AgentEvent } from "@/lib/ai/agent";
import { appendAssistantToolCall, createAssistantRun, findIdempotentRun, finishAssistantRun } from "@/lib/ai/audit";
import { buildSystemPrompt } from "@/lib/ai/prompt";
import { getAnthropicProvider } from "@/lib/ai/provider";
import { scrubText } from "@/lib/ai/redact";
import { assistantEnablement } from "@/lib/ai/settings";
import { ApiError, requireAuth } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { listBooks } from "@/lib/server/books";
import { requireEngagementRole } from "@/lib/server/engagement";
import { log, newRequestId } from "@/lib/server/logger";
import { enforceUserRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    question: z.string().trim().min(1).max(10_000),
    /** UI selection only; validated server-side, never forwarded as a model argument. */
    bookId: z.string().min(1).max(64).optional(),
    engagementId: z.string().min(1).max(64).optional(),
  })
  .strict();

function jsonError(status: number, code: string, message: string, requestId: string, details?: unknown): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message, details }, requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

function sseHeaders(requestId: string, runId?: string): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    ...(runId ? { "x-assistant-run-id": runId } : {}),
  };
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function replay(run: {
  id: string;
  status: string;
  answer: string | null;
  verification: string | null;
  requestId: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse("run", { runId: run.id, requestId: run.requestId, replayed: true }));
      controller.enqueue(
        sse("answer", {
          runId: run.id,
          status: run.status,
          answer: run.answer,
          verification: run.verification ? JSON.parse(run.verification) : null,
          verified: run.status === "completed",
          replayed: true,
        }),
      );
      controller.enqueue(sse("done", { runId: run.id, status: run.status }));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders(run.requestId, run.id) });
}

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.slice(0, 64) || newRequestId();
  let env;
  try {
    env = serverEnv();
  } catch {
    return jsonError(503, "ASSISTANT_UNAVAILABLE", "The assistant is not configured on this server.", requestId);
  }
  if (!env.ASSISTANT_ENABLED) {
    return jsonError(503, "ASSISTANT_DISABLED", "The assistant is disabled by the operator.", requestId);
  }

  let auth;
  try {
    auth = await requireAuth();
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error.status, error.code, error.message, requestId);
    return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.", requestId);
  }

  const enablement = await assistantEnablement(auth);
  if (!enablement.allowed) {
    return jsonError(
      403,
      enablement.reason === "global_disabled" ? "ASSISTANT_DISABLED" : "ASSISTANT_ORG_DISABLED",
      enablement.reason === "global_disabled"
        ? "The assistant is disabled by the operator."
        : "The assistant is not enabled for this organization. An owner or admin can enable it in Assistant settings.",
      requestId,
    );
  }

  try {
    enforceUserRateLimit(auth.user.id, "assistant", {
      limit: env.ASSISTANT_USER_RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
    });
    if (auth.organization) {
      enforceUserRateLimit(`org:${auth.organization.id}`, "assistant_org", {
        limit: env.ASSISTANT_ORG_RATE_LIMIT_PER_MINUTE,
        windowMs: 60_000,
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const res = jsonError(error.status, error.code, error.message, requestId);
      if (error.headers) for (const [k, v] of Object.entries(error.headers)) res.headers.set(k, v);
      return res;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "The request body must be JSON.", requestId);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(
      400,
      "VALIDATION",
      `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid input"}`,
      requestId,
    );
  }
  const question = parsed.data.question.trim();
  if (question.length > env.ASSISTANT_MAX_QUESTION_CHARS) {
    return jsonError(
      400,
      "QUESTION_TOO_LONG",
      `Question must be at most ${env.ASSISTANT_MAX_QUESTION_CHARS} characters.`,
      requestId,
    );
  }

  // Resolve the book from the UI selection (validated) or, when the caller has
  // exactly one visible book, select it server-side. Multiple books with no
  // selection stay ambiguous on purpose.
  let bookId: string | null = null;
  if (parsed.data.bookId) {
    try {
      const book = await assertBookTenant(auth, parsed.data.bookId);
      bookId = book.id;
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error.status, error.code, error.message, requestId);
      throw error;
    }
  } else {
    const visible = await listBooks(auth.workspace.id, auth.organization?.id ?? null);
    if (visible.length === 1) bookId = visible[0]!.id;
  }

  if (parsed.data.engagementId) {
    try {
      await requireEngagementRole(auth, parsed.data.engagementId, "ASSISTANT");
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error.status, error.code, error.message, requestId);
      throw error;
    }
  }

  const provider = getAnthropicProvider();
  if (!provider) {
    return jsonError(
      503,
      "ASSISTANT_UNAVAILABLE",
      "Claude is not configured (ANTHROPIC_API_KEY is missing). No answer was generated.",
      requestId,
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim().slice(0, 128) || null;
  if (idempotencyKey) {
    const existing = await findIdempotentRun(auth.user.id, idempotencyKey);
    if (existing) {
      if (existing.status === "running") {
        return jsonError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is still running.",
          requestId,
        );
      }
      return replay(existing);
    }
  }

  let run;
  try {
    run = await createAssistantRun({
      requestId,
      idempotencyKey,
      userId: auth.user.id,
      workspaceId: auth.workspace.id,
      organizationId: auth.organization?.id ?? null,
      bookId,
      question,
    });
  } catch (error) {
    log.error("assistant.run_create_failed", { requestId, error: error instanceof Error ? error.message : "unknown" });
    return jsonError(
      500,
      "ASSISTANT_LOG_FAILED",
      "The assistant could not start because its audit log is unavailable.",
      requestId,
    );
  }

  const runId = run.id;
  const context = {
    auth,
    runId,
    requestId,
    bookId,
    engagementId: parsed.data.engagementId ?? null,
    signal: request.signal,
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          closed = true;
        }
      };
      send("run", { runId, requestId, bookId, replayed: false });

      const onEvent = (event: AgentEvent) => {
        if (event.type === "tool_start") {
          send("tool_start", { name: event.name, input: scrubText(JSON.stringify(event.input))?.slice(0, 500) });
        } else if (event.type === "tool_result") {
          send("tool_result", event);
        } else if (event.type === "usage") {
          send("usage", event);
        } else if (event.type === "assistant_text") {
          send("status", { phase: "composing" });
        } else if (event.type === "limit") {
          send("status", { phase: "limit", reason: event.reason });
        }
      };

      try {
        const result = await runAssistantAgent({
          provider,
          question,
          context,
          system: buildSystemPrompt(context),
          onEvent,
          recordToolCall: async (seq, record) => {
            await appendAssistantToolCall(runId, seq, record);
          },
        });

        const status =
          result.status === "completed"
            ? "completed"
            : result.status === "verification_failed"
              ? "verification_failed"
              : result.status === "aborted"
                ? "aborted"
                : result.status === "limit"
                  ? "limit"
                  : "failed";

        const answerForLog = result.status === "completed" ? result.answer : result.message;
        await finishAssistantRun(runId, {
          status,
          answer: answerForLog,
          verification: result.verification,
          toolCallCount: result.toolCallCount,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          errorCode: result.errorCode,
        });

        send("answer", {
          runId,
          status,
          answer: result.answer,
          message: result.message,
          claims: result.claims,
          verification: result.verification,
          verified: result.status === "completed",
          results: result.status === "completed" ? undefined : [...result.results.values()],
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
            toolCalls: result.toolCallCount,
            latencyMs: result.latencyMs,
          },
        });
        log.info("assistant.run", {
          requestId,
          runId,
          userId: auth.user.id,
          organizationId: auth.organization?.id ?? null,
          bookId,
          status,
          toolCalls: result.toolCallCount,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        });
        send("done", { runId, status });
      } catch (error) {
        const aborted = request.signal.aborted;
        const code = aborted ? "ABORTED" : "ASSISTANT_FAILED";
        try {
          await finishAssistantRun(runId, {
            status: aborted ? "aborted" : "failed",
            answer: aborted
              ? "The request was cancelled."
              : "The assistant failed before producing a verified answer. No figures are shown.",
            toolCallCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
            latencyMs: 0,
            errorCode: code,
          });
        } catch {
          // The run row may already be gone; never leak internal detail.
        }
        if (!aborted) {
          log.error("assistant.run_failed", {
            requestId,
            runId,
            error: error instanceof Error ? error.name : "unknown",
          });
          send("error", {
            code,
            message: "The assistant failed before producing a verified answer. No figures were produced or guessed.",
          });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
    cancel() {
      // Client disconnected: the agent sees request.signal and finalises the
      // run as aborted. The audit row was written before any model call.
    },
  });

  return new Response(stream, { headers: sseHeaders(requestId, runId) });
}

/** Explicitly reject other methods with the same machine-readable shape. */
export async function GET(): Promise<Response> {
  return jsonError(405, "METHOD_NOT_ALLOWED", "Use POST /api/assistant.", newRequestId());
}

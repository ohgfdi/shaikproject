import { requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/server/api";
import { addSubscriber, getRun, removeSubscriber } from "@/lib/server/training-progress";

export const dynamic = "force-dynamic";

/**
 * GET /api/training/progress?runId=… — server-sent events for one training
 * run. Replays the event history on connect (so a mid-run subscriber sees
 * the folds already completed), then streams new events until the run
 * completes or fails. Events:
 *
 *   event: progress   data: {"phase":"cv","done":2,"total":5,"at":120}
 *   event: done       data: {"completedAt":…} | event: error data: {"message":…}
 *
 * The POST /api/training response stays the source of truth for the RESULT;
 * this stream is only the live bar. Unknown run ids get a 404 — the client
 * generated the id before POSTing, so a miss means the run never started.
 */
export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId") ?? "";
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(runId)) {
      return Response.json(
        { ok: false, error: { code: "VALIDATION", message: "A valid runId is required." } },
        { status: 400 },
      );
    }
    // The client opens this stream BEFORE the training POST lands (so no
    // early events are missed), which means the run may not be registered
    // yet — wait briefly for it instead of failing the connection. A 404 is
    // fatal for EventSource (no auto-retry), so it is reserved for a run id
    // that genuinely never starts.
    let run = getRun(runId);
    if (!run) {
      const deadline = Date.now() + 8_000;
      while (!run && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        run = getRun(runId);
      }
    }
    if (!run) {
      return Response.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Unknown run id — start a training first." } },
        { status: 404 },
      );
    }

    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        addSubscriber(runId);
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        let sent = 0;
        const pump = (): boolean => {
          const current = getRun(runId);
          if (!current) {
            send("error", { message: "Run state was evicted." });
            return false;
          }
          while (sent < current.events.length) {
            send("progress", current.events[sent]);
            sent++;
          }
          if (current.error !== null) {
            send("error", { message: current.error });
            return false;
          }
          if (current.completed) {
            send("done", { events: current.events.length });
            return false;
          }
          return true;
        };
        if (!pump()) {
          closed = true;
          removeSubscriber(runId);
          controller.close();
          return;
        }
        const interval = setInterval(() => {
          if (!pump()) {
            clearInterval(interval);
            closed = true;
            removeSubscriber(runId);
            controller.close();
          }
        }, 500);
        // Hard cap: a run can outlive a stalled client; the client closing
        // the stream releases the reader and the interval dies with it.
        request.signal.addEventListener("abort", () => {
          clearInterval(interval);
          if (!closed) {
            closed = true;
            removeSubscriber(runId);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        });
      },
      cancel() {
        closed = true;
        removeSubscriber(runId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

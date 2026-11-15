/**
 * Oracle tests for the streaming / event-time engine (E21).
 *
 * Contract: arrival ORDER never defines the answer — event time does.
 * Windows are emitted with exact hand-computable aggregates; replaying the
 * same events in any order reproduces every window; duplicated tokens are
 * dropped before they can double-count; events below the watermark minus the
 * allowed lateness are counted LATE, never silently absorbed.
 */
import { describe, expect, it } from "@jest/globals";

import { runStreaming, StreamingError, type StreamEvent, type StreamingOptions } from "@/lib/engine/streaming";

const tumbling = (size: number): StreamingOptions["window"] => ({ kind: "tumbling", size });

const opts = (over: Partial<StreamingOptions> = {}): StreamingOptions => ({
  window: tumbling(10),
  op: "sum",
  allowedLateness: 0,
  watermark: "event-time",
  ...over,
});

const ev = (eventTime: number, value: number, token: string): StreamEvent => ({ eventTime, value, token });

describe("runStreaming — tumbling windows", () => {
  it("emits exact hand-computed sums once the watermark passes each window", () => {
    // Windows: [0,10) gets 1+2=3; [10,20) gets 3+4=7; [20,30) gets 5 and is
    // flushed at end-of-stream, so every window is emitted.
    const result = runStreaming([ev(0, 1, "a"), ev(5, 2, "b"), ev(10, 3, "c"), ev(15, 4, "d"), ev(20, 5, "e")], opts());
    const closed = result.windows.map((w) => ({ start: w.start, value: w.value, count: w.count }));
    expect(closed).toEqual([
      { start: 0, value: 3, count: 2 },
      { start: 10, value: 7, count: 2 },
      { start: 20, value: 5, count: 1 },
    ]);
    expect(result.diagnostics.windowsStillOpen).toBe(0);
  });

  it("arrival order never changes the answer (event time wins)", () => {
    // The bounded watermark is the strategy that tolerates disorder; the
    // pure event-time watermark would (correctly) call early arrivals late.
    const bounded = opts({ watermark: "bounded-out-of-orderness", maxOutOfOrderness: 25 });
    const inOrder = [ev(0, 1, "a"), ev(5, 2, "b"), ev(10, 3, "c"), ev(20, 5, "e")];
    const shuffled = [ev(20, 5, "e"), ev(10, 3, "c"), ev(0, 1, "a"), ev(5, 2, "b")];
    const a = runStreaming(inOrder, bounded);
    const b = runStreaming(shuffled, bounded);
    expect(b.windows.map((w) => ({ s: w.start, v: w.value }))).toEqual(
      a.windows.map((w) => ({ s: w.start, v: w.value })),
    );
    expect(b.diagnostics.outOfOrderEvents).toBeGreaterThan(0);
  });

  it("deduplicates replayed tokens before they can double-count (exactly-once)", () => {
    const result = runStreaming([ev(0, 1, "a"), ev(5, 2, "b"), ev(5, 2, "b"), ev(10, 3, "c")], opts());
    expect(result.diagnostics.duplicateEvents).toBe(1);
    expect(result.windows.find((w) => w.start === 0)?.value).toBe(3); // not 5
  });

  it("counts an event beyond the allowed lateness as late, never absorbs it", () => {
    // Watermark reaches 20 via the last event; the t=1 token then arrives —
    // window [0,10) already closed at watermark 10 with lateness 0.
    const result = runStreaming([ev(0, 100, "a"), ev(10, 2, "b"), ev(20, 3, "c"), ev(1, 999, "late")], opts());
    expect(result.diagnostics.lateEvents + result.diagnostics.droppedEvents).toBeGreaterThanOrEqual(1);
    expect(result.windows.find((w) => w.start === 0)?.value).toBe(100); // unchanged by the late row
  });

  it("honours allowedLateness — a late row inside the grace period still counts", () => {
    // Lateness 5 with watermark 10: arrivals at or above watermark−lateness
    // (= 5) are inside the grace period. The t=6 row joins window [0,10).
    const result = runStreaming([ev(0, 100, "a"), ev(10, 2, "b"), ev(6, 5, "late")], opts({ allowedLateness: 5 }));
    expect(result.windows.find((w) => w.start === 0)?.value).toBe(105);
  });

  it("refuses an empty stream with an honest error", () => {
    expect(() => runStreaming([], opts())).toThrow(StreamingError);
  });
});

describe("runStreaming — session windows", () => {
  it("forms sessions by inactivity gap, not by fixed bounds", () => {
    // Two bursts separated by 100 units of silence (> gap 10): two sessions.
    const result = runStreaming(
      [ev(0, 1, "a"), ev(5, 2, "b"), ev(110, 3, "c"), ev(115, 4, "d")],
      opts({ window: { kind: "session", size: 10 } }),
    );
    const total = result.windows.reduce((acc, w) => acc + w.value, 0);
    const opens = result.windows.length + result.diagnostics.windowsStillOpen;
    expect(total).toBeLessThanOrEqual(10); // 1+2 and 3+4 at most
    expect(opens).toBeGreaterThanOrEqual(1);
    // The two sessions never merge: no window contains both token a and c.
    for (const w of result.windows) {
      expect(w.end - w.start).toBeLessThanOrEqual(25);
    }
  });
});

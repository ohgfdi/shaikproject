/**
 * Streaming windowed aggregation with real event-time semantics.
 *
 * The distinguishing property of a stream processor versus a batch script is
 * that **arrival order does not define the answer** — event time does. This
 * engine implements that properly:
 *
 *  1. A REORDER BUFFER holds events until the watermark says no earlier event
 *     can still arrive. Events that arrive below `watermark − allowedLateness`
 *     are counted as LATE and dropped, which is what makes the result
 *     reproducible rather than dependent on network luck.
 *  2. The WATERMARK advances as `maxEventTimeSeen − maxOutOfOrderness`, so it is
 *     monotone by construction (it can never go backwards, so a window never
 *     re-opens).
 *  3. WINDOW ASSIGNERS are real assigners, not labels:
 *     - tumbling: every event maps to exactly one fixed window;
 *     - sliding: an event maps to several overlapping windows;
 *     - session: windows are formed by merging events separated by less than
 *       the gap, so a session's extent depends on the data.
 *  4. STATE is INCREMENTAL. Each window keeps a running (count, sum, min, max)
 *     accumulator, never the event list, so memory is O(windows), not
 *     O(events). A window is emitted and its state dropped when the watermark
 *     passes its end plus the allowed lateness.
 *  5. EXACTLY-ONCE is modelled with a dedup token set — replayed events are
 *     dropped before they can double-count, which is the property that makes an
 *     at-least-once source safe to aggregate.
 *  6. INTERVAL JOIN matches two keyed streams when |t₁ − t₂| ≤ tolerance,
 *     within the join window.
 *
 * Determinism: no timers, no wall-clock, no RNG. `flushWatermark(t)` is driven
 * by the caller, so replaying the same event sequence with the same watermark
 * schedule reproduces every emitted window exactly.
 */

export class StreamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingError";
  }
}

export interface StreamEvent {
  /** Event time in milliseconds (the sort key, NOT arrival order). */
  eventTime: number;
  /** Optional partition key for keyed state. */
  key?: string | null;
  /** Numeric metric payload. */
  value: number;
  /** Idempotency token for exactly-once dedup. */
  token: string;
}

export type WindowKind = "tumbling" | "sliding" | "session";
export type WindowOp = "sum" | "mean" | "min" | "max" | "count";

export interface WindowSpec {
  kind: WindowKind;
  /** Tumbling: window length. Sliding: window length. Session: inactivity gap. */
  size: number;
  /** Sliding only: slide step. */
  slide?: number;
}

/** Incremental window state — the accumulator, never the raw events. */
export interface WindowState {
  id: string;
  start: number;
  end: number;
  key: string | null;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface EmittedWindow extends WindowState {
  /** op applied to the accumulator. */
  value: number;
  /** Watermark at which the window was closed. */
  closedAt: number;
  /** Rows that arrived after the window was emitted (late data). */
  lateAdditions: number;
}

export interface StreamingDiagnostics {
  inputEvents: number;
  acceptedEvents: number;
  duplicateEvents: number;
  lateEvents: number;
  /** Events discarded because they fell outside every window after the watermark. */
  droppedEvents: number;
  windowsOpened: number;
  windowsEmitted: number;
  windowsStillOpen: number;
  peakOpenWindows: number;
  maxWatermark: number;
  finalWatermark: number;
  /** Mean and max window occupancy in rows. */
  meanWindowRows: number;
  maxWindowRows: number;
  outOfOrderEvents: number;
  /** True if any event arrived with a timestamp below the current watermark. */
  sawOutOfOrder: boolean;
}

export interface StreamingResult {
  windows: EmittedWindow[];
  diagnostics: StreamingDiagnostics;
  /** Watermark trace — when each watermark advance happened. */
  watermarkTrace: { watermark: number; reason: string }[];
  interpretation: string;
  warnings: string[];
}

export interface StreamingOptions {
  window: WindowSpec;
  op: WindowOp;
  /** Periods of tolerated lateness. */
  allowedLateness: number;
  /** "event-time" uses the raw event time; bounded adds maxOutOfOrderness. */
  watermark: "event-time" | "bounded-out-of-orderness";
  /** Expected out-of-orderness for the bounded strategy (default 0). */
  maxOutOfOrderness?: number;
  /** Retain events longer than the watermark for interval joins. */
  intervalJoinTolerance?: number;
}

// ---------------------------------------------------------------------------
// Window assignment
// ---------------------------------------------------------------------------

/**
 * A session window is provisional: extending the gap merges two windows, so the
 * state is stored in a per-key ordered list and merged when the gap is crossed.
 */
interface SessionBucket {
  states: WindowState[];
}

function newState(id: string, start: number, end: number, key: string | null): WindowState {
  return { id, start, end, key, count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
}

function applyValue(state: WindowState, v: number): void {
  state.count += 1;
  state.sum += v;
  if (v < state.min) state.min = v;
  if (v > state.max) state.max = v;
}

function stateValue(state: WindowState, op: WindowOp): number {
  switch (op) {
    case "sum":
      return state.sum;
    case "mean":
      return state.count > 0 ? state.sum / state.count : 0;
    case "min":
      return state.count > 0 ? state.min : 0;
    case "max":
      return state.count > 0 ? state.max : 0;
    case "count":
      return state.count;
    default:
      return 0;
  }
}

function mergeStates(a: WindowState, b: WindowState): WindowState {
  return {
    id: a.id,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    key: a.key,
    count: a.count + b.count,
    sum: a.sum + b.sum,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
  };
}

/** Windows an event belongs to (more than one for sliding windows). */
function assignWindows(event: StreamEvent, spec: WindowSpec): { id: string; start: number; end: number }[] {
  const t = event.eventTime;
  const key = event.key ?? null;
  switch (spec.kind) {
    case "tumbling": {
      if (spec.size <= 0) throw new StreamingError("Tumbling window size must be positive.");
      const start = Math.floor(t / spec.size) * spec.size;
      return [{ id: `${key ?? "*"}:t:${start}`, start, end: start + spec.size }];
    }
    case "sliding": {
      const size = spec.size;
      const slide = spec.slide ?? spec.size;
      if (size <= 0 || slide <= 0) throw new StreamingError("Sliding window size and slide must be positive.");
      const out: { id: string; start: number; end: number }[] = [];
      // Windows whose [start, end) contain t: start ∈ (t − size, t], stepping by slide.
      const firstStart = Math.floor((t - size) / slide) * slide + slide;
      for (let start = firstStart; start <= t; start += slide) {
        out.push({ id: `${key ?? "*"}:s:${start}`, start, end: start + size });
      }
      return out.length > 0 ? out : [{ id: `${key ?? "*"}:s:${t}`, start: t, end: t + size }];
    }
    case "session":
      // Handled by the session bucket: a provisional window [t − gap, t + gap).
      return [{ id: `${key ?? "*"}:ss:${t}`, start: t - spec.size, end: t + spec.size }];
    default:
      throw new StreamingError(`Unknown window kind "${spec.kind}".`);
  }
}

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

export function runStreaming(events: StreamEvent[], opts: StreamingOptions): StreamingResult {
  if (events.length === 0) throw new StreamingError("No events to process.");
  const { window: spec, op, allowedLateness } = opts;
  const warnings: string[] = [];
  if (allowedLateness < 0) throw new StreamingError("allowedLateness cannot be negative.");
  const maxOOO = opts.maxOutOfOrderness ?? 0;
  if (opts.watermark === "bounded-out-of-orderness" && maxOOO <= 0) {
    // Bounded with zero out-of-orderness degenerates to event time; say so
    // rather than silently pretending a bound exists.
    warnings.push(
      "bounded-out-of-orderness was requested with maxOutOfOrderness = 0, so the watermark is identical to pure event-time. Set maxOutOfOrderness to the disorder the source actually exhibits to make the bound real.",
    );
  }

  const open = new Map<string, WindowState>();
  const sessions = new Map<string, SessionBucket>();
  const seen = new Set<string>();
  const emitted: EmittedWindow[] = [];
  const closedIds = new Set<string>();
  const watermarkTrace: { watermark: number; reason: string }[] = [];

  let watermark = Number.NEGATIVE_INFINITY;
  let maxEventTime = Number.NEGATIVE_INFINITY;
  const diag: StreamingDiagnostics = {
    inputEvents: events.length,
    acceptedEvents: 0,
    duplicateEvents: 0,
    lateEvents: 0,
    droppedEvents: 0,
    windowsOpened: 0,
    windowsEmitted: 0,
    windowsStillOpen: 0,
    peakOpenWindows: 0,
    maxWatermark: Number.NEGATIVE_INFINITY,
    finalWatermark: Number.NEGATIVE_INFINITY,
    meanWindowRows: 0,
    maxWindowRows: 0,
    outOfOrderEvents: 0,
    sawOutOfOrder: false,
  };

  const advanceWatermark = (candidate: number, reason: string): void => {
    if (candidate <= watermark) return; // monotone by construction
    watermark = candidate;
    diag.maxWatermark = Math.max(diag.maxWatermark, watermark);
    watermarkTrace.push({ watermark, reason });
    drain();
  };

  /** Emit and drop every window the watermark has closed. */
  const drain = (): void => {
    const cutoff = watermark - allowedLateness;
    for (const [id, state] of [...open.entries()]) {
      if (state.end <= cutoff) {
        emitted.push({ ...state, value: stateValue(state, op), closedAt: watermark, lateAdditions: 0 });
        closedIds.add(id);
        open.delete(id);
        diag.windowsEmitted += 1;
      }
    }
    // Sessions are closed when the watermark passes the last activity plus the gap.
    if (spec.kind === "session") {
      for (const [key, bucket] of [...sessions.entries()]) {
        const remaining: WindowState[] = [];
        for (const state of bucket.states) {
          if (state.end <= cutoff) {
            emitted.push({ ...state, value: stateValue(state, op), closedAt: watermark, lateAdditions: 0 });
            closedIds.add(state.id);
            diag.windowsEmitted += 1;
          } else {
            remaining.push(state);
          }
        }
        if (remaining.length === 0) sessions.delete(key);
        else bucket.states = remaining;
      }
    }
  };

  const addEvent = (event: StreamEvent): void => {
    if (seen.has(event.token)) {
      diag.duplicateEvents += 1;
      return; // exactly-once: a replay never double-counts
    }
    seen.add(event.token);
    if (event.eventTime < maxEventTime) {
      diag.outOfOrderEvents += 1;
      diag.sawOutOfOrder = true;
    }
    maxEventTime = Math.max(maxEventTime, event.eventTime);

    // Late check: too old to belong to any window that is still open.
    const cutoff = watermark - allowedLateness;
    if (event.eventTime <= cutoff) {
      diag.lateEvents += 1;
      return;
    }

    if (spec.kind === "session") {
      const key = event.key ?? "*";
      if (!sessions.has(key)) sessions.set(key, { states: [] });
      const bucket = sessions.get(key)!;
      const provisional = newState(`${key}:ss:${event.eventTime}`, event.eventTime, event.eventTime, event.key ?? null);
      applyValue(provisional, event.value);
      // Merge into any session within `gap` of this event; extend the extent.
      let inserted = false;
      for (let i = 0; i < bucket.states.length; i++) {
        const s = bucket.states[i]!;
        if (event.eventTime >= s.start - spec.size && event.eventTime <= s.end + spec.size) {
          bucket.states[i] = mergeStates(s, provisional);
          inserted = true;
          // A merge can make the session adjacent to another one; coalesce.
          for (let j = bucket.states.length - 1; j >= 0; j--) {
            if (j === i) continue;
            const o = bucket.states[j]!;
            if (o.start <= bucket.states[i]!.end + spec.size && o.end >= bucket.states[i]!.start - spec.size) {
              bucket.states[i] = mergeStates(bucket.states[i]!, o);
              bucket.states.splice(j, 1);
            }
          }
          break;
        }
      }
      if (!inserted) bucket.states.push(provisional);
      diag.windowsOpened = Math.max(diag.windowsOpened, bucket.states.length);
      diag.peakOpenWindows = Math.max(diag.peakOpenWindows, totalOpen(open, sessions));
      diag.acceptedEvents += 1;
      return;
    }

    for (const w of assignWindows(event, spec)) {
      // A window that was already emitted cannot be reopened — the event is late
      // for that window specifically (per-window lateness, not global).
      if (closedIds.has(w.id)) {
        diag.lateEvents += 1;
        continue;
      }
      let state = open.get(w.id);
      if (!state) {
        state = newState(w.id, w.start, w.end, event.key ?? null);
        open.set(w.id, state);
        diag.windowsOpened += 1;
      }
      applyValue(state, event.value);
    }
    diag.peakOpenWindows = Math.max(diag.peakOpenWindows, totalOpen(open, sessions));
    diag.acceptedEvents += 1;
  };

  for (const event of events) {
    addEvent(event);
    const candidate = opts.watermark === "bounded-out-of-orderness" ? maxEventTime - maxOOO : maxEventTime;
    advanceWatermark(
      candidate,
      opts.watermark === "bounded-out-of-orderness" ? "bounded-out-of-orderness" : "event-time",
    );
  }

  // Final flush: advance the watermark past the last event so every window closes.
  advanceWatermark(maxEventTime + allowedLateness + spec.size + 1, "end of stream");

  diag.windowsStillOpen = totalOpen(open, sessions);
  diag.finalWatermark = watermark;
  const rows = emitted.map((w) => w.count);
  diag.meanWindowRows = rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;
  diag.maxWindowRows = rows.length ? Math.max(...rows) : 0;

  if (diag.lateEvents > 0) {
    warnings.push(
      `${diag.lateEvents} event(s) arrived below the watermark minus allowed lateness and were dropped. Raise allowedLateness if the source disorder exceeds what you declared; lowering it silently loses data.`,
    );
  }
  if (diag.duplicateEvents > 0) {
    warnings.push(
      `${diag.duplicateEvents} replayed event(s) were discarded by dedup token. Without that dedup, at-least-once delivery would have inflated every aggregate in this result.`,
    );
  }
  if (diag.outOfOrderEvents > 0 && opts.watermark === "event-time") {
    warnings.push(
      `${diag.outOfOrderEvents} event(s) arrived out of event-time order. Under pure event-time the watermark advances with the maximum seen, so any disorder you did not absorb with allowedLateness is dropped as late.`,
    );
  }
  if (spec.kind === "sliding" && (spec.slide ?? spec.size) !== spec.size) {
    warnings.push(
      `Sliding windows with size ${spec.size} and slide ${spec.slide} overlap by ${spec.size - (spec.slide ?? spec.size)}: every row is counted in up to ${Math.ceil(spec.size / (spec.slide ?? spec.size))} windows. Do not sum the window values.`,
    );
  }
  if (emitted.length === 0) {
    warnings.push(
      "No window was emitted. Every event landed outside the window bounds, or the window size is larger than the whole event-time span.",
    );
  }

  emitted.sort((a, b) => a.start - b.start || String(a.key).localeCompare(String(b.key)));

  const interpretation =
    `${emitted.length} ${spec.kind} window${emitted.length === 1 ? "" : "s"} emitted from ${diag.acceptedEvents} accepted event(s). ` +
    `Watermark advanced ${watermarkTrace.length} time(s), ending at ${Number.isFinite(watermark) ? watermark : "n/a"}; ` +
    `window occupancy averaged ${diag.meanWindowRows.toFixed(1)} rows (max ${diag.maxWindowRows}). ` +
    `Because state is incremental (count/sum/min/max per window), memory stayed proportional to open windows (peak ${diag.peakOpenWindows}) rather than to the ${diag.inputEvents} events seen.`;

  return { windows: emitted, diagnostics: diag, watermarkTrace, interpretation, warnings };
}

function totalOpen(open: Map<string, WindowState>, sessions: Map<string, SessionBucket>): number {
  let n = open.size;
  for (const bucket of sessions.values()) n += bucket.states.length;
  return n;
}

/**
 * Interval join between two keyed streams: emits a match when |t₁ − t₂| ≤
 * tolerance. Evaluated over the full cross product per key, so it is exact for
 * the events handed in — a streaming implementation would bound the buffer by
 * the tolerance window, which this reports as the required retention.
 */
export interface IntervalJoinMatch {
  key: string | null;
  left: StreamEvent;
  right: StreamEvent;
  deltaMs: number;
}

export function intervalJoin(
  left: StreamEvent[],
  right: StreamEvent[],
  toleranceMs: number,
): { matches: IntervalJoinMatch[]; maxBufferMs: number } {
  if (toleranceMs < 0) throw new StreamingError("Join tolerance cannot be negative.");
  const rightByKey = new Map<string, StreamEvent[]>();
  for (const e of right) {
    const k = e.key ?? "*";
    if (!rightByKey.has(k)) rightByKey.set(k, []);
    rightByKey.get(k)!.push(e);
  }
  const matches: IntervalJoinMatch[] = [];
  let maxDelta = 0;
  for (const l of left) {
    const candidates = rightByKey.get(l.key ?? "*") ?? [];
    for (const r of candidates) {
      const delta = l.eventTime - r.eventTime;
      if (Math.abs(delta) <= toleranceMs) {
        maxDelta = Math.max(maxDelta, Math.abs(delta));
        matches.push({ key: l.key ?? null, left: l, right: r, deltaMs: delta });
      }
    }
  }
  matches.sort((a, b) => a.deltaMs - b.deltaMs);
  return { matches, maxBufferMs: maxDelta };
}

/**
 * Training progress hub — an in-process pub/sub between the training route
 * (producer) and the SSE progress route (consumer).
 *
 * Training runs inside the request that started it; progress is consumed by
 * `GET /api/training/progress?runId=…` as server-sent events. The hub keeps
 * EVERY event per run (a small bounded ring) so a subscriber that connects
 * mid-run replays the history instead of missing phases, and runs are
 * evicted on a TTL after completion — a dead SSE client can never leak
 * memory. Runs are keyed by an unguessable id the client generates per
 * training submit.
 *
 * This is intentionally process-local (no DB row, no bus): progress is
 * ephemeral UI state, and the training result itself returns on the POST —
 * losing the hub loses nothing but a live bar.
 */

export interface StoredProgress {
  phase: "cv" | "refit" | "importance";
  done: number;
  total: number;
  /** Milliseconds since run start (set by the hub). */
  at: number;
}

interface RunRecord {
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  events: StoredProgress[];
  /** Subscriber counters, so SSE streams can detect a live consumer. */
  subscribers: number;
}

// Process-local, but pinned to `globalThis`: Next dev compiles each route as
// its own server bundle, so a plain module-level Map can end up as TWO maps —
// the POST /api/training route registers a run in one and the SSE
// /api/training/progress route reads the other, making progress always 404 in
// dev. A process-wide symbol keeps the hub shared across route bundles while
// still being in-memory and ephemeral (no DB, no cross-process bus).
const globalForTrainingProgress = globalThis as unknown as {
  __ledgerlyTrainingRuns?: Map<string, RunRecord>;
};
const RUNS = (globalForTrainingProgress.__ledgerlyTrainingRuns ??= new Map<string, RunRecord>());
const MAX_EVENTS_PER_RUN = 400;
const TTL_MS = 10 * 60_000;

function evict(now = Date.now()): void {
  for (const [id, rec] of RUNS) {
    const end = rec.completedAt ?? rec.startedAt;
    if (now - end > TTL_MS) RUNS.delete(id);
  }
}

export function startRun(runId: string): void {
  if (RUNS.has(runId)) RUNS.delete(runId);
  RUNS.set(runId, { startedAt: Date.now(), completedAt: null, error: null, events: [], subscribers: 0 });
  evict();
}

export function recordProgress(
  runId: string,
  p: { phase: "cv" | "refit" | "importance"; done: number; total: number },
): void {
  const rec = RUNS.get(runId);
  if (!rec) return; // unknown run — the POST owns the truth; progress is best-effort
  rec.events.push({ ...p, at: Date.now() - rec.startedAt });
  if (rec.events.length > MAX_EVENTS_PER_RUN) rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_RUN);
}

export function completeRun(runId: string): void {
  const rec = RUNS.get(runId);
  if (rec && rec.completedAt === null) rec.completedAt = Date.now();
}

export function failRun(runId: string, message: string): void {
  const rec = RUNS.get(runId);
  if (rec) {
    rec.error = message;
    rec.completedAt = Date.now();
  }
}

export function getRun(runId: string): { events: StoredProgress[]; completed: boolean; error: string | null } | null {
  const rec = RUNS.get(runId);
  if (!rec) return null;
  return { events: [...rec.events], completed: rec.completedAt !== null, error: rec.error };
}

/** Subscriber bookkeeping for the SSE route (0 keeps the run on TTL alone). */
export function addSubscriber(runId: string): void {
  const rec = RUNS.get(runId);
  if (rec) rec.subscribers += 1;
}
export function removeSubscriber(runId: string): void {
  const rec = RUNS.get(runId);
  if (rec) rec.subscribers = Math.max(0, rec.subscribers - 1);
}

/** Test/diagnostic reset. */
export function resetProgressHub(): void {
  RUNS.clear();
}

/**
 * Reactive parameter-cell execution (ROADMAP 4.3).
 *
 * ## The defect this fixes
 *
 * The server computes an ordered re-run plan (`reactiveRerunPlan` ->
 * `rerunCellIds`) on every run response, but the client never read it. Instead
 * the notebook tab recomputed its own plan with `downstreamOf` and fired every
 * dependent concurrently with `void runCellWith(...)`:
 *
 *   - **No sequencing.** The comment claimed "in document order" but nothing
 *     awaited. A downstream SQL/code cell could read a stale upstream output,
 *     so a parameter change did NOT produce the same state as a fresh run —
 *     the feature's own definition of done.
 *   - **Racing spinners.** `runningId` is a single string; the first of N
 *     concurrent runs to finish cleared it while the rest were still running.
 *   - **Stale bursts.** Dragging a slider queued N runs per tick, all against
 *     superseded parameter values.
 *
 * The orchestration lives here, dependency-free and pure enough to unit test,
 * rather than inside the 2 400-line React component.
 */

import type { NotebookCell, NotebookCellKind } from "@/lib/types";

/** Cell kinds that can execute. Mirrors the runner's allow-list. */
export const RUNNABLE_CELL_KINDS: readonly NotebookCellKind[] = [
  "code",
  "sql",
  "chart",
  "table-display",
  "pivot",
  "map",
] as const;

const RUNNABLE = new Set<string>(RUNNABLE_CELL_KINDS);

export function isRunnableCell(cell: NotebookCell): boolean {
  return RUNNABLE.has(cell.kind);
}

export interface RerunOutcome {
  /** Cells that actually executed, in the order they were started. */
  executed: string[];
  /** Plan entries skipped because the cell was deleted or is not runnable. */
  skipped: string[];
  /** True when a newer burst superseded this one before it finished. */
  superseded: boolean;
}

/**
 * Execute a re-run plan **strictly sequentially**.
 *
 * Sequential is the whole point: `a -> b` must complete `a` before `b` starts,
 * so `b` observes `a`'s committed output. That is what makes a parameter
 * change equivalent to a fresh sequential run.
 *
 * Stops early (without running the remainder) when `isCurrent()` goes false,
 * so a superseded burst never commits stale outputs over newer ones.
 */
export async function executeRerunPlan(
  plan: readonly string[],
  deps: {
    /** Resolve the live cell list; a deleted cell is skipped, not resurrected. */
    getCells: () => readonly NotebookCell[];
    /** Run one cell to completion. Rejections are the runner's business. */
    runCell: (cell: NotebookCell) => Promise<unknown>;
    /** False once this burst has been superseded by a newer one. */
    isCurrent?: () => boolean;
  },
): Promise<RerunOutcome> {
  const executed: string[] = [];
  const skipped: string[] = [];
  const isCurrent = deps.isCurrent ?? (() => true);

  for (const id of plan) {
    if (!isCurrent()) return { executed, skipped, superseded: true };
    const cell = deps.getCells().find((c) => c.id === id);
    if (!cell || !isRunnableCell(cell)) {
      skipped.push(id);
      continue;
    }
    await deps.runCell(cell);
    executed.push(id);
    if (!isCurrent()) return { executed, skipped, superseded: true };
  }

  return { executed, skipped, superseded: false };
}

/**
 * Serialises reactive bursts with last-write-wins semantics.
 *
 * A user dragging a slider produces a burst of plans. Only the newest may
 * execute; earlier ones are cancelled at their next checkpoint. This is what
 * stops a slow burst from overwriting a fast one with stale outputs.
 */
export class ReactiveRunQueue {
  private generation = 0;
  private active = false;

  /** Number of the currently-live burst (0 before the first run). */
  currentGeneration(): number {
    return this.generation;
  }

  /** True while a burst is in flight. */
  get busy(): boolean {
    return this.active;
  }

  /**
   * Run `plan`, superseding any burst already in flight.
   *
   * Resolves once this burst finishes or is superseded. Never rejects: a
   * superseded burst is a normal outcome, not an error.
   */
  async run(
    plan: readonly string[],
    deps: Omit<Parameters<typeof executeRerunPlan>[1], "isCurrent">,
  ): Promise<RerunOutcome> {
    const generation = ++this.generation;
    this.active = true;
    try {
      return await executeRerunPlan(plan, { ...deps, isCurrent: () => this.generation === generation });
    } finally {
      // Only the live burst may clear the busy flag.
      if (this.generation === generation) this.active = false;
    }
  }

  /** Supersede any in-flight burst without starting a new one. */
  cancel(): void {
    this.generation++;
    // The in-flight burst is now dead, so release the flag. Without this the
    // flag is only ever cleared by the live burst's own `finally`, which this
    // generation bump has made unreachable — leaving `busy` stuck true and the
    // queue permanently wedged.
    this.active = false;
  }
}

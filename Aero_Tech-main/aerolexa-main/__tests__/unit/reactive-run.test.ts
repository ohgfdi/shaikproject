/**
 * Reactive parameter-cell orchestration (ROADMAP 4.3).
 *
 * The bug these lock down: the client fired every dependent with
 * `void runCellWith(dependent, cells)` in a loop, so a `a -> b` cascade ran a
 * and b CONCURRENTLY. b could read a's previous output, so changing a parameter
 * did not reproduce the state of a fresh sequential run — the feature's own
 * definition of done. A single `runningId` also meant the first of N runs to
 * finish cleared the spinner for all of them.
 */

import { ReactiveRunQueue, executeRerunPlan, isRunnableCell } from "@/lib/engine/reactive-run";
import type { NotebookCell, NotebookCellKind } from "@/lib/types";

function cell(id: string, kind: NotebookCellKind = "code", extra: Partial<NotebookCell> = {}): NotebookCell {
  return { id, kind, content: "", ...extra } as NotebookCell;
}

describe("isRunnableCell", () => {
  it.each(["code", "sql", "chart", "table-display", "pivot", "map"] as const)("accepts %s", (kind) => {
    expect(isRunnableCell(cell("c", kind))).toBe(true);
  });

  it.each(["widget", "markdown", "insight"] as NotebookCellKind[])("rejects non-runnable %s", (kind) => {
    expect(isRunnableCell(cell("c", kind))).toBe(false);
  });
});

describe("executeRerunPlan — strict sequencing", () => {
  it("awaits each cell before starting the next (the whole point)", async () => {
    const events: string[] = [];
    const deps = {
      getCells: () => [cell("a"), cell("b"), cell("c")],
      runCell: async (c: NotebookCell) => {
        events.push(`start:${c.id}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${c.id}`);
      },
    };

    await executeRerunPlan(["a", "b", "c"], deps);

    // The old `void` loop produced start:a start:b start:c end:a end:b end:c.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("lets a downstream cell observe the upstream output it depends on", async () => {
    const outputs = new Map<string, string>();
    const cells = [cell("a"), cell("b")];
    const outcome = await executeRerunPlan(["a", "b"], {
      getCells: () => cells,
      runCell: async (c) => {
        if (c.id === "a") {
          outputs.set("a", "fresh");
          return;
        }
        // b must never see a stale value; a completed before b started.
        expect(outputs.get("a")).toBe("fresh");
      },
    });
    expect(outcome.executed).toEqual(["a", "b"]);
    expect(outcome.superseded).toBe(false);
  });

  it("preserves the server's plan order rather than re-sorting", async () => {
    const seen: string[] = [];
    await executeRerunPlan(["c", "a", "b"], {
      getCells: () => [cell("a"), cell("b"), cell("c")],
      runCell: async (c) => {
        seen.push(c.id);
      },
    });
    expect(seen).toEqual(["c", "a", "b"]);
  });

  it("skips a deleted cell instead of resurrecting it", async () => {
    const seen: string[] = [];
    const outcome = await executeRerunPlan(["a", "gone", "b"], {
      getCells: () => [cell("a"), cell("b")],
      runCell: async (c) => {
        seen.push(c.id);
      },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(outcome.skipped).toEqual(["gone"]);
  });

  it("skips non-runnable entries (e.g. the widget cell itself)", async () => {
    const seen: string[] = [];
    const outcome = await executeRerunPlan(["w", "a"], {
      getCells: () => [cell("w", "widget"), cell("a")],
      runCell: async (c) => {
        seen.push(c.id);
      },
    });
    expect(seen).toEqual(["a"]);
    expect(outcome.skipped).toEqual(["w"]);
  });

  it("resolves the cell list per step so a mid-cascade delete is observed", async () => {
    let cells = [cell("a"), cell("b"), cell("c")];
    const seen: string[] = [];
    await executeRerunPlan(["a", "b", "c"], {
      getCells: () => cells,
      runCell: async (c) => {
        seen.push(c.id);
        if (c.id === "a") cells = [cell("a"), cell("c")];
      },
    });
    expect(seen).toEqual(["a", "c"]);
  });

  it("does nothing for an empty plan", async () => {
    const runCell = jest.fn();
    const outcome = await executeRerunPlan([], { getCells: () => [cell("a")], runCell });
    expect(runCell).not.toHaveBeenCalled();
    expect(outcome.executed).toEqual([]);
  });

  it("propagates a rejection but does not wedge the queue", async () => {
    const queue = new ReactiveRunQueue();
    const seen: string[] = [];
    // The real runner (`runCellWith`) catches internally and resolves `false`,
    // so a rejection here means a bug in a runner. It must surface rather than
    // be swallowed — and must not leave the queue permanently busy.
    await expect(
      queue.run(["a", "b", "c"], {
        getCells: () => [cell("a"), cell("b"), cell("c")],
        runCell: async (c) => {
          seen.push(c.id);
          if (c.id === "b") throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(seen).toEqual(["a", "b"]);
    expect(queue.busy).toBe(false);

    const next = await queue.run(["a"], { getCells: () => [cell("a")], runCell: async () => {} });
    expect(next.executed).toEqual(["a"]);
  });
});

describe("executeRerunPlan — supersession", () => {
  it("stops before starting the next cell once superseded", async () => {
    let live = true;
    const seen: string[] = [];
    const outcome = await executeRerunPlan(["a", "b", "c"], {
      getCells: () => [cell("a"), cell("b"), cell("c")],
      isCurrent: () => live,
      runCell: async (c) => {
        seen.push(c.id);
        if (c.id === "a") live = false;
      },
    });
    // b and c must NOT run: their outputs would be computed against
    // parameter values the user has already moved on from.
    expect(seen).toEqual(["a"]);
    expect(outcome.superseded).toBe(true);
  });

  it("reports superseded even when the last cell itself was cancelled mid-flight", async () => {
    let live = true;
    const outcome = await executeRerunPlan(["a"], {
      getCells: () => [cell("a")],
      isCurrent: () => live,
      runCell: async () => {
        live = false;
      },
    });
    expect(outcome.executed).toEqual(["a"]);
    expect(outcome.superseded).toBe(true);
  });
});

describe("ReactiveRunQueue — last write wins under a slider drag", () => {
  it("supersedes an in-flight burst so a later change wins", async () => {
    const queue = new ReactiveRunQueue();
    const first: string[] = [];
    const second: string[] = [];

    const p1 = queue.run(["a", "b", "c"], {
      getCells: () => [cell("a"), cell("b"), cell("c")],
      runCell: async (c) => {
        first.push(c.id);
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    // Second drag tick arrives while the first burst is mid-flight.
    const p2 = queue.run(["a", "b"], {
      getCells: () => [cell("a"), cell("b")],
      runCell: async (c) => {
        second.push(c.id);
      },
    });

    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.superseded).toBe(true);
    expect(o2.superseded).toBe(false);
    // The stale burst must not run its whole plan after being overtaken.
    expect(first.length).toBeLessThan(3);
    expect(second).toEqual(["a", "b"]);
  });

  it("clears busy only for the live burst", async () => {
    const queue = new ReactiveRunQueue();
    const slow = queue.run(["a"], {
      getCells: () => [cell("a")],
      runCell: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    expect(queue.busy).toBe(true);
    const fast = queue.run(["a"], { getCells: () => [cell("a")], runCell: async () => {} });
    await fast;
    // The fast burst finished; the slow one may still be unwinding, but the
    // queue is free for the next change.
    expect(queue.busy).toBe(false);
    await slow;
    expect(queue.busy).toBe(false);
  });

  it("cancel() supersedes without starting a replacement", async () => {
    const queue = new ReactiveRunQueue();
    const seen: string[] = [];
    const p = queue.run(["a", "b", "c"], {
      getCells: () => [cell("a"), cell("b"), cell("c")],
      runCell: async (c) => {
        seen.push(c.id);
        if (c.id === "a") queue.cancel();
      },
    });
    const outcome = await p;
    expect(seen).toEqual(["a"]);
    expect(outcome.superseded).toBe(true);
    expect(queue.busy).toBe(false);
  });

  it("clears busy after a rejecting burst so the next change still runs", async () => {
    const queue = new ReactiveRunQueue();
    await expect(
      queue.run(["a"], {
        getCells: () => [cell("a")],
        runCell: async () => {
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("nope");
    // A failed burst must not wedge the queue for the next widget change.
    expect(queue.busy).toBe(false);
    const ok = await queue.run(["b"], { getCells: () => [cell("b")], runCell: async () => {} });
    expect(ok.executed).toEqual(["b"]);
  });
});

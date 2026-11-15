/**
 * Notebook DAG orchestration (E16) — oracle tests for the engine the run route
 * now uses to produce an execution plan.
 *
 * The contract: dependencies come from explicit `dependencies[]` and from
 * `$variable` references to a cell's `outputVariable`; the topological order
 * places every upstream cell before its dependents; a cycle is reported with
 * its path instead of being silently ordered; `executeDag` calls the executor
 * once per runnable cell in that order and records variable outputs.
 */
import { describe, expect, it } from "@jest/globals";

import {
  buildDag,
  executeDag,
  getTransitiveDependencies,
  getTransitiveDependents,
  wouldCreateCycle,
  type VariableStore,
} from "@/lib/engine/notebook-dag";
import type { NotebookCell, NotebookCellOutput } from "@/lib/types";

function cell(partial: Record<string, unknown>): NotebookCell {
  return { id: "c", kind: "code", content: "", ...partial } as unknown as NotebookCell;
}

const output = (id: string): NotebookCellOutput => ({ type: "error", message: id }) as unknown as NotebookCellOutput;

describe("buildDag", () => {
  it("orders implicit $variable dependencies upstream-first", () => {
    const cells = [
      cell({ id: "c3", content: "print($b)" }),
      cell({ id: "c1", content: "x = 1", outputVariable: "a" }),
      cell({ id: "c2", content: "y = $a", outputVariable: "b" }),
    ];
    const dag = buildDag(cells);
    expect(dag.hasCycle).toBe(false);
    expect(dag.sortedIds.indexOf("c1")).toBeLessThan(dag.sortedIds.indexOf("c2"));
    expect(dag.sortedIds.indexOf("c2")).toBeLessThan(dag.sortedIds.indexOf("c3"));
    expect(dag.nodes.get("c2")?.upstreamIds).toEqual(["c1"]);
    expect(dag.nodes.get("c1")?.downstreamIds.sort()).toEqual(["c2"]);
  });

  it("honours explicit dependencies[] as well as variable references", () => {
    const cells = [
      cell({ id: "a", outputVariable: "a" }),
      cell({ id: "b", dependencies: [{ dependsOn: "a" }] as NotebookCell["dependencies"] }),
    ];
    const dag = buildDag(cells);
    expect(dag.sortedIds).toEqual(["a", "b"]);
  });

  it("reports a cycle with its path instead of inventing an order", () => {
    const cells = [
      cell({ id: "x", content: "y = $y", outputVariable: "x" }),
      cell({ id: "y", content: "x = $x", outputVariable: "y" }),
    ];
    const dag = buildDag(cells);
    expect(dag.hasCycle).toBe(true);
    expect(dag.cyclePath?.length).toBeGreaterThan(0);
    expect(dag.sortedIds.length).toBeLessThan(2);
  });

  it("transitive helpers walk the graph in both directions", () => {
    const cells = [
      cell({ id: "a", outputVariable: "a" }),
      cell({ id: "b", content: "v = $a", outputVariable: "b" }),
      cell({ id: "c", content: "v = $b", outputVariable: "c" }),
    ];
    const dag = buildDag(cells);
    expect(getTransitiveDependents("a", dag)).toEqual(["b", "c"]);
    expect(getTransitiveDependencies("c", dag)).toEqual(["b", "a"]);
    // Adding a→c would make c depend on a, which it already does transitively.
    expect(wouldCreateCycle("a", "c", dag)).toBe(true);
    expect(wouldCreateCycle("c", "a", dag)).toBe(false);
  });
});

describe("executeDag", () => {
  it("executes runnable cells in topological order and stores outputs", async () => {
    const cells = [
      cell({ id: "second", content: "print($first)", kind: "code" }),
      cell({ id: "first", content: "1 + 1", kind: "code", outputVariable: "first" }),
      cell({ id: "note", kind: "markdown", content: "text cell" }),
    ];
    const store: VariableStore = { variables: new Map(), cellOutputs: new Map() };
    const order: string[] = [];
    const results = await executeDag(cells, store, async (c) => {
      order.push(c.id);
      return output(c.id);
    });

    expect(order).toEqual(["first", "second"]);
    const ranIds = results.filter((r) => r.output !== null).map((r) => r.cellId);
    expect(ranIds).toEqual(["first", "second"]);
    // Non-code cells are carried in the plan but never executed.
    expect(results.map((r) => r.cellId).sort()).toEqual(["first", "note", "second"]);
    expect(store.variables.get("first")).toEqual(output("first"));
    expect(store.cellOutputs.get("second")).toEqual(output("second"));
    expect(results.find((r) => r.cellId === "second")?.consumedVariables).toEqual(["first"]);
  });

  it("returns a single explicit error when the graph has a cycle", async () => {
    const cells = [
      cell({ id: "x", content: "$y", outputVariable: "x" }),
      cell({ id: "y", content: "$x", outputVariable: "y" }),
    ];
    const store: VariableStore = { variables: new Map(), cellOutputs: new Map() };
    const results = await executeDag(cells, store, async (c) => output(c.id));
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toMatch(/Circular dependency/);
    expect(store.cellOutputs.size).toBe(0);
  });
});

/**
 * DAG-based cell execution engine.
 *
 * Implements Hex's graph-based execution model where cells form a directed
 * acyclic graph. Dependencies are resolved via `outputVariable` references
 * and explicit `dependencies[]` on each cell. Topological sort determines
 * execution order; each cell receives the outputs of its predecessors.
 *
 * Dependency-free + unit-tested (__tests__/unit/notebook-dag.test.ts).
 */

import type { NotebookCell, NotebookCellOutput } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DagNode {
  cell: NotebookCell;
  /** Cell IDs that this cell depends on. */
  upstreamIds: string[];
  /** Cell IDs that depend on this cell. */
  downstreamIds: string[];
}

export interface DagGraph {
  nodes: Map<string, DagNode>;
  /** Topologically sorted cell IDs (execution order). */
  sortedIds: string[];
  /** True if the graph has a cycle. */
  hasCycle: boolean;
  /** Cells involved in the cycle (if any). */
  cyclePath: string[] | null;
}

export interface ExecutionResult {
  cellId: string;
  output: NotebookCellOutput | null;
  error: string | null;
  /** Names of upstream variables consumed by this cell. */
  consumedVariables: string[];
}

export interface VariableStore {
  /** Maps outputVariable → cell output. */
  variables: Map<string, NotebookCellOutput>;
  /** Maps cellId → output. */
  cellOutputs: Map<string, NotebookCellOutput>;
}

// ---------------------------------------------------------------------------
// DAG construction
// ---------------------------------------------------------------------------

/**
 * Build a DAG from notebook cells. Resolves dependencies from:
 * 1. Explicit `dependencies[]` on each cell.
 * 2. Implicit: cell references another cell's `outputVariable` in its content.
 * 3. Implicit: cell references `{{variable}}` widget variables.
 */
export function buildDag(cells: NotebookCell[]): DagGraph {
  const nodes = new Map<string, DagNode>();
  const idSet = new Set(cells.map((c) => c.id));

  // Build a lookup of outputVariable → cellId
  const varToCellId = new Map<string, string>();
  for (const cell of cells) {
    if (cell.outputVariable) {
      varToCellId.set(cell.outputVariable, cell.id);
    }
  }

  // Initialise nodes
  for (const cell of cells) {
    nodes.set(cell.id, {
      cell,
      upstreamIds: [],
      downstreamIds: [],
    });
  }

  // Resolve explicit dependencies
  for (const cell of cells) {
    const node = nodes.get(cell.id)!;
    if (cell.dependencies) {
      for (const dep of cell.dependencies) {
        if (idSet.has(dep.dependsOn)) {
          node.upstreamIds.push(dep.dependsOn);
        }
      }
    }

    // Resolve implicit variable references in content for code/sql/chart cells
    if (cell.kind === "code" || cell.kind === "sql" || cell.kind === "chart" || cell.kind === "pivot") {
      const refs = extractVariableRefs(cell.content);
      for (const ref of refs) {
        const sourceCellId = varToCellId.get(ref);
        if (sourceCellId && sourceCellId !== cell.id && !node.upstreamIds.includes(sourceCellId)) {
          node.upstreamIds.push(sourceCellId);
        }
      }
    }

    // Also resolve SQL cell dataset dependencies
    if (cell.kind === "sql" && cell.sqlConfig?.datasetId) {
      // SQL cells depend on cells that produce datasets with matching IDs
      for (const other of cells) {
        if (other.id !== cell.id && other.outputVariable === cell.sqlConfig.datasetId) {
          if (!node.upstreamIds.includes(other.id)) {
            node.upstreamIds.push(other.id);
          }
        }
      }
    }
  }

  // Compute downstream IDs
  for (const [id, node] of nodes) {
    for (const upstreamId of node.upstreamIds) {
      const upstream = nodes.get(upstreamId);
      if (upstream && !upstream.downstreamIds.includes(id)) {
        upstream.downstreamIds.push(id);
      }
    }
  }

  // Topological sort (Kahn's algorithm)
  const { sortedIds, hasCycle, cyclePath } = topologicalSort(nodes);

  return { nodes, sortedIds, hasCycle, cyclePath };
}

/**
 * Extract variable references from cell content.
 * Matches patterns like `$cell_output_var` or references to known outputVariable names.
 */
function extractVariableRefs(content: string): string[] {
  const refs: string[] = [];
  // Match patterns like $var_name or ${{var_name}} — cell output references
  const matches = content.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g);
  if (matches) {
    for (const m of matches) {
      refs.push(m.slice(1)); // remove leading $
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm) with cycle detection
// ---------------------------------------------------------------------------

function topologicalSort(nodes: Map<string, DagNode>): {
  sortedIds: string[];
  hasCycle: boolean;
  cyclePath: string[] | null;
} {
  const inDegree = new Map<string, number>();
  for (const [id, node] of nodes) {
    inDegree.set(id, node.upstreamIds.length);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    const node = nodes.get(id)!;
    for (const downId of node.downstreamIds) {
      const prev = inDegree.get(downId)!;
      inDegree.set(downId, prev - 1);
      if (prev - 1 === 0) queue.push(downId);
    }
  }

  if (sorted.length === nodes.size) {
    return { sortedIds: sorted, hasCycle: false, cyclePath: null };
  }

  // Cycle detected — find the cycle path
  const remaining = new Set(nodes.keys());
  for (const id of sorted) remaining.delete(id);

  // DFS to find the cycle
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): boolean {
    if (stack.has(nodeId)) {
      // Found cycle — backtrack to find the cycle start
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart >= 0) {
        path.length = cycleStart + 1;
      }
      return true;
    }
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    stack.add(nodeId);
    path.push(nodeId);
    const node = nodes.get(nodeId)!;
    for (const downId of node.downstreamIds) {
      if (remaining.has(downId) && dfs(downId)) return true;
    }
    stack.delete(nodeId);
    path.pop();
    return false;
  }

  for (const id of remaining) {
    path.length = 0;
    visited.clear();
    stack.clear();
    if (dfs(id)) {
      return { sortedIds: sorted, hasCycle: true, cyclePath: [...path] };
    }
  }

  return { sortedIds: sorted, hasCycle: true, cyclePath: null };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute cells in DAG order. The executeCell callback is called for each
 * cell in topological order. Upstream outputs are available via the
 * variableStore.
 */
export async function executeDag(
  cells: NotebookCell[],
  variableStore: VariableStore,
  executeCell: (cell: NotebookCell, upstreamOutputs: VariableStore) => Promise<NotebookCellOutput | null>,
): Promise<ExecutionResult[]> {
  const dag = buildDag(cells);

  if (dag.hasCycle) {
    const cycleStr = dag.cyclePath ? dag.cyclePath.join(" → ") : "unknown cycle";
    return [
      {
        cellId: "",
        output: null,
        error: `Circular dependency detected: ${cycleStr}. Break the cycle by removing one dependency.`,
        consumedVariables: [],
      },
    ];
  }

  const results: ExecutionResult[] = [];

  for (const cellId of dag.sortedIds) {
    const node = dag.nodes.get(cellId)!;
    const cell = node.cell;

    // Only execute code/sql/chart/table-display/pivot/map cells
    if (!["code", "sql", "chart", "table-display", "pivot", "map"].includes(cell.kind)) {
      results.push({ cellId, output: null, error: null, consumedVariables: [] });
      continue;
    }

    // Collect consumed variable names
    const consumedVariables: string[] = [];
    for (const upId of node.upstreamIds) {
      const upNode = dag.nodes.get(upId);
      if (upNode?.cell.outputVariable) {
        consumedVariables.push(upNode.cell.outputVariable);
      }
    }

    try {
      const output = await executeCell(cell, variableStore);
      if (output) {
        variableStore.cellOutputs.set(cellId, output);
      }

      // Register output variable
      if (cell.outputVariable && output) {
        variableStore.variables.set(cell.outputVariable, output);
      }

      results.push({ cellId, output, error: null, consumedVariables });
    } catch (err) {
      const errorOutput: NotebookCellOutput = {
        type: "error",
        message: err instanceof Error ? err.message : "Execution failed",
      };
      variableStore.cellOutputs.set(cellId, errorOutput);
      results.push({
        cellId,
        output: errorOutput,
        error: errorOutput.message,
        consumedVariables,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get cells that depend on a specific cell (transitively).
 */
export function getTransitiveDependents(cellId: string, dag: DagGraph): string[] {
  const dependents: string[] = [];
  const queue = [...(dag.nodes.get(cellId)?.downstreamIds ?? [])];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    dependents.push(id);
    const node = dag.nodes.get(id);
    if (node) queue.push(...node.downstreamIds);
  }

  return dependents;
}

/**
 * Get cells that a specific cell depends on (transitively).
 */
export function getTransitiveDependencies(cellId: string, dag: DagGraph): string[] {
  const deps: string[] = [];
  const queue = [...(dag.nodes.get(cellId)?.upstreamIds ?? [])];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    deps.push(id);
    const node = dag.nodes.get(id);
    if (node) queue.push(...node.upstreamIds);
  }

  return deps;
}

/**
 * Check if adding a dependency from `fromId` to `toId` would create a cycle.
 */
export function wouldCreateCycle(fromId: string, toId: string, dag: DagGraph): boolean {
  // Adding fromId → toId means toId depends on fromId.
  // Check if fromId is already a transitive dependency of toId.
  return getTransitiveDependencies(toId, dag).includes(fromId);
}

/**
 * Decomposition-tree physicalization — from computed TreeNode to scene layout.
 *
 * Pure + deterministic, exactly like lib/scene/heatmap.ts: no DOM, no WebGL,
 * no randomness. Oracle-tested against hand-computed values
 * (__tests__/unit/scene-ai-visuals.test.ts). The React component
 * (decomposition-tree.tsx) renders this layout verbatim — the split is what
 * makes the "scene props = computed values" contract testable without
 * booting WebGL.
 *
 * Every value the scene shows is computed here from the engine's TreeNode
 * (lib/engine/ai-visuals.ts). Nothing is invented: positions are a layout,
 * sizes/heights encode `value` shares, colours reuse the chart palette.
 */

import type { TreeNode } from "@/lib/engine/ai-visuals";

/** World-space footprint of one node slab. */
export const NODE_SIZE = 1;
/** Vertical drop between tree levels. */
export const LEVEL_DROP = 1.4;
/** Horizontal gap between sibling subtrees at a given depth. */
const SIBLING_GAP = 1.9;

export interface TreeNodeLayout {
  /** Stable id: depth + label (labels are unique per level in the engine). */
  id: string;
  node: TreeNode;
  depth: number;
  /** World-space centre of the node slab. */
  x: number;
  y: number;
  z: number;
  /** Share of the parent's value, in [0,1] — drives slab height. */
  shareOfParent: number;
  /** Share of the grand total, in [0,1] — drives slab colour heat. */
  shareOfTotal: number;
  /** Encoded height of the slab (0.2..2.4), from shareOfParent. */
  height: number;
  /** Number of children (labels + honesty about drillability). */
  childCount: number;
}

export interface TreeSceneLayout {
  nodes: TreeNodeLayout[];
  /** Vertical extent the camera must frame. */
  depthCount: number;
  /** Half-width of the widest level (for camera distance). */
  maxHalfWidth: number;
  nodeCount: number;
  /** The engine's own root value — rendered as the scene's anchor number. */
  rootValue: number;
}

/**
 * Walk the engine's tree and assign every node a deterministic position.
 * Breadth-per-level: children of one node are spread symmetrically on their
 * level; deeper levels are recursively centred under their parent.
 */
export function buildTreeLayout(root: TreeNode, maxDepth = 3): TreeSceneLayout {
  const nodes: TreeNodeLayout[] = [];
  let depthCount = 0;
  let maxHalfWidth = 0;

  const walk = (node: TreeNode, depth: number, x: number): void => {
    depthCount = Math.max(depthCount, depth + 1);
    nodes.push({
      id: `${depth}:${node.label}`,
      node,
      depth,
      x,
      y: -(depth * LEVEL_DROP) || 0, // `|| 0` normalises −0 → 0
      z: 0,
      shareOfParent: node.shareOfParent,
      shareOfTotal: node.shareOfTotal,
      // Rounded to 1e-4 so exact expectations (share 1 → 2.4) stay exact
      // under float arithmetic — the oracle tests pin these values.
      height: Math.round((0.2 + Math.max(0, Math.min(1, node.shareOfParent)) * 2.2) * 1e4) / 1e4,
      childCount: node.children.length,
    });
    maxHalfWidth = Math.max(maxHalfWidth, Math.abs(x) + SIBLING_GAP / 2);

    if (depth >= maxDepth || node.children.length === 0) return;
    const count = node.children.length;
    const startX = x - ((count - 1) * SIBLING_GAP) / 2;
    node.children.forEach((child, i) => {
      walk(child, depth + 1, startX + i * SIBLING_GAP);
    });
  };

  walk(root, 0, 0);

  return {
    nodes,
    depthCount,
    maxHalfWidth,
    nodeCount: nodes.length,
    rootValue: root.value,
  };
}

/** Straight connector between a parent slab and its child slab (leg + rise). */
export function treeConnector(
  parent: TreeNodeLayout,
  child: TreeNodeLayout,
): { x: number; y: number; length: number; z: number } {
  const length = parent.y - child.y;
  return { x: child.x - parent.x, y: -length / 2, length, z: 0 };
}

/**
 * Heat colour for a node: neutral glass for ordinary shares, rising toward
 * the amber accent as the node dominates its parent. Reuses the same
 * sRGB interpolation contract as lib/scene/heatmap.ts heatColor, but mapped
 * from the app's blue accent (cold) to amber (hot) so a dominant slice reads
 * as "hot" consistently across both AI visuals.
 */
export function nodeHeatColor(share: number): string {
  const cold = { r: 0x3d, g: 0x9b, b: 0xe9 };
  const hot = { r: 0xff, g: 0xb4, b: 0x00 };
  const k = Math.max(0, Math.min(1, share));
  const r = Math.round(cold.r + (hot.r - cold.r) * k);
  const g = Math.round(cold.g + (hot.g - cold.g) * k);
  const b = Math.round(cold.b + (hot.b - cold.b) * k);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * The highlighted drill path as node ids, given the deepest selected node.
 * Pure: walks parent links via the layout ids (depth:label ↔ engine tree).
 */
export function highlightedPathIds(root: TreeNode, selectedId: string | null): string[] {
  if (!selectedId) return [];
  const targetDepth = Number(selectedId.split(":")[0]);
  const targetLabel = selectedId.split(":").slice(1).join(":");
  const path: string[] = [];

  // Depth-first walk: every visited node pushes itself and — on a failed
  // subtree — removes itself again, so an unknown target yields exactly []
  // (fail closed) instead of a dangling partial chain.
  const walk = (node: TreeNode, depth: number): boolean => {
    path.push(`${depth}:${node.label}`);
    if (depth === targetDepth && node.label === targetLabel) return true;
    for (const child of node.children) {
      if (walk(child, depth + 1)) return true;
    }
    path.pop();
    return false;
  };

  walk(root, 0);
  return path;
}

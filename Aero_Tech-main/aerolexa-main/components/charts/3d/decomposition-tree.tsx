"use client";

import { useMemo, useState } from "react";

import { isDarkTheme } from "@/components/ui/theme";
import type { TreeNode } from "@/lib/engine/ai-visuals";
import {
  buildTreeLayout,
  highlightedPathIds,
  nodeHeatColor,
  treeConnector,
  NODE_SIZE,
  type TreeNodeLayout,
} from "@/lib/scene/ai-tree";
import { dataGlass, lightEdge } from "@/lib/scene/materials";

import { ChartCanvas } from "./canvas";
import { ChartLegend } from "./scene";

interface DecompositionTree3DProps {
  /** The engine's computed tree (lib/engine/ai-visuals.ts) — never invented. */
  tree: TreeNode;
  height: number;
  maxDepth?: number;
}

/**
 * Decomposition tree 3D (S5): the AI-visual engine's output stood up as a
 * physical drill path. Slab height encodes share-of-parent, colour heat
 * encodes dominance, and the highlighted path is the selected drill route.
 *
 * Everything the scene shows is computed in lib/scene/ai-tree.ts (pure,
 * oracle-tested) from the engine's TreeNode — the component only renders it.
 * RTL: the whole tree mirrors on the X axis when the document is RTL so the
 * reading order matches the DOM.
 */
export function DecompositionTree3DChart({ tree, height, maxDepth = 3 }: DecompositionTree3DProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const layout = useMemo(() => buildTreeLayout(tree, maxDepth), [tree, maxDepth]);

  const highlighted = useMemo(() => highlightedPathIds(tree, selectedId), [tree, selectedId]);

  // RTL-safe overlay (S10): mirror the layout when the document is RTL.
  const rtl = useMemo(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.getAttribute("dir") === "rtl";
  }, []);

  const legendColor = useMemo(() => nodeHeatColor(0.75), []);
  const theme = isDarkTheme() ? "dark" : "light";

  return (
    <div style={{ width: "100%", height, position: "relative" }}>
      <ChartCanvas
        height={height}
        ariaLabel={`Decomposition tree of ${layout.rootValue} across ${layout.nodeCount} nodes, ${layout.depthCount} levels. Click a node to highlight its drill path.`}
        camera={{ position: [0, 3.2, 9.5], fov: 42 }}
        interact={false}
      >
        <group scale={[rtl ? -1 : 1, 1, 1]}>
          <TreeLevelMeshes
            nodes={layout.nodes}
            selectedId={selectedId}
            highlighted={highlighted}
            onSelect={setSelectedId}
            theme={theme}
          />
        </group>
      </ChartCanvas>
      <ChartLegend items={[{ name: "Dominant slice", color: legendColor }]} id="decomposition-tree-3d" />
    </div>
  );
}

function TreeLevelMeshes({
  nodes,
  selectedId,
  highlighted,
  onSelect,
  theme,
}: {
  nodes: TreeNodeLayout[];
  selectedId: string | null;
  highlighted: string[];
  onSelect: (id: string | null) => void;
  theme: "dark" | "light";
}) {
  const connectors = useMemo(() => {
    const out: { key: string; parent: TreeNodeLayout; child: TreeNodeLayout }[] = [];
    for (const child of nodes) {
      const parentDepth = child.depth - 1;
      // The engine's labels are unique per level; the parent is the node one
      // level up whose subtree spans the child's x. Rather than re-walking the
      // tree, we reuse the x-distance contract: a child always sits directly
      // under its parent's level line, so the connector is drawn to the
      // nearest parent-level node on the same vertical plane (z = 0).
      const candidates = nodes.filter((n) => n.depth === parentDepth);
      let best: TreeNodeLayout | null = null;
      for (const c of candidates) {
        if (!best || Math.abs(c.x - child.x) < Math.abs(best.x - child.x)) best = c;
      }
      if (best) out.push({ key: `${best.id}->${child.id}`, parent: best, child });
    }
    return out;
  }, [nodes]);

  return (
    <group>
      {/* Connectors first so slabs render above them. */}
      {connectors.map(({ key, parent, child }) => {
        const c = treeConnector(parent, child);
        const active = highlighted.includes(parent.id) && highlighted.includes(child.id);
        return (
          <mesh
            key={key}
            position={[parent.x + c.x / 2, parent.y + c.y, 0]}
            rotation={[0, 0, Math.atan2(child.y - parent.y, child.x - parent.x)]}
          >
            <cylinderGeometry args={[0.02, 0.02, c.length, 6]} />
            <meshBasicMaterial color={active ? "#FFB400" : "#3D9BE9"} opacity={active ? 0.8 : 0.25} transparent />
          </mesh>
        );
      })}
      {nodes.map((n) => (
        <TreeNodeSlab
          key={n.id}
          layout={n}
          selected={selectedId === n.id}
          highlighted={highlighted.includes(n.id)}
          onSelect={onSelect}
          theme={theme}
        />
      ))}
    </group>
  );
}

function TreeNodeSlab({
  layout,
  selected,
  highlighted,
  onSelect,
  theme,
}: {
  layout: TreeNodeLayout;
  selected: boolean;
  highlighted: boolean;
  onSelect: (id: string | null) => void;
  theme: "dark" | "light";
}) {
  // Library material (S1 rule): one cached instance per colour, never
  // ad-hoc inline materials.
  const color = nodeHeatColor(layout.shareOfTotal);
  const material = useMemo(() => dataGlass(color, theme, false), [color, theme]);
  const edge = useMemo(() => lightEdge(selected ? "#FFB400" : "#3D9BE9", theme), [selected, theme]);

  const size = Math.max(0.45, NODE_SIZE - layout.depth * 0.12);
  const w = size;
  const d = size;

  return (
    <group position={[layout.x, layout.y + layout.height / 2, layout.z]}>
      {/* Slab: height encodes share of parent (computed, not aesthetic). */}
      <mesh
        material={material}
        castShadow
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected ? null : layout.id);
        }}
      >
        <boxGeometry args={[w, layout.height, d]} />
      </mesh>
      {/* Emissive top cap marks the selected/highlighted drill path. */}
      {(selected || highlighted) && (
        <mesh material={edge} position={[0, layout.height / 2 + 0.06, 0]}>
          <boxGeometry args={[w * 1.05, 0.04, d * 1.05]} />
        </mesh>
      )}
      {/* Base plate keeps deep levels visually grounded. */}
      <mesh position={[0, -layout.height / 2 - 0.02, 0]}>
        <boxGeometry args={[w * 1.15, 0.02, d * 1.15]} />
        <meshStandardMaterial color={theme === "dark" ? "#20262e" : "#e9e8e2"} roughness={0.9} metalness={0} />
      </mesh>
    </group>
  );
}

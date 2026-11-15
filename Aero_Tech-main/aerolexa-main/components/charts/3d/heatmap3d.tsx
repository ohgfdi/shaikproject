"use client";

import { useFrame } from "@react-three/fiber";
import { useId, useMemo } from "react";
import { useRef } from "react";
import * as THREE from "three";

import { SceneEnvironment } from "@/components/scene/scene-environment";
import { isDarkTheme } from "@/components/ui/theme";
import { heatColor, buildHeatmapLayout } from "@/lib/scene/heatmap";
import { dataGlass, lightEdge } from "@/lib/scene/materials";
import type { ChartSpec } from "@/lib/types";

import { ChartCanvas } from "./canvas";
import { ChartLegend } from "./scene";

/**
 * 3D heatmap — the computed values stand up as a bar field: height AND color
 * encode the same number, mirrored from the layout the oracle tests pin.
 * Decorative axis labels stay in DOM (ChartFrame pattern) for a11y.
 */
export function HeatmapChart3D({ spec, height = 320 }: { spec: ChartSpec; height?: number }) {
  const id = useId();
  const layout = useMemo(() => buildHeatmapLayout(spec), [spec]);

  const legend = useMemo(() => {
    const items = (spec.categories ?? []).slice(0, 6).map((label, i) => ({
      name: label,
      color: heatColor(spec.series.length > 1 ? i / Math.max(1, spec.series.length - 1) : i / 6),
    }));
    return items;
  }, [spec]);

  if (layout.cells.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No quantitative cells to chart</p>;
  }

  return (
    <div>
      <div
        className="relative w-full"
        style={{ height }}
        role="img"
        aria-label={`${spec.title}: 3D heatmap of ${layout.cellCount} values ranging ${layout.minValue} to ${layout.maxValue}.`}
      >
        <ChartCanvas height={height} ariaLabel={`${spec.title}: 3D heatmap`} autoRotate>
          <SceneEnvironment theme={isDarkTheme() ? "dark" : "light"} resolution={128} />
          {layout.cells.map((cell, i) => (
            <HeatPrism key={`${id}-${cell.row}-${cell.col}`} cell={cell} index={i} />
          ))}
        </ChartCanvas>
      </div>
      <ChartLegend items={legend} id={id} />
    </div>
  );
}

function HeatPrism({ cell, index }: { cell: { x: number; z: number; t: number; value: number }; index: number }) {
  const ref = useRef<THREE.Mesh>(null);
  // Height range 0.15..4.2 — even the coldest value casts a visible slab.
  const h = 0.15 + cell.t * 4.05;
  const color = heatColor(cell.t);

  const material = useMemo(() => dataGlass(color, isDarkTheme() ? "dark" : "light", false), [color]);

  useFrame((_, delta) => {
    if (!ref.current) return;
    // Staggered grow-in by index; eases to final height (frame-rate independent).
    const delay = (index % 48) * 0.015;
    const target = h;
    const current = ref.current.scale.y * target;
    const k = 1 - Math.exp(-3.5 * (delta + delay * 0.0));
    const next = current + (target - current) * k;
    ref.current.scale.y = Math.max(0.001, next / target);
    ref.current.position.y = next / 2 - 0.01;
  });

  return (
    <mesh ref={ref} position={[cell.x, -0.01, cell.z]} material={material}>
      <boxGeometry args={[0.82, h, 0.82]} />
    </mesh>
  );
}

/**
 * The hot cell of each column gets a bloom-lit edge marker — the "peak"
 * highlight, derived from layout.colMaxima (computed), not aesthetics.
 */
export function PeakMarkers({ layout }: { layout: ReturnType<typeof buildHeatmapLayout> }) {
  const theme = isDarkTheme() ? "dark" : "light";
  const edge = useMemo(() => lightEdge("#FFB400", theme), [theme]);
  return (
    <group>
      {layout.colMaxima.map((max, c) => {
        const cell = layout.cells.find((k) => k.col === c && k.value === max);
        if (!cell) return null;
        const h = 0.15 + cell.t * 4.05;
        return (
          <mesh key={`peak-${c}`} position={[cell.x, h + 0.12, cell.z]} material={edge}>
            <sphereGeometry args={[0.09, 12, 8]} />
          </mesh>
        );
      })}
    </group>
  );
}

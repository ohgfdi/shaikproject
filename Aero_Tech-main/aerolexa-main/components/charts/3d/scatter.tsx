"use client";

import { useFrame } from "@react-three/fiber";
import { useId, useMemo } from "react";
import { useEffect } from "react";
import { useRef } from "react";
import * as THREE from "three";

import { isDarkTheme } from "@/components/ui/theme";
import { dataGlass } from "@/lib/scene/materials";
import type { ChartSpec } from "@/lib/types";

import { MAX_BAR, PLOT_HALF, seriesColor } from "./math";
import { ChartFrame, ChartLegend } from "./scene";

/**
 * One InstancedMesh per series group: N points, 1 draw call. Point counts
 * scale with the data — instancing is what keeps hundreds of markers inside
 * the draw-call budget on every tier.
 */
function InstancedPoints({ positions, color }: { positions: [number, number, number][]; color: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const progress = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = positions.length;

  const material = useMemo(() => dataGlass(color, isDarkTheme() ? "dark" : "light", false), [color]);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.24, 16, 12), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, delta) => {
    if (!ref.current) return;
    progress.current = Math.min(1, progress.current + delta * 2);
    const s = Math.max(0.001, progress.current);
    for (let i = 0; i < count; i++) {
      const p = positions[i];
      if (!p) continue;
      dummy.position.set(p[0], p[1], p[2]);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) return null;
  return <instancedMesh ref={ref} args={[geometry, material, count]} />;
}

/** 3D scatter — points float in plot space, grouped by cluster when labels exist. */
export function ScatterChart3D({ spec, height }: { spec: ChartSpec; height: number }) {
  const id = useId();
  const model = useMemo(() => buildScatter(spec), [spec]);

  return (
    <div>
      <ChartFrame
        height={height}
        id={id}
        ariaLabel={`${spec.title}: ${model.points.length} points across ${model.groups.length} clusters.`}
        maxValue={model.maxY}
        categories={[]}
      >
        {model.groups.map((g, gi) => (
          <InstancedPoints key={`${id}-g${gi}`} positions={g.points.map((p) => [p.x, p.y, 0])} color={g.color} />
        ))}
      </ChartFrame>
      <ChartLegend items={model.groups.map((g) => ({ name: g.name, color: g.color }))} id={id} />
    </div>
  );
}

interface Point3 {
  x: number;
  y: number;
}
interface ScatterModel {
  groups: { name: string; color: string; points: Point3[] }[];
  points: Point3[];
  maxY: number;
}

function buildScatter(spec: ChartSpec): ScatterModel {
  const grouped = new Map<string, Point3[]>();
  for (const s of spec.series) {
    for (const p of s.points ?? []) {
      const name = p.label ?? s.name;
      const list = grouped.get(name) ?? [];
      list.push({ x: p.x, y: p.y });
      grouped.set(name, list);
    }
  }
  const names = [...grouped.keys()];
  if (names.length === 0) return { groups: [], points: [], maxY: 1 };

  const all = names.flatMap((n) => grouped.get(n) ?? []);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const groups = names.map((name, i) => ({
    name,
    color: seriesColor(i),
    points: (grouped.get(name) ?? []).map((p) => ({
      x: -PLOT_HALF + ((p.x - xMin) / xSpan) * PLOT_HALF * 2,
      y: ((p.y - yMin) / ySpan) * MAX_BAR * 0.92 + 1.4,
    })),
  }));

  return { groups, points: all, maxY: Number(yMax.toPrecision(3)) };
}

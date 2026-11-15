"use client";

import { useFrame } from "@react-three/fiber";
import { useId, useMemo, useRef } from "react";
import type { Mesh } from "three";
import * as THREE from "three";

import { SceneEnvironment } from "@/components/scene/scene-environment";
import { isDarkTheme } from "@/components/ui/theme";
import { dataGlass } from "@/lib/scene/materials";
import type { ChartSpec } from "@/lib/types";

import { ChartCanvas } from "./canvas";
import { seriesColor } from "./math";
import { ChartLegend } from "./scene";

export function DonutChart3D({ spec, height }: { spec: ChartSpec; height: number }) {
  const id = useId();
  const model = useMemo(() => buildDonut(spec), [spec]);

  if (model.slices.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No data to chart</p>;
  }

  return (
    <div>
      <div className="relative w-full" style={{ height }} role="img" aria-label={`${spec.title}: ${model.summary}`}>
        <ChartCanvas height={height} ariaLabel={`${spec.title}: ${model.summary}`} autoRotate>
          <SceneEnvironment theme={isDarkTheme() ? "dark" : "light"} resolution={128} />
          {model.slices.map((slice, i) => (
            <DonutSlice key={`${id}-${i}`} slice={slice} delay={i * 0.08} />
          ))}
        </ChartCanvas>
      </div>
      <ChartLegend items={model.slices.map((s) => ({ name: s.label, color: s.color }))} id={id} />
    </div>
  );
}

interface DonutSliceData {
  color: string;
  label: string;
  start: number;
  end: number;
  value: number;
  pct: number;
}

const OUTER_R = 5.6;
const INNER_R = 2.8;
const THICKNESS = 1.1;

const sliceGeometries = new Map<string, THREE.BufferGeometry>();

function getSliceGeometry(start: number, end: number): THREE.BufferGeometry {
  const t = end - start;
  const key = `${Math.round(t * 4096)}-${Math.round(start * 4096)}`;
  const cached = sliceGeometries.get(key);
  if (cached) return cached;

  const shape = new THREE.Shape();
  const steps = Math.max(12, Math.ceil((t / (Math.PI * 2)) * 64));
  const outer: THREE.Vector2[] = [];
  const inner: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (t * i) / steps;
    outer.push(new THREE.Vector2(Math.cos(a) * OUTER_R, Math.sin(a) * OUTER_R));
    inner.push(new THREE.Vector2(Math.cos(a) * INNER_R, Math.sin(a) * INNER_R));
  }
  shape.moveTo(outer[0]?.x ?? 0, outer[0]?.y ?? 0);
  for (const v of outer.slice(1)) shape.lineTo(v.x, v.y);
  for (const v of inner.slice(1).reverse()) shape.lineTo(v.x, v.y);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: THICKNESS,
    bevelEnabled: true,
    bevelThickness: THICKNESS * 0.22,
    bevelSize: THICKNESS * 0.16,
    bevelSegments: 2,
    steps: 1,
  });
  geometryCacheStore(key, geo);
  return geo;
}

function geometryCacheStore(key: string, geo: THREE.BufferGeometry) {
  sliceGeometries.set(key, geo);
}

function DonutSlice({ slice, delay }: { slice: DonutSliceData; delay: number }) {
  const ref = useRef<Mesh>(null);
  const progress = useRef(-delay);
  const geo = useMemo(() => getSliceGeometry(slice.start, slice.end), [slice.start, slice.end]);
  // Library glass: cached per color, env-lit, shared with every other chart.
  const material = useMemo(() => dataGlass(slice.color, isDarkTheme() ? "dark" : "light", false), [slice.color]);

  useFrame((_, delta) => {
    progress.current = Math.min(1, progress.current + delta * 1.2);
    const eased = Math.max(0.001, progress.current);
    if (ref.current) {
      const s = 0.4 + 0.6 * eased;
      ref.current.scale.setScalar(s);
      ref.current.position.y = (THICKNESS / 2 + 0.12) * s;
    }
  });

  return (
    <mesh
      ref={ref}
      geometry={geo}
      material={material}
      position={[0, THICKNESS / 2 + 0.12, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      castShadow
    />
  );
}

interface DonutModel {
  slices: DonutSliceData[];
  summary: string;
}

function buildDonut(spec: ChartSpec): DonutModel {
  const labels = spec.categories ?? spec.series.map((s) => s.name);
  const slices: DonutSliceData[] = [];
  let total = 0;
  spec.series.forEach((s) => {
    const v = s.data?.[0] ?? 0;
    if (v > 0) total += v;
  });
  if (total <= 0) return { slices, summary: "no positive values" };

  let acc = 0;
  spec.series.forEach((s, i) => {
    const v = s.data?.[0] ?? 0;
    if (v <= 0) return;
    const start = (acc / total) * Math.PI * 2;
    acc += v;
    const end = (acc / total) * Math.PI * 2;
    slices.push({
      color: seriesColor(i, s.color),
      label: `${labels[i] ?? s.name} · ${Math.round((v / total) * 100)}%`,
      start,
      end,
      value: v,
      pct: Math.round((v / total) * 100),
    });
  });

  return {
    slices,
    summary: slices.map((s) => `${s.pct}% ${s.label.split(" · ")[0]}`).join(", "),
  };
}

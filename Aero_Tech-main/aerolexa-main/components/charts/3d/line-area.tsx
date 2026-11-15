"use client";

import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useId } from "react";
import type { BufferGeometry } from "three";
import * as THREE from "three";

import type { ChartSpec } from "@/lib/types";

import { MAX_BAR, categoryCenters, downsample, seriesColor } from "./math";
import { ChartFrame, ChartLegend } from "./scene";

/** Animated area ribbon that fades in. */
function AreaRibbon({ points, color, yScale }: { points: [number, number][]; color: string; yScale: number }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const progress = useRef(0);
  const geo = useMemo(() => buildAreaGeometry(points, yScale), [points, yScale]);

  useFrame((_, delta) => {
    progress.current = Math.min(1, progress.current + delta * 0.8);
    if (mat.current) mat.current.opacity = progress.current * 0.3;
  });

  return (
    <mesh position={[0, 0, -0.15]} geometry={geo}>
      <meshBasicMaterial ref={mat} color={color} transparent opacity={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

function buildAreaGeometry(points: [number, number][], yScale: number): BufferGeometry {
  const n = points.length;
  if (n < 2) return new THREE.BufferGeometry();
  // Top vertices (0..n-1), bottom vertices (n..2n-1)
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i] ?? [0, 0];
    // Top
    positions[i * 3] = x;
    positions[i * 3 + 1] = y * yScale;
    positions[i * 3 + 2] = 0;
    // Bottom
    positions[(i + n) * 3] = x;
    positions[(i + n) * 3 + 1] = 0;
    positions[(i + n) * 3 + 2] = 0;
  }
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function LineAreaChart3D({ spec, height }: { spec: ChartSpec; height: number }) {
  const id = useId();
  const model = useMemo(() => buildLineArea(spec), [spec]);
  const { cats, series, maxVal } = model;
  const layout = useMemo(() => {
    const { centers } = categoryCenters(cats.length);
    const yScale = MAX_BAR / maxVal;
    return {
      centers,
      yScale,
      areaPoints: series.map((s) => centers.map((cx, i) => [cx, s.heights[i] ?? 0] as [number, number])),
      linePoints: series.map((s) =>
        centers.map((cx, i) => [cx, (s.heights[i] ?? 0) * yScale, 0] as [number, number, number]),
      ),
    };
  }, [cats, series, maxVal]);

  return (
    <div>
      <ChartFrame
        height={height}
        id={id}
        ariaLabel={`${spec.title}: ${cats.length} points, series ${series.length}.`}
        maxValue={maxVal}
        unit={spec.unit}
        categories={cats}
      >
        {series.map((s, si) => {
          const color = s.color;
          const isForecast = s.name === "Forecast";
          return (
            <group key={`${id}-${si}`}>
              {spec.kind === "area" && (
                <AreaRibbon points={layout.areaPoints[si] ?? []} color={color} yScale={layout.yScale} />
              )}
              <Line
                points={layout.linePoints[si] ?? []}
                lineWidth={isForecast ? 2.2 : 3}
                color={color}
                dashed={isForecast}
                dashScale={1}
                dashSize={0.5}
              />
            </group>
          );
        })}
      </ChartFrame>
      <ChartLegend items={series.map((s) => ({ name: s.name, color: s.color }))} id={id} />
    </div>
  );
}

interface LineModel {
  cats: string[];
  series: { name: string; color: string; heights: number[] }[];
  maxVal: number;
}

function buildLineArea(spec: ChartSpec): LineModel {
  const cats = downsample(spec.categories ?? [], 90);
  const maxVal = Math.max(
    1,
    ...spec.series.flatMap((s) =>
      downsample(
        (s.data ?? []).filter((v): v is number => v !== null && v !== undefined),
        90,
      ),
    ),
  );
  return {
    cats,
    series: spec.series.map((s, si) => ({
      name: s.name,
      color: seriesColor(si, s.color),
      heights: downsample(
        (s.data ?? []).map((v) => (v === null || v === undefined ? 0 : v)),
        90,
      ),
    })),
    maxVal,
  };
}

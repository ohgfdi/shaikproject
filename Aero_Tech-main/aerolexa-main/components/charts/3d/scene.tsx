"use client";

import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import { SceneEnvironment } from "@/components/scene/scene-environment";
import { isDarkTheme } from "@/components/ui/theme";
import { dataGlass } from "@/lib/scene/materials";

import { ChartCanvas } from "./canvas";
import { niceTicks, type NiceNumber } from "./math";

/* ---------------------------------------------------------------------------
   Animated transforms
--------------------------------------------------------------------------- */

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

interface GrowingBarProps {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  color: string;
  delay?: number;
  /** Ground offset for stacked segments; the segment grows up from here. */
  yBase?: number;
}

/** A rounded, ground-sticking bar that springs up from the grid on mount. */
export function GrowingBar({ x, z, width, depth, height, color, delay = 0, yBase = 0 }: GrowingBarProps) {
  const group = useRef<THREE.Group>(null);
  const barRef = useRef<THREE.Mesh>(null);
  const progress = useRef(-(delay ?? 0));

  // Library material: one shared instance per color across every chart bar in
  // the app — cached, theme-aware, env-lit. Charts run on all WebGL tiers, so
  // they use the non-transmission glass (transmission is studio-only).
  const material = useMemo(() => dataGlass(color, isDarkTheme() ? "dark" : "light", false), [color]);

  useFrame((_, delta) => {
    progress.current = Math.min(1, progress.current + delta * 1.5);
    const eased = Math.max(0.001, easeOutBack(Math.max(0, progress.current)));
    if (group.current) group.current.scale.setScalar(progress.current < 0.01 ? 0.001 : 1);
    if (barRef.current) {
      barRef.current.scale.y = eased;
      barRef.current.position.y = yBase + (height * eased) / 2;
    }
  });

  return (
    <group ref={group} position={[x, 0, z]}>
      <RoundedBox
        ref={barRef}
        args={[width, height, depth]}
        radius={Math.min(width, depth) * 0.18}
        smoothness={3}
        material={material}
      />
    </group>
  );
}

/** A marker sphere that pops in, used on line/scatter points. */
export function GrowingPoint({
  position,
  color,
  radius = 0.28,
}: {
  position: [number, number, number];
  color: string;
  radius?: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const progress = useRef(0);
  useFrame((_, delta) => {
    progress.current = Math.min(1, progress.current + delta * 2);
    if (ref.current) {
      ref.current.scale.setScalar(Math.max(0.001, progress.current));
    }
  });
  const material = useMemo(() => dataGlass(color, isDarkTheme() ? "dark" : "light", false), [color]);
  return (
    <mesh ref={ref} position={position} material={material}>
      <sphereGeometry args={[radius, 24, 16]} />
    </mesh>
  );
}

/* ---------------------------------------------------------------------------
   HTML axis rails (kept outside the canvas for crisp text + a11y)
--------------------------------------------------------------------------- */

/** Left-hand value rail, aligned to the same ticks the scene is scaled to. */
export function ValueRail({ maxValue, unit }: { maxValue: number; unit?: string }) {
  const ticks: NiceNumber[] = niceTicks(maxValue);
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -left-1 top-0 flex h-full flex-col justify-between text-right"
    >
      {ticks.map((t) => (
        <span
          key={t.label}
          className="translate-x-0 text-[10px] font-medium tabular-nums text-muted/70"
          style={{ lineHeight: 1 }}
        >
          {t.label}
          {unit ? ` ${unit}` : ""}
        </span>
      ))}
    </div>
  );
}

/** Bottom category rail. Dense categories are stepped so labels stay legible. */
export function CategoryRail({ labels, id }: { labels: string[]; id: string }) {
  if (labels.length === 0) return null;
  const step = Math.ceil(labels.length / 18);
  return (
    <div className="mt-1 grid w-full gap-1" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0,1fr))` }}>
      {labels.map((label, i) => {
        const show = i % step === 0 || i === labels.length - 1;
        return (
          <span
            key={`${id}-${i}`}
            className="h-4 truncate text-center text-[10px] font-medium text-muted/80"
            title={label}
          >
            {show ? label : ""}
          </span>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Shared frame: value rail + canvas + category rail + legend
--------------------------------------------------------------------------- */

export function ChartFrame({
  height,
  ariaLabel,
  children,
  maxValue,
  unit,
  categories,
  id,
}: {
  height: number;
  ariaLabel: string;
  children: React.ReactNode;
  maxValue: number;
  unit?: string;
  categories: string[];
  id: string;
}) {
  return (
    <div className="relative w-full">
      <ValueRail maxValue={maxValue} unit={unit} />
      <div className="pl-9">
        <ChartCanvas height={height} ariaLabel={ariaLabel}>
          <SceneEnvironment theme={isDarkTheme() ? "dark" : "light"} resolution={128} />
          {children}
        </ChartCanvas>
        <CategoryRail labels={categories} id={id} />
      </div>
    </div>
  );
}

export function ChartLegend({ items, id }: { items: { name: string; color: string }[]; id: string }) {
  if (items.length === 0) return null;
  if (items.every((it) => it.name === items[0]?.name)) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1" aria-hidden>
      {items.map((it, i) => (
        <span key={`${id}-${i}`} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
          <span className="size-2.5 rounded-sm" style={{ backgroundColor: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

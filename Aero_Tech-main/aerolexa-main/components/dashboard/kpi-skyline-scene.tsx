"use client";

import { Float } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { SceneCanvas } from "@/components/scene/scene-canvas";
import { CHART_PALETTE, isDarkTheme } from "@/components/ui/theme";
import { dataGlass } from "@/lib/scene/materials";
import type { SceneCapability } from "@/lib/scene/tier";

import type { KpiSlab } from "./kpi-slabs";

/* ---------------------------------------------------------------------------
   Real-data skyline — one shared canvas behind the whole KPI row whose bar
   heights ARE the KPI values. No invented series: the number on the slab and
   its bar are the same figure, so the 3D is just another honest view of the
   data.

   Split out of kpi-slabs.tsx because it is the only part that needs a GPU.
   The slabs themselves are DOM and carry the numbers, so they must never wait
   on three.js to render — the scene loads behind a dynamic boundary and
   mirrors the DOM row that is already on screen.
--------------------------------------------------------------------------- */

function KpiSkyline({ slabs, cap }: { slabs: KpiSlab[]; cap: SceneCapability }) {
  const group = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!group.current) return;
    group.current.rotation.y = 0.22;
  }, []);

  const bars = useMemo(() => {
    const max = Math.max(1, ...slabs.map((s) => s.value));
    return slabs.map((s, i) => {
      const ratio = Math.max(0.06, s.value / max);
      return {
        x: (i - (slabs.length - 1) / 2) * 2.4,
        height: ratio * 5,
        color: CHART_PALETTE[i % CHART_PALETTE.length] ?? "#5AA8AA",
        label: s.label,
      };
    });
  }, [slabs]);

  if (cap.tier === "depth") {
    return (
      <group rotation={[0, 0.22, 0]}>
        {bars.map((b) => (
          <Bar key={b.label} bar={b} />
        ))}
      </group>
    );
  }

  return (
    <group ref={group} rotation={[0, 0.22, 0]}>
      {bars.map((b) => (
        <Float key={b.label} speed={1.4} rotationIntensity={0.12} floatIntensity={0.7}>
          <Bar bar={b} />
        </Float>
      ))}
    </group>
  );
}

function Bar({ bar }: { bar: { x: number; height: number; color: string } }) {
  const ref = useRef<THREE.Mesh>(null);
  const displayed = useRef(0);
  // Library glass, cached per color — the KPI bar and every chart bar of the
  // same color share one material instance app-wide.
  const material = useMemo(() => dataGlass(bar.color, isDarkTheme() ? "dark" : "light", false), [bar.color]);
  useFrame((_, delta) => {
    if (!ref.current) return;
    // Ease toward the *current* computed height: the mount grows from zero,
    // and any later data change glides the bar to its new value — the 3D is
    // always catching up to the number, never the other way round.
    const k = 1 - Math.exp(-4 * delta);
    const next = displayed.current + (bar.height - displayed.current) * k;
    displayed.current = next;
    ref.current.scale.y = Math.max(0.001, next / Math.max(0.001, bar.height));
    ref.current.position.y = next / 2 - 0.01;
  });
  return (
    <mesh ref={ref} position={[bar.x, -0.01, 0]} material={material} castShadow>
      <boxGeometry args={[1.05, bar.height, 1.05]} />
    </mesh>
  );
}

/**
 * The shared canvas. Tier-honest: the caller only mounts this after it has
 * measured a non-flat tier, so this module is never even requested on a device
 * that cannot use it.
 */
export function KpiSkylineScene({ slabs, cap }: { slabs: KpiSlab[]; cap: SceneCapability }) {
  return (
    <SceneCanvas
      capability={{ ...cap, tier: cap.tier }}
      camera={{ position: [0, 3.4, 9.5], fov: 40 }}
      effects={false}
      className="absolute inset-0"
    >
      <KpiSkyline slabs={slabs} cap={cap} />
    </SceneCanvas>
  );
}

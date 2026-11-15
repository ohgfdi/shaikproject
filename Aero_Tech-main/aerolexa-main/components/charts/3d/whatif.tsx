"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import { isDarkTheme } from "@/components/ui/theme";
import { dataGlass } from "@/lib/scene/materials";
import { buildWhatIfLayout, deltaColor, type WhatIfSceneLayout } from "@/lib/scene/whatif-scene";
import type { WhatIfResult } from "@/lib/types";

import { ChartCanvas } from "./canvas";

/**
 * What-if 3D (S5c — the what-if / studio crossover): the engine's before →
 * after projection stood up as two slabs joined by a delta arrow. Heights
 * encode the computed beforeValue/afterValue against a shared max; the arrow
 * span is the computed delta; the fallback (hypothetical) result renders with
 * the honest warning tint instead of the confident one.
 *
 * All numbers are computed in lib/scene/whatif-scene.ts (pure, oracle-tested);
 * the component only renders them. The authoritative numbers stay in DOM
 * beside the scene (WhatIfPanel's result cards) — the 3D only mirrors them.
 */
export function WhatIfScene3D({ result, height = 260 }: { result: WhatIfResult; height?: number }) {
  const layout = useMemo(() => buildWhatIfLayout(result), [result]);
  const theme = isDarkTheme() ? "dark" : "light";

  // RTL-safe overlay (S10): mirror the before→after pair on X when the
  // document is RTL so the reading order matches the DOM (same contract as
  // decomposition-tree.tsx and key-influencers.tsx). The delta arrow lives
  // inside the mirrored group, so it flips with the slabs.
  const rtl = useMemo(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.getAttribute("dir") === "rtl";
  }, []);

  const aria = `What-if simulation: ${layout.pctChange > 0 ? "+" : ""}${layout.pctChange}% on ${layout.driverColumn} moves ${layout.outcomeColumn} from ${layout.before.value} to ${layout.after.value} (delta ${layout.delta >= 0 ? "+" : ""}${layout.delta.toFixed(2)})${layout.fallback ? " — hypothetical fallback, not causal" : ""}.`;

  return (
    <div style={{ width: "100%", height, position: "relative" }} role="img" aria-label={aria}>
      <ChartCanvas
        height={height}
        ariaLabel={aria}
        camera={{ position: [0, 2.4, 7], fov: 40 }}
        interact={false}
        autoRotate={false}
      >
        <group position={[0, -0.6, 0]} scale={[rtl ? -1 : 1, 1, 1]}>
          <ResultSlab
            x={layout.before.x}
            height={layout.before.height}
            color={theme === "dark" ? "#5AA8AA" : "#3D9BE9"}
            theme={theme}
            dim={false}
          />
          <ResultSlab
            x={layout.after.x}
            height={layout.after.height}
            color={deltaColor(layout.delta)}
            theme={theme}
            dim={layout.fallback}
          />
          <DeltaArrow layout={layout} theme={theme} />
        </group>
      </ChartCanvas>
      {layout.fallback && (
        <p className="mt-1 text-center text-caption text-muted">
          Hypothetical projection — the fitted relationship is too weak (r² = {layout.rSquared.toFixed(3)}) to trust the
          magnitude.
        </p>
      )}
    </div>
  );
}

function ResultSlab({
  x,
  height,
  color,
  theme,
  dim,
}: {
  x: number;
  height: number;
  color: string;
  theme: "dark" | "light";
  dim: boolean;
}) {
  const material = useMemo(() => dataGlass(color, theme, false), [color, theme]);
  const meshRef = useRef<THREE.Mesh>(null);
  // L4 value-change animation: the slab eases to its new height when the
  // what-if result changes (a new driver value was simulated), so the
  // before→after story stays legible as the numbers move. Reduced-motion
  // users get the exact final height on every frame instead.
  const reducedMotion = useMemo(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const target = Math.max(0.001, height);
    if (reducedMotion) {
      mesh.scale.y = 1;
      return;
    }
    const k = 1 - Math.exp(-3.5 * delta);
    const current = mesh.scale.y * target;
    const next = current + (target - current) * k;
    mesh.scale.y = Math.max(0.001, next / target);
  });

  return (
    <group position={[x, height / 2, 0]}>
      <mesh ref={meshRef} material={material} castShadow receiveShadow>
        <boxGeometry args={[1.1, height, 1.1]} />
      </mesh>
      <mesh position={[0, height / 2 + 0.04, 0]}>
        <boxGeometry args={[1.2, 0.03, 1.2]} />
        <meshStandardMaterial
          color={dim ? "#8a8a92" : theme === "dark" ? "#20262e" : "#e9e8e2"}
          roughness={0.9}
          metalness={0}
        />
      </mesh>
    </group>
  );
}

function DeltaArrow({ layout, theme }: { layout: WhatIfSceneLayout; theme: "dark" | "light" }) {
  const y = Math.max(layout.before.height, layout.after.height) + 0.45;
  const rise = layout.after.height - layout.before.height;
  const angle = Math.atan2(rise, layout.after.x - layout.before.x);
  const span = Math.hypot(layout.after.x - layout.before.x, rise);

  return (
    <group position={[0, y, 0]}>
      <mesh rotation={[0, 0, angle]} position={[layout.before.x + (layout.after.x - layout.before.x) / 2, rise / 2, 0]}>
        <cylinderGeometry args={[0.035, 0.035, span, 8]} />
        <meshBasicMaterial color={deltaColor(layout.delta)} />
      </mesh>
      {/* Arrowhead on the after side. */}
      <mesh position={[layout.after.x - 0.18, rise - Math.tan(angle) * 0.18, 0]} rotation={[0, 0, angle]}>
        <coneGeometry args={[0.12, 0.3, 12]} />
        <meshBasicMaterial color={deltaColor(layout.delta)} />
      </mesh>
      <mesh visible={theme === "dark"} />
    </group>
  );
}

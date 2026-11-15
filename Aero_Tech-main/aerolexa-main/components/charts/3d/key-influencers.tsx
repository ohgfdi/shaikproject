"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import { isDarkTheme } from "@/components/ui/theme";
import type { KeyInfluencersResult } from "@/lib/engine/ai-visuals";
import {
  buildInfluencersLayout,
  RAISES_COLOR,
  LOWERS_COLOR,
  type InfluencerBarLayout,
} from "@/lib/scene/ai-influencers";
import { dataGlass, lightEdge } from "@/lib/scene/materials";

import { ChartCanvas } from "./canvas";
import { ChartLegend } from "./scene";

interface KeyInfluencers3DProps {
  /** The engine's computed result (lib/engine/ai-visuals.ts) — never invented. */
  result: KeyInfluencersResult;
  height: number;
  maxInfluencers?: number;
}

/**
 * Key influencers 3D (S5): the analysis engine's output as a bar row over a
 * base-rate reference plane. Bar height encodes |lift − 1| relative to the
 * strongest influencer; colour encodes direction (teal raises the outcome
 * likelihood, rose lowers it); the plane label carries the engine's own
 * base rate. All numbers are computed in lib/scene/ai-influencers.ts (pure,
 * oracle-tested); the component only renders them.
 *
 * RTL: the bar row mirrors on X when the document is RTL (S10).
 */
export function KeyInfluencers3DChart({ result, height, maxInfluencers = 8 }: KeyInfluencers3DProps) {
  const layout = useMemo(() => buildInfluencersLayout(result, maxInfluencers), [result, maxInfluencers]);

  const rtl = useMemo(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.getAttribute("dir") === "rtl";
  }, []);

  const theme = isDarkTheme() ? "dark" : "light";

  if (layout.bars.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        No group had enough rows to estimate a lift — lower the minimum or pick a different outcome column.
      </p>
    );
  }

  return (
    <div style={{ width: "100%", height, position: "relative" }}>
      <ChartCanvas
        height={height}
        ariaLabel={`Key influencers of the outcome: ${layout.bars.length} bars, base rate ${(layout.baseRate * 100).toFixed(1)}% across ${layout.totalRows} rows. Teal raises the likelihood, rose lowers it.`}
        camera={{ position: [0, 2.6, 7.5], fov: 42 }}
        interact={false}
      >
        <group scale={[rtl ? -1 : 1, 1, 1]}>
          <BaseRatePlane height={layout.baseRateHeight} baseRate={layout.baseRate} theme={theme} />
          {layout.bars.map((bar) => (
            <InfluencerBarMesh key={`${bar.influencer.category}:${bar.influencer.value}`} bar={bar} theme={theme} />
          ))}
        </group>
      </ChartCanvas>
      <ChartLegend
        items={[
          { name: "Raises likelihood", color: RAISES_COLOR },
          { name: "Lowers likelihood", color: LOWERS_COLOR },
        ]}
        id="key-influencers-3d"
      />
    </div>
  );
}

function BaseRatePlane({ height, baseRate, theme }: { height: number; baseRate: number; theme: "dark" | "light" }) {
  return (
    <group position={[0, height, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[11, 3.4]} />
        <meshStandardMaterial
          color={theme === "dark" ? "#16202a" : "#f0f0f0"}
          opacity={0.18}
          transparent
          depthWrite={false}
        />
      </mesh>
      {/* The real number lives in the DOM below the canvas (data-truth); the
          in-scene text is aria-hidden decoration, so the value is never
          trapped in a canvas. */}
      <mesh position={[0, 0.01, -1.9]}>
        <boxGeometry args={[11, 0.015, 0.05]} />
        <meshBasicMaterial color="#8a8a92" />
      </mesh>
      <group aria-hidden />
      <mesh name={`base-rate-${(baseRate * 100).toFixed(1)}`} visible={false}>
        <boxGeometry args={[0.01, 0.01, 0.01]} />
      </mesh>
    </group>
  );
}

function InfluencerBarMesh({ bar, theme }: { bar: InfluencerBarLayout; theme: "dark" | "light" }) {
  const material = useMemo(() => dataGlass(bar.color, theme, false), [bar.color, theme]);
  const edge = useMemo(() => lightEdge(bar.color, theme), [bar.color, theme]);
  const meshRef = useRef<THREE.Mesh>(null);
  const edgeRef = useRef<THREE.Mesh>(null);
  // L4 value-change animation: bars ease to their new height when the
  // engine's result changes (new filter context, different outcome column),
  // so the transition between two COMPUTED states is visible instead of a
  // snap. Reduced-motion users skip the animation entirely (the height is
  // always correct on the first frame).
  const reducedMotion = useMemo(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const target = Math.max(0.001, bar.height);
    if (reducedMotion) {
      mesh.scale.y = 1;
      mesh.position.y = target / 2;
      return;
    }
    // Frame-rate-independent ease toward the target height.
    const k = 1 - Math.exp(-3.5 * delta);
    const current = mesh.scale.y * target;
    const next = current + (target - current) * k;
    mesh.scale.y = Math.max(0.001, next / target);
    mesh.position.y = next / 2;
    if (edgeRef.current) edgeRef.current.position.y = next + 0.05;
  });

  return (
    <group position={[bar.x, 0, 0]}>
      <mesh ref={meshRef} material={material} position={[0, bar.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.72, bar.height, 0.72]} />
      </mesh>
      {/* Direction rim: the strongest influencers get the emissive edge. */}
      <mesh ref={edgeRef} material={edge} position={[0, bar.height + 0.05, 0]}>
        <boxGeometry args={[0.76, 0.035, 0.76]} />
      </mesh>
    </group>
  );
}

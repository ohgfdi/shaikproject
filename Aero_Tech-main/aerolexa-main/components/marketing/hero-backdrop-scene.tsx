"use client";

import { Float, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { SceneCanvas } from "@/components/scene/scene-canvas";
import { CHART_PALETTE, isDarkTheme } from "@/components/ui/theme";
import { whenIdle } from "@/lib/scene/defer";
import { brushedMetal } from "@/lib/scene/materials";
import { sceneTier, type SceneCapability } from "@/lib/scene/tier";

/* ---------------------------------------------------------------------------
   Hero backdrop — a stylized "data skyline" hovering over a data grid, with a
   local image-based environment so bare materials read as lit glass. Bloom +
   fog come from the shared scene rig on tiers that support them.

   This is the whole WebGL half of the hero, and it lives in its own module on
   purpose: the hero preview beside it is plain DOM and should paint with the
   first frame, while this pulls three, fiber and drei (~660 kB raw). Keeping
   them in one file meant the landing route's first load carried the renderer
   just to render a div. The split lets components/scene/lazy-scenes.tsx put
   this module behind a dynamic boundary, so / ships the hero chrome first and
   fetches the scene afterwards.
--------------------------------------------------------------------------- */

interface Bar {
  x: number;
  z: number;
  height: number;
  width: number;
  color: string;
  rotation: number;
}

/**
 * Deterministic PRNG (a 16807 LCG), shared by every generator in this file.
 * Math.random() would make every load a new scene and every screenshot diff a
 * false alarm — and the per-tier screenshot specs treat a stable render as part
 * of the contract, not a nicety. One sequence, seeded once per caller so the
 * skyline and the orbits cannot drift into each other.
 */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function buildBars(count: number): Bar[] {
  // The same skyline renders pixel-identically twice, which the per-tier
  // screenshot specs rely on.
  const rand = prng(42);
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 10);
    const col = i % 10;
    bars.push({
      x: (col - 4.5) * 1.7 + (rand() - 0.5) * 0.8,
      z: -9 + row * 2.6 + (rand() - 0.5) * 0.9,
      height: 1.6 + rand() * 7.5,
      width: 0.55 + rand() * 0.55,
      color: CHART_PALETTE[i % CHART_PALETTE.length] ?? "#5AA8AA",
      rotation: (rand() - 0.5) * 0.24,
    });
  }
  return bars;
}

function DataSkyline({ bars }: { bars: Bar[] }) {
  const ref = useRef<THREE.Group>(null);
  // Library metal: cached per color, env-lit, shared with every scene in the
  // app. One material instance per color — hundreds of towers, few materials.
  const materials = useMemo(() => bars.map((b) => brushedMetal(b.color, isDarkTheme() ? "dark" : "light")), [bars]);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.rotation.y = Math.sin(t * 0.06) * 0.18 + state.pointer.x * 0.06;
    ref.current.position.y = Math.sin(t * 0.4) * 0.25 + state.pointer.y * 0.15;
    ref.current.rotation.x = state.pointer.y * 0.03;
  });
  return (
    <group ref={ref} position={[0, 0, 0]}>
      {bars.map((bar, i) => (
        <mesh
          key={i}
          position={[bar.x, bar.height / 2, bar.z]}
          rotation={[0, bar.rotation, 0]}
          material={materials[i]}
          castShadow
        >
          <boxGeometry args={[bar.width, bar.height, bar.width * 1.5]} />
        </mesh>
      ))}
    </group>
  );
}

function OrbitingSpheres() {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (group.current) group.current.rotation.y = state.clock.elapsedTime * 0.12 + state.pointer.x * 0.2;
  });
  // Seeded, not random: the orbit radii are part of the composition, and a
  // different composition per page load would make every hero screenshot a
  // false positive.
  const orbs = useMemo(() => {
    const rand = prng(1337);
    return Array.from({ length: 5 }, (_, i) => ({
      color: CHART_PALETTE[(i + 2) % CHART_PALETTE.length] ?? "#5AA8AA",
      r: 0.45 + rand() * 0.7,
      a: (i / 5) * Math.PI * 2,
      rad: 13 + rand() * 3,
    }));
  }, []);
  return (
    <group ref={group} position={[0, 6, 0]}>
      {orbs.map((o, i) => (
        <Float key={i} speed={2} rotationIntensity={0.6} floatIntensity={1.2}>
          <mesh position={[Math.cos(o.a) * o.rad, (i % 2) * 3 - 1.5, Math.sin(o.a) * o.rad]}>
            <sphereGeometry args={[o.r, 24, 24]} />
            <meshStandardMaterial
              color={o.color}
              roughness={0.15}
              metalness={0.85}
              emissive={o.color}
              emissiveIntensity={0.3}
            />
          </mesh>
        </Float>
      ))}
    </group>
  );
}

export function HeroBackdrop() {
  const [cap, setCap] = useState<SceneCapability | null>(null);
  // Idle-deferred mount (S4.2): the canvas — aria-hidden and decorative —
  // goes up only after first paint + idle, so the hero's LCP is provably
  // untouched. The tier decision itself stays synchronous (a cheap probe).
  const [idleReady, setIdleReady] = useState(false);
  const dofTargetRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 4, -6));

  useEffect(() => {
    setCap(sceneTier());
    return whenIdle(() => setIdleReady(true));
  }, []);

  if (!cap || cap.tier === "flat" || !idleReady) return null;

  const bars = buildBars(30);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <SceneCanvas
        capability={cap}
        effects={cap.tier === "studio"}
        camera={{ position: [0, 13, 30], fov: 42 }}
        style={{ position: "absolute" }}
        marketing
        scrollDolly
        dollyFocus={{ from: [0, 4, -6], to: [0, 1.6, 2] }}
        dofTargetRef={dofTargetRef}
        // A room to stand in. Without it the skyline reads as objects floating
        // in a document, because scene.environment lights materials but is not
        // a backdrop.
        backdrop="sky"
      >
        <DataSkyline bars={bars} />
        <OrbitingSpheres />
        <Sparkles
          count={cap.tier === "studio" ? 160 : 70}
          scale={[34, 18, 24]}
          size={2.6}
          speed={0.35}
          opacity={0.7}
          color="#7FC6C8"
        />
        {/* The data floor is SceneCanvas's own SceneFloor — this scene used to
            mount a second, identical Grid on top of it, which doubled the
            floor's draw calls and drew every line twice. */}
        {/* IBL now comes from the shared environment mounted by SceneCanvas —
            one physical light stage for the whole app. */}
      </SceneCanvas>
    </div>
  );
}

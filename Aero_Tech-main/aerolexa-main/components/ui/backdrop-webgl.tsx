"use client";

import { Canvas } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";

import { isDarkTheme } from "@/components/ui/theme";
import { dataGlass, softTouch } from "@/lib/scene/materials";
import { sceneQuality } from "@/lib/scene/quality";
import type { SceneCapability } from "@/lib/scene/tier";

/**
 * The S9 studio-tier workspace backdrop (the "optional WebGL backdrop" from
 * the decision record): a sparse, physical set — three frosted data orbs on a
 * matte ground with a thin particle field — replacing the CSS Backdrop3D only
 * where the measured tier can afford it. Every other tier keeps the zero-cost
 * CSS version (see Backdrop3DUnified in backdrop-3d.tsx).
 *
 * Determinism rule: the particle field is seeded (PRNG, fixed seed), so the
 * backdrop is screenshot-diffable like every other scene. No Math.random().
 *
 * Budget rule: this canvas is `frameloop="demand"` — it renders on mount and
 * on hover-ish pointer moves, never a continuous loop behind the whole app.
 */

/** Deterministic PRNG (mulberry32) — the same field renders identically twice. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORBS: { position: [number, number, number]; color: string; radius: number }[] = [
  { position: [-8, 2, -6], color: "#3D9BE9", radius: 3 },
  { position: [10, 4, -4], color: "#5AA8AA", radius: 2.6 },
  { position: [-4, -1, 8], color: "#FFB400", radius: 2.2 },
];

const Orbs = function Orbs() {
  const dark = isDarkTheme();
  const materials = useMemo(() => ORBS.map((o) => dataGlass(o.color, dark ? "dark" : "light", true)), [dark]);
  return (
    <>
      {ORBS.map((o, i) => (
        <mesh key={i} position={o.position} material={materials[i]}>
          <sphereGeometry args={[o.radius, 32, 32]} />
        </mesh>
      ))}
    </>
  );
};

const GroundPlane = function GroundPlane() {
  const material = useMemo(() => softTouch(isDarkTheme() ? "dark" : "light"), []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -4.5, 0]} material={material} receiveShadow>
      <planeGeometry args={[60, 60]} />
    </mesh>
  );
};

const PARTICLE_COUNT = 160;

const SubtleParticles = function SubtleParticles() {
  const positions = useMemo(() => {
    const rand = seededRandom(20260920);
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      arr[i * 3] = (rand() - 0.5) * 40;
      arr[i * 3 + 1] = rand() * 10 - 2;
      arr[i * 3 + 2] = (rand() - 0.5) * 40;
    }
    return arr;
  }, []);

  const colors = useMemo(() => {
    const rand = seededRandom(42);
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    const palette = [new THREE.Color("#3D9BE9"), new THREE.Color("#5AA8AA"), new THREE.Color("#FFB400")];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const c = palette[Math.floor(rand() * palette.length)] as THREE.Color;
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.15} vertexColors transparent opacity={0.35} sizeAttenuation />
    </points>
  );
};

export interface BackdropWebGLProps {
  capability: SceneCapability;
  className?: string;
}

export function BackdropWebGL({ capability, className }: BackdropWebGLProps) {
  const quality = useMemo(() => sceneQuality(capability), [capability]);

  if (capability.tier !== "studio") return null;
  if (!capability.webgl) return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-0 overflow-hidden ${className ?? ""}`}
      style={{ willChange: "transform" }}
    >
      <Canvas
        dpr={quality.dpr}
        camera={{ position: [0, 4, 12], fov: 35 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
        style={{ width: "100%", height: "100%" }}
        frameloop="demand"
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[8, 12, 6]} intensity={0.8} />
        <directionalLight position={[-8, 6, -6]} intensity={0.4} color="#5AA8AA" />
        <fogExp2 attach="fog" args={[isDarkTheme() ? "#0b1016" : "#eef1f6", 0.008]} />
        <Orbs />
        <GroundPlane />
        <SubtleParticles />
      </Canvas>
    </div>
  );
}

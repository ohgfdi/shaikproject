"use client";

import { OrbitControls, Grid } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { type ReactNode } from "react";

import { isDarkTheme } from "@/components/ui/theme";

export interface ChartCamera {
  position: [number, number, number];
  fov?: number;
}

export interface ChartCanvasProps {
  height: number;
  ariaLabel: string;
  children: ReactNode;
  /** Allow drag-to-orbit. Safe default for interactive charts. */
  interact?: boolean;
  /** Slowly rotate even without interaction. */
  autoRotate?: boolean;
  /**
   * Per-scene camera framing. Charts have wildly different footprints (a
   * heat grid vs an influencer row); the shared canvas stays the one factory
   * for lights/floor/controls while the scene owns its framing. Defaults to
   * the original all-charts pose when omitted.
   */
  camera?: ChartCamera;
}

/**
 * True only when a WebGL context can actually be created. Never throws and
 * always returns false on the server, so rendering the heavy 3D path is a
 * client-only decision and there is a graceful 2D fallback everywhere else.
 */

function ChartFloor() {
  const dark = isDarkTheme();
  return (
    <Grid
      position={[0, -0.01, 0]}
      args={[10, 10]}
      cellSize={0.9}
      sectionSize={3}
      cellThickness={0.6}
      sectionThickness={1}
      cellColor={dark ? "rgba(255,255,255,0.09)" : "rgba(10,10,10,0.07)"}
      sectionColor={dark ? "rgba(90,168,170,0.35)" : "rgba(90,168,170,0.4)"}
      fadeDistance={42}
      fadeStrength={1.2}
      infiniteGrid={false}
    />
  );
}

function SceneLights() {
  const accent = isDarkTheme() ? "#7FC6C8" : "#3D9BE9";
  return (
    <>
      <ambientLight intensity={0.65} />
      <hemisphereLight intensity={0.3} color="#ffffff" groundColor="#16202a" />
      <directionalLight position={[9, 16, 8]} intensity={1.15} color="#ffffff" />
      <pointLight position={[-14, 10, -10]} intensity={60} color={accent} />
      <directionalLight position={[-8, 6, -12]} intensity={0.35} color={accent} />
    </>
  );
}

/**
 * Shared R3F canvas used by every 3D chart: transparent background, balanced
 * lights, a stylised data grid under the scene, and gentle orbit controls.
 */
export function ChartCanvas({
  height,
  ariaLabel,
  children,
  interact = true,
  autoRotate = false,
  camera = { position: [0, 30, 34], fov: 36 },
}: ChartCanvasProps) {
  return (
    <div className="relative w-full select-none" style={{ height }} role="img" aria-label={ariaLabel}>
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [...camera.position], fov: camera.fov ?? 36 }}
        gl={{ antialias: true, alpha: true }}
      >
        <SceneLights />
        {children}
        <ChartFloor />
        <OrbitControls
          makeDefault={false}
          enablePan={false}
          enableZoom={false}
          autoRotate={autoRotate}
          autoRotateSpeed={0.8}
          minPolarAngle={Math.PI * 0.18}
          maxPolarAngle={Math.PI * 0.55}
          enabled={interact}
          target={[0, 8, 0]}
        />
      </Canvas>
    </div>
  );
}

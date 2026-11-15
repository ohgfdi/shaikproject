"use client";

import { ContactShadows, Grid, PerformanceMonitor, SoftShadows } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { ACESFilmicToneMapping, Color, type Renderer, type Vector3 } from "three";

import { GradientBackdrop, type BackdropVariant } from "@/components/scene/backdrop";
import { ParallaxRig } from "@/components/scene/camera-rig";
import { ScenePostfx } from "@/components/scene/postfx";
import { SceneEnvironment } from "@/components/scene/scene-environment";
import { isDarkTheme } from "@/components/ui/theme";
import { CHART } from "@/components/ui/theme";
import { recordDowngrade, sceneQuality, type EffectKey } from "@/lib/scene/quality";
import type { SceneCapability, SceneTier } from "@/lib/scene/tier";

export interface SceneCanvasProps {
  /** Which measured tier to render for. A "flat" tier renders nothing. */
  capability: SceneCapability;
  camera: { position: [number, number, number]; fov?: number; near?: number; far?: number };
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Run the tier's post-processing stack. Only used when the tier allows it. */
  effects?: boolean;
  /** The scene is decorative — never focusable, announce as such. */
  ariaHidden?: boolean;
  /**
   * Set to true for motionless scenes (charts that only change on data change);
   * renders on demand instead of every frame. Animated scenes must leave this
   * false so their raf loop runs.
   */
  staticScene?: boolean;
  /**
   * Marketing surfaces may pull focus (DoF pass); workspace scenes stay crisp.
   * Only honoured on tiers whose stack includes "dof".
   */
  marketing?: boolean;
  /**
   * Scroll-driven camera dolly (S4.1): over the first `span` px of scroll the
   * rig dollies toward the scene and — with a `dofTargetRef` — pulls focus
   * along `dollyFocus`. Studio+depth only (the rig never mounts on flat).
   */
  scrollDolly?: boolean;
  /** Scroll span (px) for the dolly; defaults to one viewport height. */
  dollySpan?: number;
  /** DoF focus path for the scroll dolly: world point at scroll 0 → 1. */
  dollyFocus?: { from: [number, number, number]; to: [number, number, number] };
  /** Vector the DoF effect tracks (mutated by the rig; create with useRef). */
  dofTargetRef?: RefObject<Vector3>;
  /**
   * Height of the grounding ContactShadows plane (S2.1). Scenes with raised
   * grounds (the ambient plinth) set their own; `null` opts out entirely.
   */
  contactShadowsY?: number | null;
  /**
   * Mount a vertical gradient sky behind the scene. Opt-in: chart scenes are
   * deliberately transparent so they sit on the page's own background, while
   * marketing scenes need a room to stand in or the geometry reads as floating.
   * One draw call either way.
   */
  backdrop?: BackdropVariant;
}

/**
 * One shared WebGL canvas for the whole realism system. Physical-render
 * baseline: ACES filmic tone mapping, properly colour-managed output, and —
 * only on tiers that can afford it — the tier's post stack (postfx.tsx) and
 * real-time shadows (SoftShadows PCSS + ContactShadows). A PerformanceMonitor
 * guards the honesty of the system: sustained low fps drops quality one rung
 * and records the downgrade as telemetry, instead of pretending everything is
 * fine. Everything else mounts scenes through this so tuning happens in
 * exactly one place.
 */
export function SceneCanvas({
  capability,
  camera,
  children,
  className,
  style,
  effects = true,
  ariaHidden = true,
  staticScene = false,
  marketing = false,
  scrollDolly = false,
  dollySpan,
  dollyFocus,
  dofTargetRef,
  contactShadowsY = 0.011,
  backdrop,
}: SceneCanvasProps) {
  const dark = useMemo(() => isDarkTheme(), []);
  const [liveTier, setLiveTier] = useState<SceneTier>(capability.tier);

  // A new measured capability resets the runtime tier (e.g. after a forced
  // tier switch from the scene inspector).
  useEffect(() => {
    setLiveTier(capability.tier);
  }, [capability.tier]);

  const quality = sceneQuality({ ...capability, tier: liveTier });
  const effectsOn = capability.effects && effects && quality.effects.length > 0;
  // Studio-only: quality.shadowMapSize is 0 on every other tier, so the light
  // rig and the shadow catcher come and go with the runtime tier for free.
  const shadowsOn = quality.shadowMapSize > 0;

  if (capability.tier === "flat" || liveTier === "flat") return null;

  return (
    <div
      aria-hidden={ariaHidden}
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        ...style,
      }}
    >
      <Canvas
        dpr={quality.dpr}
        camera={{ ...camera }}
        shadows={shadowsOn}
        gl={{
          // SMAA in the post stack replaces MSAA when effects are on; a plain
          // canvas keeps hardware AA. Either way, edges are handled once.
          antialias: !effectsOn,
          alpha: true,
          powerPreference: "high-performance",
        }}
        onCreated={({ gl }) => {
          configureRenderer(gl);
          // S2 measurement hook: expose the live renderer on its own canvas
          // element so the e2e budget specs assert real `gl.info.render.calls`
          // and heap numbers — not a DOM guess. Harmless in production.
          const el = gl.domElement as HTMLCanvasElement & { __sceneGl?: unknown };
          el.__sceneGl = gl;
        }}
        style={{ width: "100%", height: "100%" }}
        frameloop={staticScene ? "demand" : undefined}
      >
        <SceneEnvironment theme={dark ? "dark" : "light"} resolution={quality.envResolution} />
        {backdrop && <GradientBackdrop variant={backdrop} />}
        <ParallaxRig
          enabled={quality.parallax}
          staticScene={staticScene}
          dolly={
            scrollDolly
              ? { span: dollySpan, focusFrom: dollyFocus?.from, focusTo: dollyFocus?.to, focusTargetRef: dofTargetRef }
              : undefined
          }
        />
        {!staticScene && (
          <PerformanceMonitor
            flipflops={2}
            // Measured, not guessed: sustained low fps drops one rung and is
            // recorded. One hitch never downgrades a good device.
            onDecline={() => {
              setLiveTier((current) => {
                if (current === capability.tier) {
                  recordDowngrade(current, 0);
                  return current === "studio" ? "depth" : "flat";
                }
                return current;
              });
            }}
            onFallback={() => {
              recordDowngrade(liveTier, 0);
              setLiveTier("flat");
            }}
          />
        )}
        {shadowsOn && <SoftShadows size={26} samples={12} focus={0.7} />}
        <SceneLights
          intensity={liveTier === "studio" ? 1 : 0.8}
          shadowMapSize={shadowsOn ? quality.shadowMapSize : 0}
        />
        <SceneFog enabled={liveTier === "studio"} />
        <group>{children}</group>
        <SceneFloor accent={liveTier === "studio"} />
        {shadowsOn && <SceneShadowCatcher dark={dark} />}
        {contactShadowsY !== null && (
          <ContactShadows
            position={[0, contactShadowsY, 0]}
            scale={42}
            far={5}
            blur={shadowsOn ? 2.4 : 3.2}
            opacity={dark ? 0.55 : 0.3}
            resolution={shadowsOn ? 512 : 256}
            color="#05080c"
          />
        )}
        {effectsOn && (
          <ScenePostfx quality={quality} dark={dark} marketing={marketing} focusTarget={dofTargetRef?.current} />
        )}
      </Canvas>
    </div>
  );
}

/**
 * Physical-render baseline for every canvas: ACES filmic tone mapping (the
 * same curve film and CG use) and sRGB-correct output. Applied once per
 * canvas via onCreated — never per frame. Exported so tests can pin the
 * contract without booting WebGL.
 */
export function configureRenderer(renderer: Renderer): void {
  const gl = renderer as Renderer & { toneMapping?: unknown; outputColorSpace?: unknown };
  gl.toneMapping = ACESFilmicToneMapping;
  // r165 default, pinned explicitly so a three upgrade can't silently change it.
  gl.outputColorSpace = "srgb";
}

/**
 * Balanced, theme-aware light rig: cool key from above, warm rim behind,
 * accent glows so emissive data bars read as lit glass. When `shadowMapSize`
 * is set (studio tier, lib/scene/quality.ts) the key light casts real
 * PCSS-softened shadows through the SoftShadows patch.
 */
export function SceneLights({ intensity = 1, shadowMapSize = 0 }: { intensity?: number; shadowMapSize?: number }) {
  const dark = isDarkTheme();
  const accent = dark ? "#7FC6C8" : "#3D9BE9";
  const warm = dark ? "#FFB400" : "#FF8A3D";
  return (
    <>
      <ambientLight intensity={0.55 * intensity} />
      <hemisphereLight intensity={0.35 * intensity} color="#ffffff" groundColor={dark ? "#10161d" : "#e8e8ec"} />
      <directionalLight
        position={[9, 16, 8]}
        intensity={1.1 * intensity}
        color="#ffffff"
        castShadow={shadowMapSize > 0}
        {...(shadowMapSize > 0
          ? {
              "shadow-mapSize-width": shadowMapSize,
              "shadow-mapSize-height": shadowMapSize,
              "shadow-camera-left": -24,
              "shadow-camera-right": 24,
              "shadow-camera-top": 24,
              "shadow-camera-bottom": -24,
              "shadow-camera-near": 1,
              "shadow-camera-far": 80,
              "shadow-bias": -0.0004,
            }
          : {})}
      />
      <pointLight position={[-14, 10, -10]} intensity={55 * intensity} color={accent} distance={60} />
      <pointLight position={[14, 6, 16]} intensity={40 * intensity} color={warm} distance={60} />
    </>
  );
}

/** Exp2 fog — depth cue tuned per theme. Cheap, never allocates. */
export function SceneFog({ enabled = true }: { enabled?: boolean }) {
  const dark = isDarkTheme();
  if (!enabled) return null;
  return <fogExp2 attach="fog" args={[new Color(dark ? "#0b1016" : "#eef1f6"), dark ? 0.012 : 0.02]} />;
}

/** The subtle perspective grid used as the "data floor" of every scene. */
export function SceneFloor({ accent = true }: { accent?: boolean }) {
  const dark = isDarkTheme();
  return (
    <Grid
      position={[0, -0.02, 0]}
      args={[10, 10]}
      cellSize={0.9}
      sectionSize={3}
      cellThickness={0.6}
      sectionThickness={1}
      cellColor={dark ? "rgba(255,255,255,0.08)" : "rgba(10,10,10,0.06)"}
      sectionColor={accent ? CHART.teal : dark ? "rgba(255,255,255,0.15)" : "rgba(10,10,10,0.1)"}
      fadeDistance={48}
      fadeStrength={1.2}
      infiniteGrid={false}
    />
  );
}

/**
 * Shadow-receiving floor: a shadowMaterial plane that shows only the cast
 * shadows, keeping the stylised grid intact (S2.2). Mounted only on tiers
 * with a shadow map budget; ShadowMaterial renders nothing where no shadow
 * falls, so it is free on flat/empty regions.
 */
export function SceneShadowCatcher({ dark = false }: { dark?: boolean }) {
  return (
    <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]}>
      <planeGeometry args={[80, 80]} />
      <shadowMaterial transparent opacity={dark ? 0.35 : 0.16} color="#05080c" />
    </mesh>
  );
}

/** Effect keys of the canonical stack — re-exported for scene consumers. */
export type { EffectKey };

"use client";

import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type * as THREE from "three";

import {
  buildEnvironment,
  environmentIntensity,
  environmentSource,
  loadHdriEnvironment,
  type EnvironmentBuild,
} from "@/lib/scene/environment";
import type { Theme } from "@/lib/scene/materials";

/**
 * How far up the asset ladder the scene currently is. Exposed on the document
 * so screenshot specs can wait for a settled value instead of racing an
 * in-flight fetch — "pending" means an HDRI is still decoding, anything else is
 * final for this mount.
 */
export const ENV_SETTLED_ATTR = "data-scene-env";

type EnvState = "none" | "procedural" | "pending" | "hdri";

function announce(state: EnvState): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(ENV_SETTLED_ATTR, state);
}

/**
 * Assigns the IBL environment to the scene at the tier's resolution. Mounted by
 * SceneCanvas — not by individual scenes — so every scene in the app reflects the
 * same physical light stage. A resolution of 0 (flat tier) or a non-browser
 * context leaves lighting untouched: the analytic light rig remains the honest
 * fallback.
 *
 * Two rungs, mounted in order so the scene is never unlit and never flashes:
 * the procedural studio synchronously, then the shipped HDRI once it decodes.
 * If the HDRI cannot be fetched (offline, self-hosted without `public/env`, a
 * blocked request) the studio simply stays — a decode failure never leaves the
 * scene black.
 */
export function SceneEnvironment({
  theme,
  resolution,
  intensity = 1,
}: {
  theme: Theme;
  resolution: number;
  intensity?: number;
}) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    if (resolution <= 0) {
      announce("none");
      return;
    }

    let current: EnvironmentBuild | null = buildEnvironment(theme, resolution, gl);
    if (!current) {
      announce("none");
      return;
    }

    const sceneWithEnv = scene as THREE.Scene & { environmentIntensity?: number };
    const prev = scene.environment;
    const prevIntensity = sceneWithEnv.environmentIntensity;

    const apply = (build: EnvironmentBuild) => {
      scene.environment = build.texture;
      sceneWithEnv.environmentIntensity = intensity * environmentIntensity(theme, build.source);
    };
    apply(current);

    const source = environmentSource(theme, resolution);
    if (source.kind !== "hdri") {
      announce("procedural");
      return;
    }

    announce("pending");
    let cancelled = false;
    void loadHdriEnvironment(source, resolution, gl).then((upgraded) => {
      // A cancelled effect (theme switch, unmount) must not touch the scene.
      if (cancelled) return;
      if (!upgraded) {
        announce("procedural");
        return;
      }
      current = upgraded;
      apply(upgraded);
      announce("hdri");
    });

    return () => {
      cancelled = true;
      scene.environment = prev;
      sceneWithEnv.environmentIntensity = prevIntensity;
    };
  }, [scene, gl, theme, resolution, intensity]);

  return null;
}

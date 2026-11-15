"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";

import { clamp01, lerp, scrollProgress, smoothstep } from "@/lib/scene/scroll";

/**
 * Scroll-dolly configuration (S4.1, the defining L4 feature).
 *
 * As the user scrolls the first viewport of the page the camera dollies from
 * its rest pose toward a closer one, and the DoF focus point pulls from a far
 * landmark to a near one. One rig owns the camera per canvas: dolly and
 * parallax are composed here instead of fighting between two rigs.
 */
export interface ScrollDolly {
  /**
   * Scroll span (px) over which the dolly completes. Defaults to one
   * viewport height — right for a hero at the top of the page.
   */
  span?: number;
  /** Camera pose at scroll 1. Defaults to 78% of the way toward the origin. */
  to?: [number, number, number];
  /** World-space DoF focus point at scroll 0 (paired with `focusTargetRef`). */
  focusFrom?: [number, number, number];
  /** World-space DoF focus point at scroll 1. */
  focusTo?: [number, number, number];
  /** Vector the mounted DepthOfField effect reads its target from. */
  focusTargetRef?: RefObject<THREE.Vector3>;
}

/**
 * Pointer parallax + scroll dolly for decorative scenes: the camera drifts a
 * few degrees toward the pointer and, when configured, dollies along the
 * scroll progress, so depth reads as physical without ever taking control
 * away from the page (no orbit, no scroll hijack).
 *
 * Honesty rules:
 *  - Gated by `quality.parallax` — flat tier never mounts it.
 *  - Honours `prefers-reduced-motion`: renders nothing when the user asked
 *    for stillness, regardless of tier.
 *  - `staticScene` canvases (frameloop="demand") never mount it — a demand
 *    frameloop must not be woken by a rig that runs every frame.
 */
export function CameraRig({
  enabled,
  strength = 0.35,
  dolly,
}: {
  enabled: boolean;
  strength?: number;
  dolly?: ScrollDolly;
}) {
  const camera = useThree((s) => s.camera);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const base = useRef(new THREE.Vector3());
  const baseSet = useRef(false);
  const dollyTo = useRef(new THREE.Vector3());
  const target = useRef(new THREE.Vector3());
  const progress = useRef(0);

  // Scroll is read imperatively into a ref — no React re-render per scroll
  // event; the frame loop picks the latest progress up for free.
  useEffect(() => {
    if (!dolly) return;
    const spanFor = () => (dolly.span && dolly.span > 0 ? dolly.span : window.innerHeight || 1);
    const read = () => {
      progress.current = scrollProgress(window.scrollY || 0, spanFor());
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
    };
  }, [dolly]);

  useFrame((state, delta) => {
    if (!enabled || reduced.current) return;
    if (!baseSet.current) {
      base.current.copy(camera.position);
      if (dolly) {
        dollyTo.current.set(...(dolly.to ?? [base.current.x * 0.78, base.current.y * 0.78, base.current.z * 0.78]));
      }
      baseSet.current = true;
    }
    // Dolly pose (or rest pose) + pointer parallax on top; spring-free and
    // allocation-free, with a frame-rate independent lerp factor.
    const p = dolly ? smoothstep(clamp01(progress.current)) : 0;
    if (dolly) {
      target.current.set(
        lerp(base.current.x, dollyTo.current.x, p),
        lerp(base.current.y, dollyTo.current.y, p),
        lerp(base.current.z, dollyTo.current.z, p),
      );
    } else {
      target.current.copy(base.current);
    }
    const px = (state.pointer.x || 0) * strength;
    const py = (state.pointer.y || 0) * strength * 0.6;
    target.current.x += px;
    target.current.y += py;
    const k = 1 - Math.exp(-3 * delta); // frame-rate independent lerp factor
    camera.position.lerp(target.current, k);
    camera.lookAt(0, 0, 0);
    if (dolly?.focusTargetRef?.current && dolly.focusFrom && dolly.focusTo) {
      dolly.focusTargetRef.current.set(
        lerp(dolly.focusFrom[0], dolly.focusTo[0], p),
        lerp(dolly.focusFrom[1], dolly.focusTo[1], p),
        lerp(dolly.focusFrom[2], dolly.focusTo[2], p),
      );
    }
  });

  return null;
}

/**
 * Convenience mount inside SceneCanvas-style trees: resolves the two gates
 * (tier + reduced motion) and no-ops when static, so scenes can include it
 * unconditionally.
 */
export function ParallaxRig({
  enabled,
  staticScene = false,
  dolly,
}: {
  enabled: boolean;
  staticScene?: boolean;
  dolly?: ScrollDolly;
}) {
  if (!enabled || staticScene) return null;
  return <CameraRig enabled dolly={dolly} />;
}

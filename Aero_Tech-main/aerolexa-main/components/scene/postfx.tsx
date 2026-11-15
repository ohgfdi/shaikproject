"use client";

/**
 * The post-processing stack, in canonical order (lib/scene/quality.ts):
 * bloom → smaa → dof → ao → vignette → grain.
 *
 * Every pass is tier-gated: the tier's `effects` list is the contract, and
 * this module renders exactly that stack — nothing more, nothing invented.
 * On `depth` the stack is bloom + vignette only; on `flat` this module never
 * mounts. DoF exists only where focus pulls make sense (marketing flag); when
 * a scroll dolly steers a focus target, the DoF tracks that world point.
 */

import { DepthOfField, EffectComposer, Bloom, SMAA, Vignette, Noise, N8AO } from "@react-three/postprocessing";
import { useMemo, type JSX } from "react";
import type * as THREE from "three";

import type { EffectKey, SceneQuality } from "@/lib/scene/quality";

export function ScenePostfx({
  quality,
  dark,
  marketing = false,
  focusTarget,
}: {
  quality: SceneQuality;
  dark: boolean;
  /** Marketing surfaces may pull focus (DoF); workspace scenes stay crisp. */
  marketing?: boolean;
  /** World-space focus target for the focus pull (scroll dolly), when any. */
  focusTarget?: THREE.Vector3;
}) {
  const enabled = useMemo(() => new Set(quality.effects), [quality]);
  const has = (k: EffectKey) => enabled.has(k);

  if (quality.effects.length === 0) return null;

  const children: JSX.Element[] = [];
  if (has("bloom")) {
    children.push(<Bloom key="bloom" intensity={0.55} luminanceThreshold={0.9} luminanceSmoothing={0.35} mipmapBlur />);
  }
  if (has("smaa")) children.push(<SMAA key="smaa" />);
  if (has("dof") && marketing) {
    children.push(
      <DepthOfField
        key="dof"
        focusDistance={0.012}
        focalLength={0.05}
        bokehScale={3.5}
        // Focus pull: when a target is provided the effect tracks it in world
        // space instead of the fixed focusDistance (scroll dolly, S4.1).
        target={focusTarget}
      />,
    );
  }
  // Ambient occlusion — N8AO (horizon-based, denoised, half-res) fills the
  // "ao" slot of the canonical stack; its own depth/normal handling is why the
  // composer below does not need a separate normal pass for it.
  if (has("ao")) {
    children.push(
      <N8AO key="ao" halfRes aoRadius={3.2} distanceFalloff={1.2} intensity={dark ? 2.2 : 1.4} quality="medium" />,
    );
  }
  if (has("vignette")) {
    children.push(<Vignette key="vignette" eskil={false} offset={0.18} darkness={dark ? 0.55 : 0.32} />);
  }
  if (has("grain")) children.push(<Noise key="grain" opacity={0.035} />);

  return <EffectComposer enableNormalPass={false}>{children}</EffectComposer>;
}

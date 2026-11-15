"use client";

import { useEffect, useMemo, useState } from "react";

import { SceneCanvas } from "@/components/scene/scene-canvas";
import { isDarkTheme } from "@/components/ui/theme";
import { whenIdle } from "@/lib/scene/defer";
import { dataGlass, softTouch } from "@/lib/scene/materials";
import { sceneTier, type SceneCapability } from "@/lib/scene/tier";

/**
 * The shared ambient set used by auth and onboarding surfaces: a quiet
 * composition of glass panels over a soft-touch plinth, lit by the app-wide IBL
 * stage. Decorative only — aria-hidden, pointer-transparent, and flat tiers
 * render nothing at all. Deterministic (no Math.random) so screenshots are
 * stable.
 *
 * `variant` picks a different composition per surface. The panel count, spread
 * and seed are all fixed values rather than randomised, because a marketing
 * surface that renders differently on every load is a surface whose screenshots
 * can never be compared — and the per-tier specs compare them.
 */
export type AmbientVariant = "auth" | "onboarding";

const COMPOSITIONS: Record<AmbientVariant, { count: number; spread: number; seed: number; lift: number }> = {
  // Fewer, taller panels and a tighter spread: the login card sits on top, so
  // the composition has to stay quiet enough to read a form against.
  auth: { count: 9, spread: 1.6, seed: 7, lift: 0 },
  // More panels, pushed wider and lifted: onboarding has no card, so the scene
  // is the thing being looked at, and a wider field gives it depth to work with.
  onboarding: { count: 13, spread: 1.35, seed: 21, lift: 0.25 },
};

export function AmbientScene({ className, variant = "auth" }: { className?: string; variant?: AmbientVariant }) {
  const [cap, setCap] = useState<SceneCapability | null>(null);
  // Idle-deferred mount, same reasoning as the hero (S4.2): the canvas is
  // decorative, so it must not compete with the form or the wizard for the
  // first paint. The tier probe itself stays synchronous and cheap.
  const [idleReady, setIdleReady] = useState(false);

  useEffect(() => {
    setCap(sceneTier());
    return whenIdle(() => setIdleReady(true));
  }, []);

  if (!cap || cap.tier === "flat" || !idleReady) return null;

  return (
    <div aria-hidden className={className}>
      <SceneCanvas
        capability={cap}
        camera={{ position: [0, 2.6, 9], fov: 38 }}
        effects={cap.tier === "studio"}
        marketing
        // The plinth top sits at y = -0.35 + 0.25 = -0.1: ground the contact
        // shadows there so the glass slabs read as standing on it (S2.1).
        contactShadowsY={-0.09}
        // The glass needs a room behind it, or the panels read as floating
        // cards rather than as objects on a plinth.
        backdrop="horizon"
      >
        <GlassSet detail={cap.tier === "studio" ? 1 : 0.6} variant={variant} />
      </SceneCanvas>
    </div>
  );
}

interface Slab {
  x: number;
  z: number;
  rot: number;
  h: number;
  w: number;
  color: string;
}

function GlassSet({ detail, variant }: { detail: number; variant: AmbientVariant }) {
  const theme = isDarkTheme() ? "dark" : "light";
  const composition = COMPOSITIONS[variant];
  const slabs = useMemo<Slab[]>(() => {
    let seed = composition.seed;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const count = Math.max(5, Math.round(composition.count * detail));
    const colors = ["#5AA8AA", "#FFB400", "#7C5CFF", "#3D9BE9"];
    return Array.from({ length: count }, (_, i) => ({
      x: (i - (count - 1) / 2) * composition.spread + (rand() - 0.5) * 0.5,
      z: (rand() - 0.5) * 3.2,
      rot: (rand() - 0.5) * 0.35,
      h: 1.4 + rand() * 3.4,
      w: 0.5 + rand() * 0.4,
      color: colors[i % colors.length] ?? "#5AA8AA",
    }));
  }, [detail, composition]);

  const glass = useMemo(() => slabs.map((s) => dataGlass(s.color, theme, false)), [slabs, theme]);
  const plinth = useMemo(() => softTouch(theme), [theme]);

  return (
    <group>
      <mesh position={[0, -0.35, 0]} material={plinth} receiveShadow>
        <boxGeometry args={[16, 0.5, 9]} />
      </mesh>
      {slabs.map((s, i) => (
        <mesh
          key={i}
          position={[s.x, s.h / 2 - 0.1 + composition.lift, s.z]}
          rotation={[0, s.rot, 0]}
          material={glass[i]}
          castShadow
        >
          <boxGeometry args={[s.w, s.h, s.w * 1.4]} />
        </mesh>
      ))}
    </group>
  );
}

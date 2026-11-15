"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

import { LazyBackdropWebGL } from "@/components/scene/lazy-scenes";
import { sceneTier, type SceneCapability } from "@/lib/scene/tier";

/**
 * Subtle depth backdrop for the authenticated workspace: slowly drifting
 * blurred "data orbs" and a faint perspective grid. Pure CSS/DOM — no WebGL,
 * no extra bundle weight on every app screen.
 */
export function Backdrop3D() {
  const reduced = useReducedMotion();

  if (reduced) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.55] dark:opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgb(var(--line)/0.05) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--line)/0.05) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          transform: "perspective(900px) rotateX(32deg) scale(1.6)",
          transformOrigin: "50% 0%",
          maskImage: "linear-gradient(to bottom, transparent, black 55%, transparent)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 55%, transparent)",
        }}
      />

      <motion.div
        className="absolute -left-40 top-24 h-[420px] w-[420px] rounded-full bg-accent/10 blur-[100px] dark:bg-[#5AA8AA]/10"
        animate={{ x: [0, 60, 0], y: [0, 30, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -right-32 top-1/3 h-[460px] w-[460px] rounded-full bg-[#7C5CFF]/10 blur-[110px] dark:bg-[#7C5CFF]/10"
        animate={{ x: [0, -70, 0], y: [0, -40, 0] }}
        transition={{ duration: 30, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-[-120px] left-1/3 h-[380px] w-[380px] rounded-full bg-amber/10 blur-[100px] dark:bg-[#FFB400]/10"
        animate={{ x: [0, 50, 0], y: [0, -30, 0] }}
        transition={{ duration: 34, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

/**
 * The workspace backdrop, tier-honest (S9): the measured studio tier with
 * WebGL gets the physical set (BackdropWebGL); every other tier keeps this
 * zero-cost CSS version. The tier probe runs client-side after mount (it is
 * a cheap, synchronous WebGL probe) so SSR always paints the CSS version and
 * never flashes a canvas.
 */
export function WorkspaceBackdrop() {
  const [cap, setCap] = useState<SceneCapability | null>(null);

  useEffect(() => {
    setCap(sceneTier());
  }, []);

  if (cap && cap.tier === "studio" && cap.webgl) {
    return <LazyBackdropWebGL capability={cap} />;
  }
  return <Backdrop3D />;
}

/**
 * Unified backdrop with an explicit capability — kept for callers that
 * already measured (tests, future surfaces).
 */
export function Backdrop3DUnified({ capability }: { capability: SceneCapability }) {
  if (capability.tier === "studio" && capability.webgl) {
    return <LazyBackdropWebGL capability={capability} />;
  }
  return <Backdrop3D />;
}

export type { BackdropWebGLProps } from "./backdrop-webgl";

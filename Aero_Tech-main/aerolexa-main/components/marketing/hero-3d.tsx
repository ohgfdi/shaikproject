"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

import { Tilt } from "@/components/ui/tilt";
import { SPRING } from "@/lib/scene/motion";

/* ---------------------------------------------------------------------------
   Hero preview — the mock product window, tilted in 3D with an entrance.

   DOM only, deliberately. The WebGL half of the hero lives in
   hero-backdrop-scene.tsx behind a dynamic boundary; this file is what the
   landing route can paint immediately, which is the point.
--------------------------------------------------------------------------- */

export function HeroPreview({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <div className="mt-12 mx-auto max-w-5xl rounded-2xl border border-line bg-surface/50 p-4 sm:mt-16 sm:max-w-6xl [perspective:1600px]">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 40, rotateX: 8, scale: 0.98 }}
        whileInView={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ type: "spring", ...SPRING.heavy }}
        style={{ transformStyle: "preserve-3d" }}
      >
        <Tilt max={5} scale={1.015} glare>
          <div className="relative overflow-hidden rounded-xl border border-line bg-background shadow-pop">
            {children}
          </div>
        </Tilt>
      </motion.div>
    </div>
  );
}

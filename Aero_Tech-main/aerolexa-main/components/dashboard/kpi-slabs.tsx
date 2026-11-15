"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";

import { LazyKpiSkylineScene } from "@/components/scene/lazy-scenes";
import { CHART_PALETTE } from "@/components/ui/theme";
import { Tilt } from "@/components/ui/tilt";
import { SPRING, staggerDelay } from "@/lib/scene/motion";
import { sceneTier, type SceneCapability } from "@/lib/scene/tier";
import { cn } from "@/lib/utils";

export interface KpiSlab {
  label: string;
  value: number;
  href: string;
  /** Optional single-line footnote (e.g. "updated just now"). */
  hint?: string;
}

/* ---------------------------------------------------------------------------
   Slab row
--------------------------------------------------------------------------- */

export function KpiSlabRow({ slabs }: { slabs: KpiSlab[] }) {
  const [cap, setCap] = useState<SceneCapability | null>(null);

  useEffect(() => {
    setCap(sceneTier());
  }, []);

  const active = !!cap && cap.tier !== "flat";
  const showCanvas = active && (!cap || cap.webgl) && slabs.some((s) => s.value > 0);

  const containerClass = cn("relative", showCanvas && "min-h-[140px]");
  const gridClass = "grid grid-cols-2 gap-3 lg:grid-cols-4";

  if (!active) {
    return (
      <ul className={gridClass}>
        {slabs.map((s) => (
          <li key={s.label} className="min-w-0">
            <Link href={s.href} className="card block px-4 py-3 transition-shadow hover:shadow-pop">
              <span className="block text-caption text-muted">{s.label}</span>
              <span className="mt-0.5 block text-h2 tabular-nums text-foreground">{s.value.toLocaleString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={containerClass}>
      {showCanvas && cap && <LazyKpiSkylineScene slabs={slabs} cap={cap} />}
      <ul className={cn(gridClass, "relative")}>
        {slabs.map((s, i) => (
          <KpiGlassCard key={s.label} slab={s} index={i} />
        ))}
      </ul>
    </div>
  );
}

function KpiGlassCard({ slab, index }: { slab: KpiSlab; index: number }) {
  const accentGlow = CHART_PALETTE[index % CHART_PALETTE.length] ?? "#5AA8AA";

  const inner = (
    <>
      {/* top light edge */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      {/* accent bloom */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-8 size-24 rounded-full opacity-25 blur-2xl"
        style={{ backgroundColor: accentGlow }}
      />
      <span className="block text-caption font-medium text-muted">{slab.label}</span>
      <span className="mt-1 block text-h2 tabular-nums text-foreground">{slab.value.toLocaleString()}</span>
      {slab.hint && <span className="mt-0.5 block text-caption text-muted">{slab.hint}</span>}
      {/* the number is always real text — 3D only mirrors it */}
    </>
  );

  const cardCls =
    "relative block min-w-0 overflow-hidden rounded-2xl border border-line/80 bg-surface/70 px-4 py-3 shadow-sm backdrop-blur-md transition-[border-color,box-shadow] duration-300 hover:border-accent/50 hover:shadow-pop";

  return (
    <li className="min-w-0">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: staggerDelay(index), type: "spring", ...SPRING.soft }}
        style={{ height: "100%" }}
      >
        <Tilt max={6} scale={1.02} glare className={cn(cardCls, "h-full")}>
          <Link href={slab.href} className="flex h-full flex-col">
            {inner}
          </Link>
        </Tilt>
      </motion.div>
    </li>
  );
}

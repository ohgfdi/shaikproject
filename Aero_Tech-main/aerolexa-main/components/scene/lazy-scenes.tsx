"use client";

import dynamic from "next/dynamic";

import type { KpiSlab } from "@/components/dashboard/kpi-slabs";
import type { BackdropWebGLProps } from "@/components/ui/backdrop-webgl";
import type { SceneCapability } from "@/lib/scene/tier";

/**
 * Every 3D surface in the app, behind a dynamic boundary.
 *
 * three + @react-three/fiber + drei + postprocessing is ~660 kB raw / ~231 kB
 * gzipped. Imported statically, that weight lands in the first load of every
 * route that renders anything 3D — which, because the tier probe and the app
 * shell are deliberately global, was 17 of 53 routes. It also breaks the
 * loading story: a 231 kB render-blocking dependency in front of the login
 * form is a slower login form.
 *
 * docs/3d-realism-master-plan.md §2 requires the scene chunk to be
 * "next/dynamic + ssr: false and never enter a route's first-load bundle".
 * Concentrating every `dynamic()` call here makes that a property of the
 * codebase rather than a thing each new scene has to remember: if a scene is
 * not exported from this file, it is in someone's first load.
 *
 * The typing below is deliberate. These are `import type`, so they are erased
 * at compile time and cost nothing — a value import of SceneCanvasProps or
 * KpiSlab here would rebuild the exact edge this file exists to cut.
 *
 * Two gates keep the scenes honest, and neither is weakened by deferring:
 *  - Tier honesty is unchanged. Every scene still probes the measured tier and
 *    returns early on `flat`, so a device that cannot run WebGL never requests
 *    these chunks at all. Deferring is not the same as downgrading.
 *  - The scenes are decorative and stay aria-hidden; the numbers they mirror
 *    are always real text in the DOM.
 */
const LazyAmbientScene = dynamic(() => import("./ambient-scene").then((m) => m.AmbientScene), {
  ssr: false,
  loading: () => null,
});

const LazyBackdropWebGL = dynamic<BackdropWebGLProps>(
  () => import("@/components/ui/backdrop-webgl").then((m) => m.BackdropWebGL),
  { ssr: false, loading: () => null },
);

const LazyHeroBackdrop = dynamic(
  () => import("@/components/marketing/hero-backdrop-scene").then((m) => m.HeroBackdrop),
  {
    ssr: false,
    loading: () => null,
  },
);

const LazyKpiSkylineScene = dynamic<{ slabs: KpiSlab[]; cap: SceneCapability }>(
  () => import("@/components/dashboard/kpi-skyline-scene").then((m) => m.KpiSkylineScene),
  { ssr: false, loading: () => null },
);

export { LazyAmbientScene, LazyBackdropWebGL, LazyHeroBackdrop, LazyKpiSkylineScene };

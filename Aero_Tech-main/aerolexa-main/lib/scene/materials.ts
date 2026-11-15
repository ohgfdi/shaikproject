/**
 * The Ledgerly physical material library — one source of material truth so
 * "realistic" is consistent in every scene.
 *
 * Rules this module enforces:
 *  - Materials are cached singletons keyed by (kind, color, theme, quality).
 *    Scene components never construct THREE materials inline; ad-hoc
 *    materials are how a design system rots.
 *  - Frosted-glass transmission is a studio-tier luxury (quality.transmission);
 *    every other tier gets the honest opacity-faked equivalent.
 *  - The design system's 60/30/10 rule holds inside scenes: neutral PBR
 *    dominates, accent emissives are the 10%.
 *  - Textures are procedural and generated at most once; in non-browser
 *    environments (tests, SSR) the module degrades gracefully to plain
 *    PBR — never throws, never guesses.
 */

import * as THREE from "three";

export type Theme = "dark" | "light";

export type SceneMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

/* ---------------------------------------------------------------------------
   Procedural textures — generated once, cached, browser-only
--------------------------------------------------------------------------- */

let brushedMap: THREE.CanvasTexture | null = null;

/**
 * A subtle anisotropic-looking roughness variation for brushed metal, drawn
 * once on an offscreen canvas. Returns null outside a browser (tests, SSR):
 * callers must treat null as "no map", not as an error.
 */
export function brushedRoughnessTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  if (brushedMap) return brushedMap;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#8c8c8c";
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 1) {
    const v = 140 + Math.floor(Math.sin(y * 1.7) * 20 + Math.random() * 14);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, y, size, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 8);
  brushedMap = tex;
  return tex;
}

/* ---------------------------------------------------------------------------
   Material factory + cache
--------------------------------------------------------------------------- */

type Kind = "dataGlass" | "brushedMetal" | "softTouch" | "lightEdge";

const cache = new Map<string, SceneMaterial>();

function cacheKey(kind: Kind, color: string, theme: Theme, transmission: boolean): string {
  return `${kind}:${color}:${theme}:${transmission ? "t" : "f"}`;
}

function buildMaterial(kind: Kind, color: string, theme: Theme, transmission: boolean): SceneMaterial {
  const dark = theme === "dark";

  switch (kind) {
    case "dataGlass": {
      // Tinted glass for chart bars/panels. With transmission (studio) it
      // refracts; without (depth) it fakes the same read with opacity and a
      // stronger emissive channel so the bar still reads as lit glass.
      if (transmission) {
        return new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(color),
          roughness: dark ? 0.18 : 0.28,
          metalness: 0.08,
          transmission: dark ? 0.82 : 0.55,
          thickness: 1.2,
          ior: 1.4,
          transparent: true,
          emissive: new THREE.Color(color),
          emissiveIntensity: dark ? 0.16 : 0.08,
          envMapIntensity: 1.1,
        });
      }
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.25,
        metalness: 0.55,
        emissive: new THREE.Color(color),
        emissiveIntensity: dark ? 0.45 : 0.3,
        transparent: true,
        opacity: 0.92,
        envMapIntensity: 1.0,
      });
    }

    case "brushedMetal": {
      // Hero skyline, KPI frames: metal that actually reflects the
      // environment, with a procedural roughness variation for the brushed
      // read. Falls back to uniform roughness when no canvas exists.
      const map = brushedRoughnessTexture();
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.35,
        metalness: 0.85,
        roughnessMap: map ?? null,
        envMapIntensity: 1.2,
      });
    }

    case "softTouch": {
      // Matte plastic — device/panel mockups, neutral by design.
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(dark ? "#20262e" : "#e9e8e2"),
        roughness: 0.9,
        metalness: 0.0,
      });
    }

    case "lightEdge": {
      // Emissive rim for focus/highlight states — the in-scene replacement
      // for CSS glow. Black base + hot emissive so the bloom threshold (0.9)
      // picks exactly this material up and nothing else.
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color("#000000"),
        emissive: new THREE.Color(color),
        emissiveIntensity: 2.2,
        roughness: 0.4,
        metalness: 0.0,
      });
    }
  }
}

/**
 * The shared material for a spec. Same inputs → same instance, so 500
 * instanced bars share one material and one draw call.
 */
export function sceneMaterial(kind: Kind, color: string, theme: Theme, transmission: boolean): SceneMaterial {
  const key = cacheKey(kind, color, theme, transmission);
  const hit = cache.get(key);
  if (hit) return hit;
  const material = buildMaterial(kind, color, theme, transmission);
  cache.set(key, material);
  return material;
}

/** Test/telemetry hook — how many distinct materials exist right now. */
export function materialCacheSize(): number {
  return cache.size;
}

/** Dispose every cached material (theme switch or scene teardown). */
export function disposeMaterials(): void {
  for (const material of cache.values()) material.dispose();
  cache.clear();
}

/* ---------------------------------------------------------------------------
   Convenience constructors (the only entry points scenes should use)
--------------------------------------------------------------------------- */

export function dataGlass(color: string, theme: Theme, transmission: boolean): SceneMaterial {
  return sceneMaterial("dataGlass", color, theme, transmission);
}

export function brushedMetal(color: string, theme: Theme): SceneMaterial {
  return sceneMaterial("brushedMetal", color, theme, false);
}

export function softTouch(theme: Theme): SceneMaterial {
  return sceneMaterial("softTouch", theme === "dark" ? "#20262e" : "#e9e8e2", theme, false);
}

export function lightEdge(color: string, theme: Theme): SceneMaterial {
  return sceneMaterial("lightEdge", color, theme, false);
}

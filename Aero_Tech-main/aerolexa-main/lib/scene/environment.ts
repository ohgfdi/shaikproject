/**
 * Image-based lighting, with an honest asset ladder.
 *
 * Two sources, one switch point, and a guaranteed floor:
 *
 *  1. **Real HDRI** — two CC0 1K equirectangular maps in `public/env/`, shipped
 *     with the app and served same-origin, so a self-hosted or offline install
 *     fetches nothing from the internet. Photographic radiance is what makes a
 *     reflection read as "photographed room" rather than "maths".
 *  2. **Procedural studio** — a small three-box light stage rendered once into a
 *     PMREM cubemap. It is image-based lighting in the physical sense (materials
 *     reflect a radiance field, not a hardcoded light colour), it costs no
 *     download, and it is what every scene falls back to when the HDRI cannot
 *     be decoded — no network, offline, or a decode failure mid-flight.
 *
 * The procedural build is always mounted first and synchronously, so a scene is
 * never unlit and never flashes. The HDRI replaces it only once it has decoded.
 * Both sources are deterministic for the same input, which the per-tier
 * screenshot specs rely on.
 *
 * Attribution for the shipped maps lives in `public/env/ATTRIBUTION.md`.
 */

import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

import type { Theme } from "@/lib/scene/materials";

export interface EnvironmentBuild {
  /** Ready-to-assign scene.environment texture (PMREM-processed). */
  texture: THREE.Texture;
  /** Resolution the env was rendered at — telemetry for the scoreboard. */
  resolution: number;
  /** Which ladder rung produced this build. */
  source: EnvironmentSource;
}

export type EnvironmentSource = { kind: "procedural"; reason: string } | { kind: "hdri"; url: string; credit: string };

/**
 * The shipped maps. A bright neutral studio for the light theme, a night sky for
 * the dark one — chosen so the reflected light agrees with the DOM material
 * stage (cool key above-left, warm accent behind-right) instead of fighting it.
 */
const HDRI: Record<Theme, { file: string; credit: string }> = {
  light: {
    file: "/env/studio_small_08_1k.hdr",
    credit: "Studio Small 08 — Poly Haven, CC0",
  },
  dark: {
    file: "/env/moonless_golf_1k.hdr",
    credit: "Moonless Golf — Poly Haven, CC0",
  },
};

/**
 * The single switch point, and deliberately a pure function: it names the
 * source, and it has no idea whether a browser exists. The environment is only
 * ever built by the two loaders below, and both of those refuse outside a
 * document — so the "don't hand a URL to a server" decision lives with the code
 * that would actually act on it, and this stays unit-testable in a plain node
 * process.
 *
 * Flat tier (resolution 0) always gets the procedural room: with no WebGL there
 * is nothing to reflect into.
 */
export function environmentSource(theme: Theme, resolution: number): EnvironmentSource {
  if (resolution <= 0) return { kind: "procedural", reason: "flat tier: no WebGL to light" };
  const map = HDRI[theme];
  return { kind: "hdri", url: map.file, credit: map.credit };
}

/**
 * How strongly the environment is allowed to light the scene. A photographic
 * HDRI carries far more energy than the hand-tuned procedural panels, so the
 * same intensity would blow out the dark theme; the light theme's is dialled
 * back too, so the DOM text tokens stay in charge of contrast rather than the
 * environment.
 */
export function environmentIntensity(theme: Theme, source: EnvironmentSource): number {
  if (source.kind === "procedural") return 1;
  return theme === "dark" ? 0.35 : 0.6;
}

const cache = new Map<string, EnvironmentBuild>();

/** Decodes an equirectangular map. Lazy, so a flat-tier mount never pays for it. */
const hdriDecoder = (url: string): Promise<THREE.DataTexture> => {
  // The "are we in a browser" decision belongs here, next to the code that
  // needs a document — which is what lets the failure branch below be a real
  // branch instead of an untestable one. Off-document this rejects, the caller
  // catches, and the caller keeps its procedural lighting.
  if (typeof document === "undefined") return Promise.reject(new Error("no document"));
  return new RGBELoader().loadAsync(url);
};

/**
 * Build (or fetch from cache) the theme-tinted environment at the tier's
 * resolution. Deterministic: same theme + resolution → pixel-identical env,
 * which the per-tier screenshot specs rely on.
 *
 * WebGL-only. Returns null in non-browser environments (tests, SSR) —
 * callers keep their previous lighting rather than guessing.
 */
export function buildEnvironment(
  theme: Theme,
  resolution: number,
  renderer: THREE.WebGLRenderer,
): EnvironmentBuild | null {
  if (typeof document === "undefined") return null;
  if (resolution <= 0) return null;

  const key = `procedural:${theme}:${resolution}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = studioRoom(theme);
  const renderTarget = pmrem.fromScene(envScene, 0.04);
  const texture = renderTarget.texture;

  pmrem.dispose();
  disposeRoom(envScene);

  const build: EnvironmentBuild = {
    texture,
    resolution,
    source: { kind: "procedural", reason: "explicit procedural build" },
  };
  cache.set(key, build);
  return build;
}

/**
 * Upgrade an existing environment to the shipped HDRI.
 *
 * Resolves to null — never throws — when the map cannot be fetched or decoded,
 * so an offline install, a blocked request, or a corrupt file all degrade to
 * "the procedural room stays", which is the whole point of the ladder. Callers
 * must treat a null as "keep what you have" and must never clear the scene.
 */
export async function loadHdriEnvironment(
  source: Extract<EnvironmentSource, { kind: "hdri" }>,
  resolution: number,
  renderer: THREE.WebGLRenderer,
): Promise<EnvironmentBuild | null> {
  if (resolution <= 0) return null;

  const key = `hdri:${source.url}:${resolution}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let equirect: THREE.DataTexture;
  try {
    equirect = await hdriDecoder(source.url);
  } catch {
    // Missing file, blocked request, offline install, or a decode failure. The
    // procedural room is already mounted and stays mounted.
    return null;
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();
  equirect.dispose();

  const build: EnvironmentBuild = { texture, resolution, source };
  cache.set(key, build);
  return build;
}

/** Test/telemetry hook — distinct env builds currently cached. */
export function environmentCacheSize(): number {
  return cache.size;
}

/** Dispose all cached environments (theme switch / teardown). */
export function disposeEnvironments(): void {
  for (const build of cache.values()) (build.texture as THREE.Texture & { dispose?: () => void }).dispose?.();
  cache.clear();
}

/* ---------------------------------------------------------------------------
   The studio room — a physical light stage, tinted per theme
--------------------------------------------------------------------------- */

interface RoomPanel {
  color: string;
  intensity: number;
  position: [number, number, number];
  size: [number, number];
  lookAt?: [number, number, number];
}

function roomPanels(theme: Theme): RoomPanel[] {
  const dark = theme === "dark";
  // Cool key above-left, warm rim behind-right, faint accent fill below —
  // the same trio the analytic rig (SceneLights) expresses, now as area
  // light geometry materials can *reflect*.
  return [
    {
      color: dark ? "#e8f4f5" : "#ffffff",
      intensity: dark ? 7 : 9,
      position: [-6, 9, 5],
      size: [9, 7],
    },
    {
      color: dark ? "#ffb400" : "#ffd27a",
      intensity: dark ? 3.4 : 2.4,
      position: [9, 4, -8],
      size: [7, 4],
    },
    {
      color: dark ? "#7fc6c8" : "#bfe6ea",
      intensity: dark ? 2.2 : 1.6,
      position: [0, -4, -10],
      size: [14, 3],
    },
    {
      color: dark ? "#1a2129" : "#e7eaef",
      intensity: 1,
      position: [0, 10, 0],
      size: [20, 20],
      lookAt: [0, 0, 0],
    },
  ];
}

function studioRoom(theme: Theme): THREE.Scene {
  const room = new THREE.Scene();
  const shell = new THREE.MeshBasicMaterial({ color: theme === "dark" ? "#0b1016" : "#eef1f6" });
  room.add(new THREE.Mesh(new THREE.BoxGeometry(30, 20, 30), shell));
  for (const panel of roomPanels(theme)) {
    const light = new THREE.Mesh(
      new THREE.PlaneGeometry(panel.size[0], panel.size[1]),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(panel.color).multiplyScalar(panel.intensity),
        side: THREE.DoubleSide,
      }),
    );
    light.position.set(...panel.position);
    if (panel.lookAt) light.lookAt(new THREE.Vector3(...panel.lookAt));
    room.add(light);
  }
  return room;
}

function disposeRoom(room: THREE.Scene): void {
  room.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | undefined;
    if (material) material.dispose();
  });
}

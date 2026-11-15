/**
 * Phase 3 gate: the environment asset ladder.
 *
 * The claim under test is that a scene is *always* lit, and that "better
 * lighting" is never bought with an external fetch, a black frame, or a
 * non-deterministic screenshot. Concretely:
 *
 *  1. The switch point names a real, shipped file for each theme.
 *  2. The flat tier and any non-browser context stay on the procedural room.
 *  3. A failed fetch resolves to null instead of throwing, and the caller
 *     keeps what it already has — the ladder has a floor, not a cliff.
 *  4. Every URL is same-origin under /env/, so an offline install still lights.
 *  5. The ladder is documented where someone will look for it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  buildEnvironment,
  environmentCacheSize,
  environmentIntensity,
  environmentSource,
  loadHdriEnvironment,
} from "@/lib/scene/environment";

const PUBLIC_ENV = join(process.cwd(), "public/env");

describe("environment ladder — the shipped HDRI is real and reachable", () => {
  it("names a file that exists, for every theme", () => {
    for (const theme of ["dark", "light"] as const) {
      const source = environmentSource(theme, 256);
      expect(source.kind).toBe("hdri");
      if (source.kind !== "hdri") continue;
      // Same-origin and inside /env: no external host, ever.
      expect(source.url.startsWith("/env/")).toBe(true);
      expect(source.url).not.toMatch(/^https?:/);
      const file = join(PUBLIC_ENV, source.url.replace("/env/", ""));
      expect(existsSync(file)).toBe(true);
      // A stub or an LFS pointer would "exist" and still decode to noise, so
      // require a plausible byte size.
      expect(statSync(file).size).toBeGreaterThan(50_000);
      expect(source.credit).toMatch(/CC0/);
    }
  });

  it("uses a different map per theme, so the lighting agrees with the theme", () => {
    const dark = environmentSource("dark", 256);
    const light = environmentSource("light", 256);
    expect(dark.kind === "hdri" && light.kind === "hdri" && dark.url).not.toBe(light.kind === "hdri" ? light.url : "");
  });
});

describe("environment ladder — the floor is procedural, never black", () => {
  it("stays procedural on the flat tier, which has no WebGL to reflect into", () => {
    for (const theme of ["dark", "light"] as const) {
      const source = environmentSource(theme, 0);
      expect(source.kind).toBe("procedural");
      if (source.kind !== "procedural") continue;
      expect(source.reason).toMatch(/flat tier/);
      expect(buildEnvironment(theme, 0, {} as never)).toBeNull();
    }
  });

  it("stays procedural in a non-browser context rather than guessing", () => {
    // jsdom defines window, so the SSR guard is exercised through the loader
    // directly: there is no renderer and no document-backed canvas.
    expect(buildEnvironment("dark", 256, {} as never)).toBeNull();
  });

  it("resolves to null — not a throw — when the HDRI cannot be fetched", async () => {
    // The offline / self-hosted-without-assets case, exercised through the real
    // production decoder in a plain node process: there is no document, so the
    // decode rejects and the caller must swallow it. If this rejected instead,
    // the scene would end up on the procedural room *and* spam an unhandled
    // rejection; if a caller assumed a resolved value it would null the
    // environment and leave the scene black.
    const result = await loadHdriEnvironment(
      { kind: "hdri", url: "/env/definitely-not-here_1k.hdr", credit: "test" },
      256,
      {} as never,
    );
    expect(result).toBeNull();
  });

  it("caches no entry for a failed load, so nothing downstream can read a hole", async () => {
    // The cache must never hold a null or a half-built texture: a later mount
    // that hits the cache would hand a broken environment to the scene.
    const before = environmentCacheSize();
    await loadHdriEnvironment({ kind: "hdri", url: "/env/still-not-here_1k.hdr", credit: "test" }, 256, {} as never);
    expect(environmentCacheSize()).toBe(before);
  });
});

describe("environment ladder — the energy is tuned, not inherited", () => {
  it("dials the HDRI down relative to the procedural room", () => {
    // A photographic map carries far more energy than the hand-tuned panels.
    // Applying the same intensity would blow out the dark theme.
    const procedural: ReturnType<typeof environmentSource> = {
      kind: "procedural",
      reason: "test",
    };
    expect(environmentIntensity("dark", procedural)).toBe(1);
    for (const theme of ["dark", "light"] as const) {
      const source = environmentSource(theme, 256);
      if (source.kind !== "hdri") continue;
      expect(environmentIntensity(theme, source)).toBeLessThan(1);
      expect(environmentIntensity(theme, source)).toBeGreaterThan(0);
    }
    // The dark theme's night map needs more restraint than the light theme's
    // bright studio, or the DOM text tokens stop being the contrast authority.
    const dark = environmentSource("dark", 256);
    const light = environmentSource("light", 256);
    if (dark.kind === "hdri" && light.kind === "hdri") {
      expect(environmentIntensity("dark", dark)).toBeLessThan(environmentIntensity("light", light));
    }
  });
});

describe("environment ladder — provenance is recorded", () => {
  it("documents every shipped map in public/env/ATTRIBUTION.md", () => {
    const doc = readFileSync(join(PUBLIC_ENV, "ATTRIBUTION.md"), "utf8");
    expect(doc).toMatch(/CC0/);
    expect(doc).toMatch(/Poly Haven/);
    for (const theme of ["dark", "light"] as const) {
      const source = environmentSource(theme, 256);
      if (source.kind !== "hdri") continue;
      const file = source.url.replace("/env/", "");
      expect(doc).toContain(file);
    }
  });
});

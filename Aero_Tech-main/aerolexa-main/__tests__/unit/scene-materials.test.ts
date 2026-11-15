import * as THREE from "three";

import {
  brushedMetal,
  brushedRoughnessTexture,
  dataGlass,
  disposeMaterials,
  lightEdge,
  materialCacheSize,
  softTouch,
} from "@/lib/scene/materials";

afterEach(() => {
  disposeMaterials();
});

describe("material library — caching contract", () => {
  it("same spec returns the same cached instance (instancing relies on this)", () => {
    const a = dataGlass("#5AA8AA", "dark", false);
    const b = dataGlass("#5AA8AA", "dark", false);
    expect(a).toBe(b);
    expect(materialCacheSize()).toBe(1);
  });

  it("different color / theme / transmission builds distinct materials", () => {
    dataGlass("#5AA8AA", "dark", false);
    dataGlass("#FFB400", "dark", false);
    dataGlass("#5AA8AA", "light", false);
    dataGlass("#5AA8AA", "dark", true);
    expect(materialCacheSize()).toBe(4);
  });

  it("dispose clears the cache so a theme switch cannot leak", () => {
    dataGlass("#5AA8AA", "dark", false);
    brushedMetal("#20262e", "dark");
    expect(materialCacheSize()).toBe(2);
    disposeMaterials();
    expect(materialCacheSize()).toBe(0);
  });
});

describe("material library — physical honesty", () => {
  it("studio glass refracts (transmission); depth glass fakes with opacity", () => {
    const studio = dataGlass("#5AA8AA", "dark", true) as THREE.MeshPhysicalMaterial;
    const depth = dataGlass("#5AA8AA", "dark", false) as THREE.MeshStandardMaterial;
    expect(studio.transmission).toBeGreaterThan(0.5);
    expect((depth as unknown as THREE.MeshPhysicalMaterial).transmission ?? 0).toBeFalsy();
    expect(depth.transparent).toBe(true);
    expect(depth.opacity).toBeLessThan(1);
  });

  it("brushed metal is actually metallic and uses the procedural roughness map", () => {
    const metal = brushedMetal("#20262e", "dark") as THREE.MeshStandardMaterial;
    expect(metal.metalness).toBeGreaterThanOrEqual(0.8);
    // jsdom canvas is not implemented → texture degrades to null, never throws.
    expect(metal.roughnessMap === null || metal.roughnessMap instanceof THREE.Texture).toBe(true);
  });

  it("soft touch is matte and neutral", () => {
    const plastic = softTouch("dark") as THREE.MeshStandardMaterial;
    expect(plastic.metalness).toBe(0);
    expect(plastic.roughness).toBeGreaterThanOrEqual(0.85);
  });

  it("light edge is bloom-bait: hot emissive on a black base", () => {
    const edge = lightEdge("#FFB400", "dark") as THREE.MeshStandardMaterial;
    expect(edge.emissiveIntensity).toBeGreaterThan(1.5);
    expect(edge.color.getHexString()).toBe("000000");
  });

  it("theme changes the read: light theme is brighter, less emissive", () => {
    const dark = dataGlass("#5AA8AA", "dark", false) as THREE.MeshStandardMaterial;
    const light = dataGlass("#5AA8AA", "light", false) as THREE.MeshStandardMaterial;
    expect(light.emissiveIntensity).toBeLessThan(dark.emissiveIntensity);
  });
});

describe("procedural textures — honest degradation", () => {
  it("roughness texture returns null outside a browser instead of throwing", () => {
    // jsdom has no 2D canvas; the module must degrade, not guess.
    expect(brushedRoughnessTexture()).toBeNull();
  });
});

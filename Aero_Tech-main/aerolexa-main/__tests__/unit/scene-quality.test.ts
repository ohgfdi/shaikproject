import {
  allowsTransmission,
  downgradeLogSnapshot,
  recordDowngrade,
  resetDowngradeLog,
  scaleCount,
  sceneQuality,
} from "@/lib/scene/quality";
import type { SceneCapability } from "@/lib/scene/tier";

function cap(tier: SceneCapability["tier"]): SceneCapability {
  return {
    tier,
    webgl: tier !== "flat",
    dpr: 2,
    detail: 1,
    effects: tier === "studio",
    shadows: tier === "studio",
    reason: `test-${tier}`,
  };
}

beforeEach(() => {
  resetDowngradeLog();
});

describe("scene quality — knobs per measured tier", () => {
  it("studio: full post stack, real shadows, IBL env, transmission, parallax", () => {
    const q = sceneQuality(cap("studio"));
    expect(q.envResolution).toBeGreaterThanOrEqual(256);
    expect(q.shadowMapSize).toBeGreaterThanOrEqual(1024);
    expect(q.effects).toEqual(["bloom", "smaa", "dof", "ao", "vignette", "grain"]);
    expect(q.transmission).toBe(true);
    expect(q.parallax).toBe(true);
    expect(q.dpr[1]).toBeLessThanOrEqual(2);
    expect(q.detail).toBe(1);
  });

  it("depth: reduced stack — no DoF/AO/shadows/transmission, capped dpr", () => {
    const q = sceneQuality(cap("depth"));
    expect(q.effects).toEqual(["bloom", "vignette"]);
    expect(q.shadowMapSize).toBe(0);
    expect(q.envResolution).toBeLessThan(256);
    expect(q.transmission).toBe(false);
    expect(q.dpr[1]).toBeLessThanOrEqual(1.5);
    expect(q.detail).toBeLessThan(1);
  });

  it("flat: nothing — callers render the 2D fallback", () => {
    const q = sceneQuality(cap("flat"));
    expect(q.effects).toEqual([]);
    expect(q.envResolution).toBe(0);
    expect(q.maxInstances).toBe(0);
    expect(q.parallax).toBe(false);
  });

  it("every tier keeps the effect stack in canonical order", () => {
    const order = ["bloom", "smaa", "dof", "ao", "vignette", "grain"];
    for (const tier of ["studio", "depth", "flat"] as const) {
      const effects = sceneQuality(cap(tier)).effects;
      const positions = effects.map((e) => order.indexOf(e));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("instance budget never exceeds the tier maximum", () => {
    expect(sceneQuality(cap("studio")).maxInstances).toBe(2048);
    expect(sceneQuality(cap("depth")).maxInstances).toBeLessThan(sceneQuality(cap("studio")).maxInstances);
  });

  it("live tier drives the knobs: a downgraded studio renders depth quality", () => {
    // The SceneCanvas composes quality from the measured capability with the
    // live (possibly downgraded) tier. The primitive it relies on:
    const downgraded = sceneQuality({ ...cap("studio"), tier: "depth" });
    expect(downgraded.effects).toEqual(["bloom", "vignette"]);
    expect(downgraded.shadowMapSize).toBe(0);
  });
});

describe("scene quality — runtime downgrade", () => {
  it("downgrades strictly one rung and never re-upgrades", () => {
    expect(recordDowngrade("studio", 24).tier).toBe("depth");
    expect(recordDowngrade("depth", 18).tier).toBe("flat");
    expect(recordDowngrade("flat", 0).tier).toBe("flat");
  });

  it("records why, for the quality scoreboard", () => {
    recordDowngrade("studio", 24);
    const log = resetAndSnapshot();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from: "studio", to: "depth", fps: 24 });
  });

  it("keeps the log bounded (telemetry, not an audit trail)", () => {
    for (let i = 0; i < 60; i++) recordDowngrade("studio", i);
    expect(resetAndSnapshot().length).toBeLessThanOrEqual(50);
  });
});

function resetAndSnapshot() {
  const log = [...downgradeLogSnapshot()];
  resetDowngradeLog();
  return log;
}

describe("scene quality — count scaling", () => {
  const studio = sceneQuality(cap("studio"));
  const depth = sceneQuality(cap("depth"));

  it("scales scene detail by tier ratio", () => {
    expect(scaleCount(100, studio)).toBe(100);
    expect(scaleCount(100, depth)).toBe(60);
  });

  it("never returns zero or negative — a scene always has at least one object", () => {
    expect(scaleCount(0, studio)).toBe(1);
    expect(scaleCount(1, depth)).toBe(1);
  });

  it("is deterministic — same inputs, same count (screenshot diffs rely on this)", () => {
    expect(scaleCount(37, depth)).toBe(scaleCount(37, depth));
  });

  it("returns integers", () => {
    expect(Number.isInteger(scaleCount(101, depth))).toBe(true);
  });
});

describe("scene quality — transmission gate", () => {
  it("frosted glass is a studio-only luxury", () => {
    expect(allowsTransmission(sceneQuality(cap("studio")))).toBe(true);
    expect(allowsTransmission(sceneQuality(cap("depth")))).toBe(false);
    expect(allowsTransmission(sceneQuality(cap("flat")))).toBe(false);
  });
});

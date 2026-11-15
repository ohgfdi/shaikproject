/**
 * The 3D honesty gate, run against the production build.
 *
 * Measurements for the plan's scoreboard (docs/quality-baseline.md):
 *  1. Flat tier renders ZERO canvases (reduced-motion / no-GPU honesty).
 *  2. The persisted tier override (localStorage "aerolexa:tier") actually
 *     forces studio/depth/flat behaviour — the scene inspector's foundation.
 *  3. Sustained fps, sampled over a real interval, at or above the depth bar.
 *  4. Draw-call and heap budgets per tier (S2.3).
 *
 * Failures here mean a regression ships to users — assertions never relax.
 */
import { expect, test } from "@playwright/test";

interface PerformanceMetrics {
  drawCalls: number;
  heapMB: number;
}

async function sampleFps(page: import("@playwright/test").Page, ms: number): Promise<number> {
  return page.evaluate((duration) => {
    return new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start >= duration) {
          resolve((frames / duration) * 1000);
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }, ms);
}

async function samplePerformanceMetrics(
  page: import("@playwright/test").Page,
  durationMs: number,
): Promise<PerformanceMetrics> {
  return page.evaluate((duration) => {
    return new Promise<PerformanceMetrics>((resolve) => {
      let maxDrawCalls = 0;
      let maxHeapMB = 0;
      const start = performance.now();

      const tick = async () => {
        // Real renderer info first (SceneCanvas onCreated attaches the
        // three.js WebGLRenderer to its own canvas as __sceneGl); fall
        // back to any R3F-attached renderer on other canvases.
        const canvases = Array.from(document.querySelectorAll("canvas")) as (HTMLCanvasElement & {
          __sceneGl?: { info?: { render?: { calls?: number } } };
          __r3f?: { gl?: { info?: { render?: { calls?: number } } } };
        })[];
        for (const canvas of canvases) {
          const renderer = canvas.__sceneGl ?? canvas.__r3f?.gl;
          const calls = renderer?.info?.render?.calls;
          if (typeof calls === "number") {
            maxDrawCalls = Math.max(maxDrawCalls, calls);
          }
        }

        // Get heap size
        const perf = performance as Performance & {
          memory?: { usedJSHeapSize: number };
        };
        if (perf.memory?.usedJSHeapSize) {
          maxHeapMB = Math.max(maxHeapMB, perf.memory.usedJSHeapSize / (1024 * 1024));
        }

        if (performance.now() - start < duration) {
          requestAnimationFrame(tick);
        } else {
          resolve({ drawCalls: maxDrawCalls, heapMB: maxHeapMB });
        }
      };
      requestAnimationFrame(tick);
    });
  }, durationMs);
}

const DRAW_CALL_BUDGETS = {
  studio: { maxDrawCalls: 100, maxHeapMB: 250 },
  depth: { maxDrawCalls: 40, maxHeapMB: 150 },
  flat: { maxDrawCalls: 0, maxHeapMB: 0 },
} as const;

function assertBudget(
  tier: keyof typeof DRAW_CALL_BUDGETS,
  metrics: PerformanceMetrics,
): { pass: boolean; message: string } {
  const budget = DRAW_CALL_BUDGETS[tier];
  const drawCallOk = metrics.drawCalls <= budget.maxDrawCalls;
  const heapOk = metrics.heapMB <= budget.maxHeapMB;

  if (!drawCallOk && !heapOk) {
    return {
      pass: false,
      message: `Tier ${tier}: draw calls ${metrics.drawCalls} > ${budget.maxDrawCalls} AND heap ${metrics.heapMB.toFixed(1)}MB > ${budget.maxHeapMB}MB`,
    };
  }
  if (!drawCallOk) {
    return {
      pass: false,
      message: `Tier ${tier}: draw calls ${metrics.drawCalls} > ${budget.maxDrawCalls}`,
    };
  }
  if (!heapOk) {
    return {
      pass: false,
      message: `Tier ${tier}: heap ${metrics.heapMB.toFixed(1)}MB > ${budget.maxHeapMB}MB`,
    };
  }
  return {
    pass: true,
    message: `Tier ${tier}: draw calls ${metrics.drawCalls}/${budget.maxDrawCalls}, heap ${metrics.heapMB.toFixed(1)}MB/${budget.maxHeapMB}MB`,
  };
}

/**
 * Waits for the environment ladder to settle before a screenshot.
 *
 * `data-scene-env` is set by SceneEnvironment on <html>: "pending" means an HDRI
 * is still decoding, "procedural" or "hdri" are final, "none" means the tier
 * asked for no environment. Blind `waitForTimeout` is how a screenshot spec
 * starts comparing before the lighting has arrived — and because the HDRI swap
 * is async, that flake would only ever show up as "the baseline is unstable".
 *
 * The budget is generous on purpose: CI runs Chromium on software GL
 * (SwiftShader), where decoding a 1K .hdr and running PMREM over it is orders
 * of magnitude slower than on any real GPU. A tight timeout here would produce
 * flakes that look like render regressions.
 */
async function waitForEnvironment(page: import("@playwright/test").Page, timeout = 90_000) {
  await page
    .locator(`html[data-scene-env="procedural"], html[data-scene-env="hdri"]`)
    .first()
    .waitFor({ state: "attached", timeout });
}

test.describe("scene honesty gates", () => {
  test("flat tier: prefers-reduced-motion renders zero WebGL canvases", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Decorative scenes must vanish entirely — not dim, not pause. Vanish.
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("tier override: localStorage 'aerolexa:tier=flat' forces the flat tier", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "flat");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("tier override: 'aerolexa:tier=studio' allows the scene to mount", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    await page.goto("/");
    // Headless chromium reports WebGL here; the hero canvas should exist.
    // If WebGL is unavailable the page must still be complete and canvas-free
    // — the honest fallback — so this assertion is conditional by design.
    await page.waitForLoadState("networkidle");
    const hasWebGL = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return false;
      (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
      return true;
    });
    if (hasWebGL) {
      await expect(page.locator("canvas").first()).toBeVisible();
    }
  });

  test("hero fps: sampling window records fps at or above the depth bar", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800); // first frames are always the slow ones
    const fps = await sampleFps(page, 3000);
    console.log(`[scene] hero fps over 3s: ${fps.toFixed(1)}`);
    // Headless CI chromium without a GPU sits at the depth bar; real browsers
    // on studio hardware have huge headroom. Assert the honest floor.
    expect(fps).toBeGreaterThanOrEqual(30);
  });

  test("auth page fps: ambient scene stays above the depth bar", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const fps = await sampleFps(page, 2000);
    console.log(`[scene] auth fps over 2s: ${fps.toFixed(1)}`);
    expect(fps).toBeGreaterThanOrEqual(30);
  });
});

test.describe("scene performance budgets (S2.3)", () => {
  test("studio tier: hero scene stays within draw-call and heap budgets", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const metrics = await samplePerformanceMetrics(page, 3000);
    const result = assertBudget("studio", metrics);
    console.log(`[scene] ${result.message}`);
    expect(result.pass).toBe(true);
  });

  test("depth tier: hero scene stays within draw-call and heap budgets", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "depth");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const metrics = await samplePerformanceMetrics(page, 3000);
    const result = assertBudget("depth", metrics);
    console.log(`[scene] ${result.message}`);
    expect(result.pass).toBe(true);
  });

  test("flat tier: zero canvases and zero draw calls from 3D", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "flat");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Honesty contract, draw-call scoped: no canvas may exist and no scene
    // draw call may fire. Heap is NOT asserted here — `performance.memory` is
    // a page-global metric (the whole app allocates, not just the 3D), so a
    // flat page can never read 0. The scene-scoped budgets (studio/depth)
    // above are where heap belongs.
    await expect(page.locator("canvas")).toHaveCount(0);
    const metrics = await samplePerformanceMetrics(page, 1000);
    console.log(
      `[scene] flat tier: draw calls ${metrics.drawCalls} (budget 0), page heap ${metrics.heapMB.toFixed(1)}MB (page-global, not scene-scoped)`,
    );
    expect(metrics.drawCalls).toBe(0);
  });
});

test.describe("scene visual regression (screenshot-diff)", () => {
  test("studio tier: hero scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Wait for scene to stabilize (deterministic seed = 42 for hero skyline)
    await page.waitForTimeout(2000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("hero-studio.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test("depth tier: hero scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "depth");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("hero-depth.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test("studio tier: auth ambient scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("auth-studio.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test("depth tier: auth ambient scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "depth");
    });
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("auth-depth.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test("studio tier: onboarding ambient scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    await page.goto("/onboarding");
    await page.waitForLoadState("networkidle");
    await waitForEnvironment(page);
    // One extra beat past the environment settling: the ambient scene is
    // idle-deferred, so it mounts after the wizard's own first paint.
    await page.waitForTimeout(1000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("onboarding-studio.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test("depth tier: onboarding ambient scene matches baseline", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "depth");
    });
    await page.goto("/onboarding");
    await page.waitForLoadState("networkidle");
    await waitForEnvironment(page);
    await page.waitForTimeout(1000);
    await expect(page.locator("canvas").first()).toHaveScreenshot("onboarding-depth.png", {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});

test.describe("the environment ladder upgrades, and never blanks the scene", () => {
  test("onboarding settles on a real environment, not on the fallback", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    // Prove the rung: assert the *request* was made and served from our own
    // origin. A map that silently 404s would leave the scene lit by the
    // procedural room, which looks fine and is therefore easy to ship broken.
    const hdriRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/env/")) hdriRequests.push(request.url());
    });
    await page.goto("/onboarding");
    await page.waitForLoadState("networkidle");
    await waitForEnvironment(page);
    expect(hdriRequests.length).toBeGreaterThan(0);
    for (const url of hdriRequests) {
      // Same-origin only: an offline/self-hosted install must never reach out.
      expect(url.startsWith("http://localhost:3000/env/")).toBe(true);
    }
    const settled = await page.locator("html").getAttribute("data-scene-env");
    // "hdri" once decoded; "procedural" only if the decode genuinely failed, in
    // which case the scene must still be lit. Either is honest; "pending" is not.
    expect(["hdri", "procedural"]).toContain(settled);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("a missing HDRI leaves the scene lit instead of black", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "studio");
    });
    // The self-hosted-without-assets case: the map 404s, and the scene must
    // fall back to the procedural room rather than rendering nothing.
    await page.route("**/env/*.hdr", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/onboarding");
    await page.waitForLoadState("networkidle");
    await page.locator('html[data-scene-env="procedural"]').first().waitFor({ state: "attached" });
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("the flat tier asks for no environment at all", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aerolexa:tier", "flat");
    });
    const hdriRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/env/")) hdriRequests.push(request.url());
    });
    await page.goto("/onboarding");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("canvas")).toHaveCount(0);
    // No canvas means no IBL, so no 1.5 MB HDRI download on a device that
    // cannot render it.
    expect(hdriRequests).toEqual([]);
  });
});

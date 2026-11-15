/**
 * S10 — device-lab matrix.
 *
 * Runs the honesty gates against emulated mobile profiles (iOS Safari,
 * Android Chrome). Skipped entirely unless the "device-lab" Playwright
 * project is selected (`npm run test:e2e:device-lab`), so the default
 * desktop suite stays fast.
 *
 * What is asserted per device:
 *  - Reduced motion ⇒ zero canvases (tier honesty is device-independent).
 *  - Forced studio ⇒ canvas mounts iff the emulated browser has WebGL.
 *  - The page never crashes: primary landmark remains visible.
 */
import { devices, expect, test } from "@playwright/test";

const useDeviceLab = process.env.DEVICE_LAB === "1";
const maybe = useDeviceLab ? test.describe : test.describe.skip;

const DEVICE_PROFILES = [
  { name: "iPhone 14 Safari", descriptor: devices["iPhone 13"] },
  { name: "Pixel 7 Chrome", descriptor: devices["Pixel 5"] },
] as const;

for (const profile of DEVICE_PROFILES) {
  maybe(`device lab: ${profile.name}`, () => {
    test.use({ ...profile.descriptor });

    test("reduced motion renders zero canvases", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("canvas")).toHaveCount(0);
      await expect(page.locator("main")).toBeVisible();
    });

    test("forced studio mounts canvas iff WebGL exists", async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem("aerolexa:tier", "studio");
      });
      await page.goto("/");
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
      } else {
        await expect(page.locator("canvas")).toHaveCount(0);
      }
      await expect(page.locator("main")).toBeVisible();
    });
  });
}

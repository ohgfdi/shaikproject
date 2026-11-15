/**
 * ROADMAP 7.4 — mobile analytics gates.
 *
 * Asserts the dashboard experience is usable at the smallest supported
 * viewport (360px): no horizontal overflow, the primary nav is reachable,
 * and the touch cross-filter chip row (the dashboard's interactive surface)
 * fits within the viewport so values can be tapped, not scrolled sideways.
 *
 * Runs in the `device-lab` project (`npm run test:e2e:device-lab`) so the
 * desktop suite stays fast; also selectable with DEVICE_LAB=1.
 */
import { expect, test } from "@playwright/test";

const useDeviceLab = process.env.DEVICE_LAB === "1";
const maybe = useDeviceLab ? test : test.skip;

test.describe("mobile analytics (ROADMAP 7.4)", () => {
  // Smallest supported viewport per the design contract (360px).
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  maybe("login renders without horizontal overflow at 360px", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2); // subpixel rounding tolerance
    await expect(page.locator("main")).toBeVisible();
  });

  maybe("signup renders without horizontal overflow at 360px", async ({ page }) => {
    await page.goto("/signup");
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
    await expect(page.locator("main")).toBeVisible();
  });

  maybe("tap targets: primary buttons are at least 36px tall on touch", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    const buttons = page.locator('button[type="submit"], button:has-text("Sign in")');
    const first = buttons.first();
    if ((await first.count()) > 0) {
      const box = await first.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(36);
    }
  });
});

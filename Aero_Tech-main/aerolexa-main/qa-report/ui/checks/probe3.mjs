import { chromium } from "playwright";
import { BASE_URL, login } from "./lib.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await login(context);
const page = await context.newPage();
await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.locator('button[aria-label="Toggle sidebar"]').first().click();
await page.waitForTimeout(600);
console.log(
  JSON.stringify(
    await page.evaluate(() =>
      [...document.querySelectorAll("aside")].map((a) => {
        const r = a.getBoundingClientRect();
        const s = getComputedStyle(a);
        return {
          cls: a.className.slice(0, 60),
          display: s.display,
          vis: s.visibility,
          w: r.width,
          h: r.height,
          x: r.x,
          y: r.y,
          parent: a.parentElement?.className.slice(0, 80),
        };
      }),
    ),
    null,
    1,
  ),
);
await browser.close();

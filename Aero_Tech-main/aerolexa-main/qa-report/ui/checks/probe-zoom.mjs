import { chromium } from "playwright";
import { BASE_URL, newContext } from "./lib.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await newContext(browser, {
  viewport: { width: 720, height: 900 },
  colorScheme: "dark",
  deviceScaleFactor: 2,
});
const p = await ctx.newPage();
await p.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
await p.waitForTimeout(400);
console.log(
  JSON.stringify(
    await p.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Open navigation menu"]');
      return {
        innerWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        btnFound: !!btn,
        btnDisplay: btn ? getComputedStyle(btn).display : null,
        btnRect: btn ? btn.getBoundingClientRect().toJSON() : null,
        asideDisplay: document.querySelector("aside")
          ? getComputedStyle(document.querySelector("aside")).display
          : null,
      };
    }),
    null,
    1,
  ),
);
await browser.close();

import { chromium } from "playwright";
import { BASE_URL, newContext } from "./lib.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, colorScheme: "dark" });
const p = await ctx.newPage();
await p.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
const trigger = p.locator('button[aria-label="Open navigation menu"]');
await trigger.click();
await p.waitForTimeout(300);
for (let i = 0; i < 12; i += 1) {
  await p.keyboard.press("Tab");
  const info = await p.evaluate(() => {
    const el = document.activeElement;
    return `${el?.tagName}:${(el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 18)}${el?.closest('[role="dialog"]') ? "" : " [OUTSIDE]"}`;
  });
  console.log(i, info);
}
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
console.log(
  "after esc:",
  await trigger.getAttribute("aria-expanded"),
  "dialogs:",
  await p.locator('[role="dialog"]').count(),
  "url:",
  p.url(),
);
await trigger.click();
await p.waitForTimeout(400);
console.log(
  "reopened:",
  await p.locator('[role="dialog"]').count(),
  await trigger.getAttribute("aria-expanded"),
  "url:",
  p.url(),
);
await browser.close();

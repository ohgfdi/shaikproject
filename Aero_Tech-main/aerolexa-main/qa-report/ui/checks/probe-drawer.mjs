import { chromium } from "playwright";
import { BASE_URL, newContext } from "./lib.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, colorScheme: "dark" });
const p = await ctx.newPage();
await p.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
const trigger = p.locator('button[aria-label="Open navigation menu"]');
console.log("closed expanded:", await trigger.getAttribute("aria-expanded"));
await trigger.click();
await p.waitForTimeout(300);
console.log("open expanded:", await trigger.getAttribute("aria-expanded"));
console.log("dialog count:", await p.locator('[role="dialog"]').count());
console.log("books links in dialog:", await p.locator('[role="dialog"] a[href="/books"]').count());
console.log(
  "all hrefs in dialog:",
  (await p.locator('[role="dialog"] a').evaluateAll((els) => els.map((e) => e.getAttribute("href")))).join(","),
);
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
console.log(
  "after escape expanded:",
  await trigger.getAttribute("aria-expanded"),
  "dialog:",
  await p.locator('[role="dialog"]').count(),
  "inert:",
  await p.evaluate(() => document.getElementById("app-content")?.hasAttribute("inert")),
);
await trigger.click();
await p.waitForTimeout(400);
console.log("reopened:", await p.locator('[role="dialog"]').count(), await trigger.getAttribute("aria-expanded"));
await browser.close();

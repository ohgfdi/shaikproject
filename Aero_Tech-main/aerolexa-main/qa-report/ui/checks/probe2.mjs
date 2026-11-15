import { chromium } from "playwright";
import { BASE_URL, login } from "./lib.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await login(context);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE_ERR", m.text().slice(0, 300));
});
await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
console.log(
  "before",
  await page.evaluate(() => ({
    asides: document.querySelectorAll("aside").length,
    main: !!document.querySelector("main"),
    bodyLen: document.body.innerHTML.length,
  })),
);
await page.locator('button[aria-label="Toggle sidebar"]').first().click();
await page.waitForTimeout(800);
console.log(
  "after",
  await page.evaluate(() => ({
    asides: document.querySelectorAll("aside").length,
    main: !!document.querySelector("main"),
    bodyLen: document.body.innerHTML.length,
    inputs: document.querySelectorAll("aside input").length,
    html: document.body.innerHTML.slice(0, 300),
  })),
);
await browser.close();

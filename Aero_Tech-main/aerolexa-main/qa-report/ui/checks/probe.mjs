import { chromium } from "playwright";
import { BASE_URL, login } from "./lib.mjs";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await login(context);
const page = await context.newPage();
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const dump = await page.evaluate(() => {
  const aside = document.querySelector("aside");
  const labels = aside
    ? [...aside.querySelectorAll("a,summary,span")]
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent || "").trim().slice(0, 40),
          leaf: el.children.length === 0,
          visible: el.getBoundingClientRect().height > 0,
        }))
        .filter((x) => x.visible && x.text)
    : [];
  return { aside: aside?.outerHTML.slice(0, 1500), labelCount: labels.length, labels: labels.slice(0, 40) };
});
console.log("ASIDE", dump.aside);
console.log("LABELS", JSON.stringify(dump.labels, null, 1));
console.log("URL", page.url());
await page.screenshot({ path: "qa-report/ui/evidence/probe-1440.png" });
const toggles = await page.locator("aside button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
console.log("ASIDE BUTTONS", toggles);
await page.locator('button[aria-label="Toggle sidebar"]').first().click();
await page.waitForTimeout(400);
console.log("AFTER TOGGLE url", page.url());
console.log(
  "AFTER TOGGLE asides",
  await page.locator("aside").count(),
  "bodytext",
  (await page.locator("body").innerText()).slice(0, 200),
);
await page.screenshot({ path: "qa-report/ui/evidence/probe-after-toggle.png" });
await browser.close();

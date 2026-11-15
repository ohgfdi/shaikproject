// Negative controls: run the same measurements the AFTER verification uses,
// against the unmodified app. A check that cannot fail proves nothing.
import { chromium } from "playwright";
import { BASE_URL, login, saveJson } from "./lib.mjs";
import { measureShell } from "./measure.mjs";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await login(context);
const page = await context.newPage();
const out = { at: new Date().toISOString(), baseUrl: BASE_URL, widths: {} };

for (const width of [1440, 768, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const closed = await page.evaluate(measureShell);
  await page
    .locator('button[aria-label="Open menu"], button[aria-label="Toggle sidebar"]')
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(500);
  const open = await page.evaluate(measureShell);
  out.widths[width] = { closed, open };
}

// Reduced-motion computed transition.
const rm = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  colorScheme: "dark",
});
await login(rm);
const rmPage = await rm.newPage();
await rmPage.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
out.reducedMotion = await rmPage.evaluate(() => {
  const aside = document.querySelector("aside");
  if (!aside) return null;
  const s = getComputedStyle(aside);
  return { transitionDuration: s.transitionDuration, transitionProperty: s.transitionProperty };
});

saveJson("evidence/CONTROLS-BEFORE.json", out);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(out.widths).map(([w, v]) => [
        w,
        {
          closed: {
            asides: v.closed.asides,
            sidebarNavCount: v.closed.sidebarNavCount,
            navTotal: v.closed.navTotal,
            duplicateLabels: v.closed.duplicateLabels.length,
            sidebarScroll: [v.closed.sidebarScrollWidth, v.closed.sidebarClientWidth],
            docScroll: [v.closed.docScrollWidth, v.closed.docClientWidth],
            sidebarInputs: v.closed.sidebarInputs,
            groupHeadings: v.closed.groupHeadings,
            headerSearchCount: v.closed.headerSearchCount,
            locale: [v.closed.lang, v.closed.localeValue],
            overlaps: v.closed.overlaps.length,
          },
          open: { asides: v.open.asides, sidebarNavCount: v.open.sidebarNavCount, sidebarInputs: v.open.sidebarInputs },
        },
      ]),
    ),
    null,
    2,
  ),
);
await browser.close();

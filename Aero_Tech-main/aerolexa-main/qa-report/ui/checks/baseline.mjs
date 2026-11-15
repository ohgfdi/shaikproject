// Phase 0 — BEFORE baseline. Captures screenshots, sidebar DOM, landmark counts,
// duplicate labels and a route inventory straight from the filesystem.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { BASE_URL, EMAIL, OUT, ROOT, login, saveJson, setSidebarState } from "./lib.mjs";

const PAGES = ["dashboard", "analyses", "reports", "settings"];
const WIDTHS = [1440, 768, 390];

function markOnboarded() {
  const db = new Database(path.join(ROOT, "data/aerolexa.db"));
  db.prepare("update User set onboardedAt = ? where email = ?").run(new Date().toISOString(), EMAIL);
  db.close();
}

function routeInventory() {
  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const rel = path.relative(path.join(ROOT, "app"), full).replace(/\/?page\.tsx$/, "");
        routes.push("/" + rel.replace(/\([^)]*\)\//g, "").replace(/\([^)]*\)/g, ""));
      }
    }
  };
  walk(path.join(ROOT, "app"));
  return routes.map((r) => (r === "/" ? "/" : r.replace(/\/$/, ""))).sort();
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await login(context);
markOnboarded();

const page = await context.newPage();
const result = { capturedAt: new Date().toISOString(), baseUrl: BASE_URL, widths: {}, routes: routeInventory() };

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  const widthData = { states: {} };
  for (const state of ["expanded", "after-toggle-controls"]) {
    if (state === "after-toggle-controls") {
      // BEFORE has no collapse contract. Exercise both controls that claim to
      // change the sidebar so the artifact shows what they actually do.
      const menu = page.locator('button[aria-label="Toggle sidebar"]').first();
      if (await menu.count()) await menu.click().catch(() => {});
      const collapse = page.locator('button[aria-label="Collapse sidebar"]').first();
      if (await collapse.count()) await collapse.click().catch(() => {});
    }
    const shots = {};
    for (const route of PAGES) {
      await page.goto(`${BASE_URL}/${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(350);
      const file = `before/${route}-${width}-${state}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: false });
      shots[route] = file;
    }
    // Dump the sidebar DOM once per width/state (dashboard).
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    const metrics = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const asides = [...document.querySelectorAll("aside")].filter(visible);
      const sidebar = asides[0] ?? null;
      const navs = [...document.querySelectorAll("nav")].filter(visible);
      const sidebarNavs = sidebar ? [...sidebar.querySelectorAll("nav")].filter(visible) : [];
      const labels = sidebar
        ? [...sidebar.querySelectorAll("a, summary, span")]
            .filter((el) => visible(el) && el.children.length === 0)
            .map((el) => (el.textContent || "").trim())
            .filter(Boolean)
        : [];
      const counts = {};
      for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
      return {
        asideCount: asides.length,
        asides: asides.map((a) => ({
          width: Math.round(a.getBoundingClientRect().width),
          left: Math.round(a.getBoundingClientRect().left),
          className: a.className,
        })),
        navTotal: navs.length,
        navLabels: navs.map((n) => n.getAttribute("aria-label")),
        sidebarNavCount: sidebarNavs.length,
        sidebarScrollWidth: sidebar?.scrollWidth ?? null,
        sidebarClientWidth: sidebar?.clientWidth ?? null,
        duplicates: Object.entries(counts)
          .filter(([, n]) => n > 1)
          .map(([label, n]) => ({ label, count: n })),
        sidebarHtmlLength: sidebar?.outerHTML.length ?? 0,
      };
    });
    if (state === "expanded" || width === 1440) {
      const html = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
        };
        const aside = [...document.querySelectorAll("aside")].filter(visible)[0];
        return aside ? aside.outerHTML : "(no visible aside)";
      });
      const file = `before/sidebar-dom-${width}.html`;
      fs.mkdirSync(path.join(OUT, "before"), { recursive: true });
      fs.writeFileSync(path.join(OUT, file), `<!-- captured ${new Date().toISOString()} at ${width}px -->\n${html}`);
    }
    widthData.states[state] = { shots, metrics };
  }
  result.widths[width] = widthData;
}

// Sidebar search evidence: click the control labelled "Toggle sidebar" from the
// default state and record whether an input appears over the rail.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
await page
  .locator('button[aria-label="Toggle sidebar"]')
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(250);
result.sidebarSearchInputs = await page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return [...document.querySelectorAll("aside input")].filter(visible).map((el) => {
    const r = el.getBoundingClientRect();
    return { placeholder: el.getAttribute("placeholder"), box: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
});
await page.screenshot({ path: path.join(OUT, "before/sidebar-search-overlap-1440.png") });

saveJson("evidence/BASELINE.json", result);
await browser.close();

const db = new Database(path.join(ROOT, "data/aerolexa.db"));
db.prepare("update User set onboardedAt = ? where email = ?").run(new Date().toISOString(), EMAIL);
db.close();
console.log(
  JSON.stringify(
    {
      ok: true,
      widths: Object.keys(result.widths),
      duplicates: result.widths[1440].states.expanded.metrics.duplicates,
    },
    null,
    2,
  ),
);

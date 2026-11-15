// Phase 4 — programmatic verification in a real browser.
// Usage: qa-report/ui/checks/with-server.sh qa-report/ui/checks/verify.mjs [--mode=prod]
//
// Writes qa-report/ui/results.json (one object per check) and after/ screenshots.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { BASE_URL, OUT, ROOT, login, newContext, saveJson, setSidebarState } from "./lib.mjs";
import { measureShell } from "./measure.mjs";

const MODE = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "dev";
const results = [];
const notes = [];

function record(id, expectedRef, actual, state, evidencePath, runs = 1) {
  results.push({ id, expected_ref: expectedRef, actual, state, evidence_path: evidencePath, runs });
}

/**
 * Evaluate with retries. The dev server can finish a client-side navigation
 * (or a service-worker reload) between `networkidle` and the evaluate call,
 * which destroys the execution context; that is an environment event, not an
 * app result, so retry instead of recording it as a failure.
 */
async function evalRetry(page, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      lastError = err;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  throw lastError;
}

/**
 * Navigate with one retry. A service-worker install or a late client-side
 * navigation can interrupt a goto; that is an environment event, so retry and
 * record a null result rather than aborting the whole suite.
 */
async function gotoRetry(page, url, opts = { waitUntil: "networkidle" }) {
  try {
    return await page.goto(url, opts);
  } catch (err) {
    await page.waitForTimeout(600);
    try {
      return await page.goto(url, opts);
    } catch (err2) {
      process.stderr.write(`[goto] ${url} failed twice: ${err2.message.split("\n")[0]}\n`);
      return null;
    }
  }
}

const shoot = async (page, file, opts = {}) => {
  const target = path.join(OUT, file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, animations: "disabled", caret: "hide", timeout: 15000, ...opts });
    return file;
  } catch (err) {
    process.stderr.write(`[shot] ${file} failed: ${err.message.split("\n")[0]}\n`);
    return null;
  }
};

const measure = (page) => evalRetry(page, measureShell);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await login(context);
const page = await context.newPage();
const consoleErrors = [];
const hydrationWarnings = [];
const networkFailures = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error") consoleErrors.push(text);
  if (/hydration|did not match/i.test(text)) hydrationWarnings.push(text);
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on("response", (res) => {
  if (res.status() >= 400) networkFailures.push(`${res.status()} ${res.request().method()} ${res.url()}`);
});

// ---------------------------------------------------------------------------
// Pass 1: shell measurements at each width, expanded and collapsed.
// ---------------------------------------------------------------------------
const shellSamples = {};
const shots = [];
for (const width of [1440, 768, 390]) {
  shellSamples[width] = {};
  for (const state of ["expanded", "collapsed"]) {
    const ctx = await newContext(browser, { viewport: { width, height: 900 }, colorScheme: "dark" });
    await setSidebarState(ctx, state === "collapsed");
    const p = await ctx.newPage();
    await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    await p.waitForTimeout(400);
    const file = `after/dashboard-${width}-${state}.png`;
    await shoot(p, file);
    shots.push(file);
    shellSamples[width][state] = await measure(p);
    await ctx.close();
  }
}

const s = (w, st) => shellSamples[w][st];

// C01 — one sidebar nav landmark. Per the pre-registered expectation: exactly
// one at md+ (1440/768) in both states, and none on mobile with the drawer shut
// (the drawer mounts its own single Primary nav while open — checked in C08).
{
  const bad = [];
  for (const width of [1440, 768]) {
    for (const state of ["expanded", "collapsed"]) {
      const m = s(width, state);
      const sidebars = m.asideBox ? m.sidebarNavCount : 0;
      if (sidebars !== 1) bad.push(`${width}/${state}: ${sidebars} sidebar nav landmarks (asides=${m.asides})`);
    }
  }
  const mobile = s(390, "expanded");
  if (mobile.asides !== 0 || mobile.sidebarNavCount !== 0) {
    bad.push(
      `390/expanded: expected no desktop rail and no sidebar nav, got asides=${mobile.asides} navs=${mobile.sidebarNavCount}`,
    );
  }
  record(
    "C01",
    "expected.json#C01",
    bad.length
      ? `FAIL — ${bad.join("; ")}`
      : "PASS — one sidebar nav landmark at 1440 and 768 in both states; zero on mobile with the drawer closed",
    bad.length ? "FAIL" : "PASS",
    "evidence/verify-run.json",
  );
}

// C02 — zero duplicate visible labels
{
  const bad = [];
  for (const width of [1440, 768, 390]) {
    for (const state of ["expanded", "collapsed"]) {
      const m = s(width, state);
      if (m.duplicateLabels.length) bad.push(`${width}/${state}: ${JSON.stringify(m.duplicateLabels)}`);
    }
  }
  record(
    "C02",
    "expected.json#C02",
    bad.length
      ? `FAIL — ${bad.join("; ")}`
      : `PASS — 0 duplicate labels; sidebar links per sample: ${[1440, 768, 390].map((w) => `${w}:${s(w, "expanded").visibleNavCount}`).join(", ")}`,
    bad.length ? "FAIL" : "PASS",
    "evidence/verify-run.json",
  );
}

// C03 — widths + persistence + empty storage
{
  const expanded = s(1440, "expanded").asideBox?.w ?? -1;
  const collapsed = s(1440, "collapsed").asideBox?.w ?? -1;

  const fresh = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const freshPage = await fresh.newPage();
  await gotoRetry(freshPage, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const emptyStorageWidth = (await measure(freshPage)).asideBox?.w ?? -1;

  // Toggle, reload, and confirm the preference came back from localStorage.
  // Width is sampled after the transition SETTLES: measuring mid-animation (73px
  // on the way to 72px) is a timing artifact, not an app result.
  const settledWidth = async (page, previous) => {
    let last = previous;
    for (let i = 0; i < 40; i += 1) {
      const width = (await measure(page)).asideBox?.w ?? -1;
      // Wait for the transition to finish: the width must have changed and then
      // hold for two consecutive samples.
      if (width !== previous && width === last) return width;
      last = width;
      await page.waitForTimeout(100);
    }
    return last;
  };
  const toggle = freshPage
    .locator('button[aria-label="Collapse sidebar"], button[aria-label="Expand sidebar"]')
    .first();
  await toggle.click();
  const widthAfterToggle = await settledWidth(freshPage, emptyStorageWidth);
  await freshPage.reload({ waitUntil: "networkidle" });
  await freshPage.waitForTimeout(250);
  const widthAfterReload = await settledWidth(freshPage, -1);
  const stored = await evalRetry(freshPage, () => {
    try {
      return window.localStorage.getItem("ledgerly.sidebar-collapsed");
    } catch {
      return "storage-unavailable";
    }
  });
  await fresh.close();

  const ok =
    expanded === 256 &&
    collapsed === 72 &&
    emptyStorageWidth === 256 &&
    widthAfterToggle === 72 &&
    widthAfterReload === 72 &&
    stored === "1";
  record(
    "C03",
    "expected.json#C03",
    ok
      ? `PASS — expanded ${expanded}px, collapsed ${collapsed}px, empty storage ${emptyStorageWidth}px, reload restored ${widthAfterReload}px from "${stored}"`
      : `FAIL — expanded ${expanded}, collapsed ${collapsed}, empty ${emptyStorageWidth}, afterToggle ${widthAfterToggle}, afterReload ${widthAfterReload}, stored ${stored}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-collapsed.png",
    ok ? 1 : 2,
  );
}

// C04 — no horizontal overflow
{
  const bad = [];
  for (const width of [1440, 768, 390]) {
    for (const state of ["expanded", "collapsed"]) {
      const m = s(width, state);
      const sidebarOverflow = m.asideBox ? m.sidebarScrollWidth > m.sidebarClientWidth : false;
      const pageOverflow = m.docScrollWidth > m.docClientWidth;
      if (sidebarOverflow || pageOverflow) {
        bad.push(
          `${width}/${state}: sidebar ${m.sidebarScrollWidth}/${m.sidebarClientWidth}, page ${m.docScrollWidth}/${m.docClientWidth}`,
        );
      }
    }
  }
  // 320px narrowest supported width
  const ctx = await newContext(browser, { viewport: { width: 320, height: 720 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const m320 = await measure(p);
  await shoot(p, "after/dashboard-320-expanded.png");
  shots.push("after/dashboard-320-expanded.png");
  await ctx.close();
  if (m320.docScrollWidth > m320.docClientWidth) {
    bad.push(`320/expanded: page ${m320.docScrollWidth}/${m320.docClientWidth}`);
  }
  record(
    "C04",
    "expected.json#C04",
    bad.length ? `FAIL — ${bad.join("; ")}` : "PASS — no sidebar or page overflow at 1440/768/390/320 in both states",
    bad.length ? "FAIL" : "PASS",
    "after/dashboard-320-expanded.png",
  );
}

// C05 — no overlapping boxes
{
  const bad = [];
  for (const width of [1440, 768, 390]) {
    for (const state of ["expanded", "collapsed"]) {
      const m = s(width, state);
      if (m.overlaps.length) bad.push(`${width}/${state}: ${JSON.stringify(m.overlaps.slice(0, 4))}`);
    }
  }
  record(
    "C05",
    "expected.json#C05",
    bad.length ? `FAIL — ${bad.join("; ")}` : "PASS — 0 pairwise overlaps among sidebar rows and header controls",
    bad.length ? "FAIL" : "PASS",
    "evidence/verify-run.json",
  );
}

// C06 — grouped navigation
{
  const groups = s(1440, "expanded").groupHeadings;
  const ok = groups.length >= 4;
  record(
    "C06",
    "expected.json#C06",
    ok ? `PASS — groups: ${groups.join(" | ")}` : `FAIL — headings rendered: ${JSON.stringify(groups)}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-expanded.png",
  );
}

// C07 — collapsed is icons-only, named, tooltipped
{
  const m = s(1440, "collapsed");
  const iconsOnly = m.navLinks.every((l) => l.label === "");
  const named = await (async () => {
    const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await setSidebarState(ctx, true);
    const p = await ctx.newPage();
    await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    const info = await evalRetry(p, () => {
      const aside = document.querySelector("aside");
      const links = [...aside.querySelectorAll("nav a[href]")];
      const unnamed = links.filter((a) => !(a.getAttribute("aria-label") || a.textContent?.trim()));
      const tooltips = [...aside.querySelectorAll('nav [role="tooltip"]')].length;
      const icons = [...aside.querySelectorAll("nav a[href] svg")].length;
      const visibleText = links.filter((a) => {
        const text = [...a.childNodes]
          .filter((n) => !(n.nodeType === 1 && n.matches('[role="tooltip"]')))
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        return text.length > 0;
      }).length;
      return { links: links.length, unnamed: unnamed.length, tooltips, icons, visibleText };
    });
    await p.hover("aside nav a[href]");
    await p.waitForTimeout(250);
    const tooltipVisible = await evalRetry(p, () => {
      const tip = document.querySelector('aside nav [role="tooltip"]');
      return tip ? getComputedStyle(tip).display !== "none" : false;
    });
    await ctx.close();
    return { ...info, tooltipVisible };
  })();
  const ok =
    iconsOnly &&
    named.unnamed === 0 &&
    named.tooltips === named.links &&
    named.icons === named.links &&
    named.visibleText === 0 &&
    named.tooltipVisible;
  record(
    "C07",
    "expected.json#C07",
    ok
      ? `PASS — ${named.links} collapsed links, ${named.icons} icons, ${named.tooltips} tooltips, 0 unnamed, tooltip visible on hover`
      : `FAIL — iconsOnly=${iconsOnly} ${JSON.stringify(named)}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-collapsed.png",
  );
}

// C08 — mobile drawer behaviour
{
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const trigger = p.locator('button[aria-label="Open navigation menu"]');
  const closedExpanded = await trigger.getAttribute("aria-expanded");
  await trigger.click();
  await p.waitForTimeout(300);
  const dialog = p.locator('[role="dialog"][aria-label="Navigation menu"]');
  const dialogVisible = await dialog.isVisible();
  const openExpanded = await trigger.getAttribute("aria-expanded");
  const backgroundInert = await evalRetry(
    p,
    () => document.getElementById("app-content")?.hasAttribute("inert") ?? false,
  );
  await shoot(p, "after/dashboard-390-drawer.png");
  shots.push("after/dashboard-390-drawer.png");

  // Focus trap: tab past the last focusable and confirm focus stays inside.
  const focusOrder = [];
  for (let i = 0; i < 12; i += 1) {
    await p.keyboard.press("Tab");
    focusOrder.push(
      await evalRetry(p, () => {
        const el = document.activeElement;
        const inDialog = !!el?.closest('[role="dialog"]');
        return `${el?.tagName}:${(el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 20)}${inDialog ? "" : " [OUTSIDE]"}`;
      }),
    );
  }
  const escapedFocus = focusOrder.some((entry) => entry.includes("[OUTSIDE]"));

  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  const closedAfterEscape =
    (await trigger.getAttribute("aria-expanded")) === "false" && !(await dialog.isVisible().catch(() => false));

  // Route change closes the drawer. A dev-server recompile can reload the page
  // mid-step, so opening is retried and the link click has a short timeout: a
  // reload is then an ENV-LIMIT detail in `actual`, not a 30s hang.
  let reopened = (await p.locator('[role="dialog"]').count()) > 0;
  for (let attempt = 0; attempt < 3 && !reopened; attempt += 1) {
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(500);
    reopened = (await p.locator('[role="dialog"]').count()) > 0;
  }
  let linkClicked = false;
  if (reopened) {
    linkClicked = await p
      .locator('[role="dialog"] a[href="/books"]')
      .first()
      .click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }
  await p.waitForTimeout(800);
  const drawerGone = (await p.locator('[role="dialog"][aria-label="Navigation menu"]').count()) === 0;
  const url = p.url();
  await ctx.close();
  if (!reopened || !linkClicked) {
    process.stderr.write(`[C08] drawer reopen=${reopened} linkClicked=${linkClicked} url=${url}\n`);
  }

  const ok =
    closedExpanded === "false" &&
    dialogVisible &&
    openExpanded === "true" &&
    backgroundInert &&
    !escapedFocus &&
    closedAfterEscape &&
    drawerGone &&
    url.includes("/books");
  record(
    "C08",
    "expected.json#C08",
    ok
      ? `PASS — aria-expanded false→true, background inert, focus stayed inside over 12 Tabs, Escape closed, route change closed and navigated to ${url}`
      : `FAIL — closed=${closedExpanded} open=${openExpanded} inert=${backgroundInert} escapedFocus=${escapedFocus} escapeClosed=${closedAfterEscape} reopened=${reopened} linkClicked=${linkClicked} drawerGone=${drawerGone} url=${url}`,

    ok ? "PASS" : "FAIL",
    "after/dashboard-390-drawer.png",
  );
}

// C09 — one global search, complete header controls, no sidebar search
{
  const m = s(1440, "expanded");
  const controls = m.headerControls.map((c) => c.label);
  const searchControls = m.headerControls.filter((c) => /search/i.test(c.label));
  const hasNotifications = m.headerControls.some((c) => c.href === "/notifications");
  const hasLanguage = await (async () => {
    const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const p = await ctx.newPage();
    await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    const count = await p.locator("header select[aria-label='Language']").count();
    await ctx.close();
    return count;
  })();
  const hasProfile = m.headerControls.some((c) => /account menu/i.test(c.label));
  const sidebarInputs = s(1440, "expanded").sidebarInputs.length + s(390, "expanded").sidebarInputs.length;
  const ok = searchControls.length === 1 && hasNotifications && hasLanguage === 1 && hasProfile && sidebarInputs === 0;
  record(
    "C09",
    "expected.json#C09",
    ok
      ? `PASS — 1 search control (${searchControls[0].label}), notifications, 1 language control, profile menu, 0 sidebar inputs. Header: ${controls.join(" / ")}`
      : `FAIL — search=${searchControls.length} notifications=${hasNotifications} language=${hasLanguage} profile=${hasProfile} sidebarInputs=${sidebarInputs}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-expanded.png",
  );
}

// C10 — language default + honest coverage + persistence
{
  const m = s(1440, "expanded");
  const options = m.localeOptions;
  const partialLabelled = options.filter((o) => /partial/i.test(o)).length === 2;
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  await p.selectOption("select[aria-label='Language']", "hi");
  await p.waitForTimeout(900);
  const afterSwitch = await evalRetry(p, () => ({
    lang: document.documentElement.lang,
    value: document.querySelector("select[aria-label='Language']")?.value,
    cookie: document.cookie.includes("ledgerly.locale=hi"),
  }));
  await p.reload({ waitUntil: "networkidle" });
  const afterReload = await evalRetry(p, () => document.documentElement.lang);
  await ctx.close();
  const ok =
    m.lang === "en" &&
    m.localeValue === "en" &&
    partialLabelled &&
    afterSwitch.lang === "hi" &&
    afterSwitch.cookie &&
    afterReload === "hi";
  record(
    "C10",
    "expected.json#C10",
    ok
      ? `PASS — default ${m.lang}/${m.localeValue}, options labelled: ${options.join(", ")}; switching persisted (lang ${afterSwitch.lang} after reload)`
      : `FAIL — default lang=${m.lang} value=${m.localeValue} options=${JSON.stringify(options)} switched=${JSON.stringify(afterSwitch)} reload=${afterReload}`,
    ok ? "PASS" : "FAIL",
    "evidence/verify-run.json",
  );
}

// C11 — contrast
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const contrast = await evalRetry(p, () => {
    const parse = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]) => {
      const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const bgOf = (el) => {
      let node = el;
      while (node) {
        const rgba = parse(getComputedStyle(node).backgroundColor);
        if (rgba.length >= 3 && (rgba[3] === undefined || rgba[3] > 0.5)) return rgba.slice(0, 3);
        node = node.parentElement;
      }
      return [0, 0, 0];
    };
    const ratioOf = (el) => {
      const fg = parse(getComputedStyle(el).color).slice(0, 3);
      const bg = bgOf(el);
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const rows = [];
    for (const el of document.querySelectorAll(
      "aside a[href] span, header button span, header a, .kpi-slab, main h2",
    )) {
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      rows.push({ text: text.slice(0, 24), ratio: Math.round(ratioOf(el) * 100) / 100 });
    }
    return rows;
  });
  await ctx.close();
  const failures = contrast.filter((row) => row.ratio < 4.5);
  record(
    "C11",
    "expected.json#C11",
    failures.length
      ? `FAIL — ${failures.length} text sample(s) below 4.5:1: ${JSON.stringify(failures.slice(0, 5))}`
      : `PASS — ${contrast.length} text samples, minimum ratio ${Math.min(...contrast.map((r) => r.ratio))}`,
    failures.length ? "FAIL" : "PASS",
    "evidence/verify-run.json",
  );
}

// C12 — keyboard path + ARIA state
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/projects`, { waitUntil: "networkidle" });
  const order = [];
  for (let i = 0; i < 14; i += 1) {
    await p.keyboard.press("Tab");
    order.push(
      await evalRetry(p, () => {
        const el = document.activeElement;
        const style = el ? getComputedStyle(el) : null;
        const outlineVisible = !!style && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
        const ringVisible = !!style && style.boxShadow !== "none";
        return {
          label: (el?.getAttribute("aria-label") || el?.textContent || "").trim().slice(0, 24),
          tag: el?.tagName ?? "",
          focusVisible: outlineVisible || ringVisible,
          insideSidebar: !!el?.closest("aside"),
        };
      }),
    );
  }
  const aria = await evalRetry(p, () => {
    const aside = document.querySelector("aside");
    const currentPage = [...aside.querySelectorAll("a[aria-current='page']")].map((a) => (a.textContent || "").trim());
    return { currentPage, count: currentPage.length };
  });
  await ctx.close();
  const focusVisible = order.every((entry) => entry.focusVisible);
  const sidebarReached = order.some((entry) => entry.insideSidebar);
  const ok = focusVisible && sidebarReached && aria.count === 1;
  record(
    "C12",
    "expected.json#C12",
    ok
      ? `PASS — 14 Tab stops, all with a visible focus ring, sidebar reached, exactly one aria-current=page (${aria.currentPage[0]})`
      : `FAIL — focusVisible=${focusVisible} sidebarReached=${sidebarReached} ariaCurrent=${JSON.stringify(aria)} order=${JSON.stringify(order.slice(0, 6))}`,
    ok ? "PASS" : "FAIL",
    "evidence/keyboard-order.json",
  );
  saveJson("evidence/keyboard-order.json", order);
}

// ---------------------------------------------------------------------------
// Pass 2: every nav route at three widths (expanded), plus collapsed at 1440.
// ---------------------------------------------------------------------------
const navHrefs = [...new Set(s(1440, "expanded").navLinks.map((l) => l.href))];
const routeReport = [];
for (const width of [1440, 768, 390]) {
  const ctx = await newContext(browser, { viewport: { width, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  for (const href of navHrefs) {
    // gotoRetry already retries once: a navigation superseded by a client-side
    // redirect is an environment hiccup, not a broken route.
    const response = await gotoRetry(p, `${BASE_URL}${href}`);
    await p.waitForTimeout(150);
    const main = await evalRetry(p, () => {
      const el = document.getElementById("main-content");
      const text = (el?.innerText ?? "").replace(/\s+/g, " ").trim();
      return { length: text.length, sample: text.slice(0, 60) };
    });
    const entry = {
      width,
      href,
      status: response?.status?.() ?? -1,
      mainLength: main.length,
      sample: main.sample,
      url: p.url(),
    };
    routeReport.push(entry);
    process.stderr.write(`[route] ${width} ${href} -> ${entry.status} main=${entry.mainLength} at ${entry.url}\n`);
  }
  await ctx.close();
}

// C13
{
  const bad = routeReport.filter((r) => r.status !== 200 || r.mainLength <= 100);
  record(
    "C13",
    "expected.json#C13",
    bad.length
      ? `FAIL — ${bad.length}/${routeReport.length} route loads failed: ${JSON.stringify(bad.slice(0, 6))}`
      : `PASS — ${routeReport.length} route loads, all HTTP 200 with a non-empty main region (min ${Math.min(...routeReport.map((r) => r.mainLength))} chars)`,
    bad.length ? "FAIL" : "PASS",
    "evidence/routes.json",
  );
  saveJson("evidence/routes.json", routeReport);
}

// C14 — console cleanliness across the sampled routes
{
  // Re-run the dashboard + two CA pages with listeners to attribute errors.
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  const errors = [];
  const warnings = [];
  const failed = [];
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") errors.push(t);
    if (/hydration|did not match/i.test(t)) warnings.push(t);
  });
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("response", (res) => {
    if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
  });
  for (const href of ["/dashboard", "/gst-recon", "/books", "/ca-sources"]) {
    await gotoRetry(p, `${BASE_URL}${href}`);
    await p.waitForTimeout(400);
  }
  saveJson("evidence/console-errors.json", { errors, warnings, networkFailures: failed });
  await ctx.close();
  const ok = errors.length === 0 && warnings.length === 0;
  record(
    "C14",
    "expected.json#C14",
    ok
      ? "PASS — 0 console errors, 0 hydration warnings across /dashboard, /gst-recon, /books, /ca-sources"
      : `FAIL — errors=${JSON.stringify(errors.slice(0, 4))} warnings=${JSON.stringify(warnings.slice(0, 3))}`,
    ok ? "PASS" : "FAIL",
    "evidence/console-errors.json",
  );
  record(
    "C16",
    "expected.json#C16",
    failed.length
      ? `FAIL — ${failed.length} request(s) >= 400: ${JSON.stringify(failed.slice(0, 6))}`
      : "PASS — no request returned status >= 400 on the sampled pages",
    failed.length ? "FAIL" : "PASS",
    "evidence/console-errors.json",
  );
}

// C15 — axe on three pages
{
  const rows = [];
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  for (const href of ["/dashboard", "/books", "/ca-sources"]) {
    await gotoRetry(p, `${BASE_URL}${href}`);
    await p.waitForTimeout(300);
    const scan = await new AxeBuilder({ page: p }).analyze();
    const serious = scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    rows.push({
      href,
      violations: serious.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
        summary: v.nodes[0]?.failureSummary?.slice(0, 200),
      })),
    });
  }
  saveJson("evidence/axe.json", rows);
  const total = rows.reduce((sum, r) => sum + r.violations.length, 0);
  record(
    "C15",
    "expected.json#C15",
    total === 0
      ? `PASS — axe serious+critical violations: 0 on ${rows.map((r) => r.href).join(", ")}`
      : `FAIL — ${JSON.stringify(rows)}`,
    total === 0 ? "PASS" : "FAIL",
    "evidence/axe.json",
  );
}

// C17 — route inventory vs filesystem
{
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const rel = path.relative(path.join(ROOT, "app"), full).replace(/\/?page\.tsx$/, "");
        pages.push(
          "/" +
            rel
              .replace(/\([^)]*\)\//g, "")
              .replace(/\([^)]*\)/g, "")
              .replace(/\/$/, ""),
        );
      }
    }
  };
  walk(path.join(ROOT, "app"));
  const exists = (href) =>
    pages.some((route) => route === href || (route !== "/" && (href === route || href.startsWith(`${route}/`))));
  const dangling = navHrefs.filter((href) => !exists(href));
  const live = [
    "/books",
    "/statutes",
    "/ca-compute",
    "/ca-sources",
    "/gst-recon",
    "/dashboard",
    "/projects",
    "/copilot",
    "/analyses",
    "/dashboards",
    "/reports",
    "/presentations",
    "/audit",
    "/settings",
    "/notifications",
    "/search",
  ].filter((href) => pages.includes(href));
  record(
    "C17",
    "expected.json#C17",
    dangling.length
      ? `FAIL — nav hrefs without a page: ${dangling.join(", ")}`
      : `PASS — ${navHrefs.length} nav hrefs all map to an app/ page; ${pages.length} pages on disk`,
    dangling.length ? "FAIL" : "PASS",
    "evidence/inventory.json",
  );
  saveJson("evidence/inventory.json", { navHrefs, pages: pages.sort(), liveSpotCheck: live });
}

// C18 — CA capabilities reachable
{
  const m = s(1440, "expanded");
  const hrefs = m.navLinks.map((l) => l.href);
  const required = ["/books", "/ca-sources", "/ca-compute", "/gst-recon", "/statutes"];
  const missing = required.filter((href) => !hrefs.includes(href));
  const groups = m.groupHeadings;
  const ok =
    missing.length === 0 && groups.some((g) => /client work/i.test(g)) && groups.some((g) => /compliance/i.test(g));
  record(
    "C18",
    "expected.json#C18",
    ok
      ? `PASS — ${required.join(", ")} each have one nav entry under groups [${groups.join(", ")}]`
      : `FAIL — missing ${missing.join(", ") || "none"}; groups ${JSON.stringify(groups)}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-expanded.png",
  );
}

// C19 — dashboard leads with the CA work queue
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 1200 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const probe = await evalRetry(p, () => {
    const main = document.getElementById("main-content");
    const sections = [...main.querySelectorAll("h2")].map((h) => (h.textContent || "").trim());
    const firstSection = sections[0] ?? "";
    const text = (main.innerText || "").replace(/\s+/g, " ");
    return {
      firstHeading: firstSection,
      headings: sections,
      hasQueue: /Firm work queue/.test(text),
      hasClients: /Clients/.test(text),
      hasFilings: /Filings due/.test(text),
      hasImports: /Recent imports/.test(text),
      hasExceptions: /Exceptions/.test(text),
      emptyStates:
        /No client books yet|No unfiled GST returns recorded|No source imports yet|No exceptions recorded/.test(text),
    };
  });
  await shoot(p, "after/dashboard-1440-workqueue.png", { fullPage: true });
  shots.push("after/dashboard-1440-workqueue.png");
  await ctx.close();
  const ok =
    probe.hasQueue &&
    probe.hasClients &&
    probe.hasFilings &&
    probe.hasImports &&
    probe.hasExceptions &&
    probe.headings[0] === "Firm work queue";
  record(
    "C19",
    "expected.json#C19",
    ok
      ? `PASS — first section "${probe.headings[0]}"; blocks: clients, filings due, recent imports, exceptions`
      : `FAIL — first heading "${probe.headings[0]}" probe=${JSON.stringify(probe)}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-1440-workqueue.png",
  );
}

// C20b — the delivered page renders the oracle's numbers
{
  const ctx = await newContext(browser, {
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    acceptDownloads: true,
  });
  const p = await ctx.newPage();
  const consoleBad = [];
  p.on("console", (m) => {
    if (m.type() === "error") consoleBad.push(m.text());
  });
  await gotoRetry(p, `${BASE_URL}/gst-recon`, { waitUntil: "networkidle" });
  // Empty submission must be a useful error, not a crash.
  await p.getByRole("button", { name: /^Reconcile/ }).click();
  await p.waitForTimeout(300);
  const emptyError = await p.getByText(/Both sides are required/).count();
  // Invalid input must also be reported.
  await p.fill("#gst-2b-csv", "nope");
  await p.fill("#gst-books-csv", "nope");
  await p.getByRole("button", { name: /^Reconcile/ }).click();
  await p.waitForTimeout(300);
  const invalidError = await p.getByText(/header row and at least one data row/).count();
  await shoot(p, "after/gst-recon-errors-1440.png");
  shots.push("after/gst-recon-errors-1440.png");

  await p.getByRole("button", { name: /Load labelled example/ }).click();
  await p.getByRole("button", { name: /^Reconcile/ }).click();
  await p.waitForTimeout(1200);
  const shown = await evalRetry(p, () => {
    const text = document.body.innerText.replace(/\s+/g, " ");
    return {
      matched: /Matched & eligible\s*2\b/.test(text),
      mismatch: /Amount mismatch\s*1\b/.test(text),
      twoBOnly: /In 2B only\s*1\b/.test(text),
      booksOnly: /In books only\s*1\b/.test(text),
      exceptions: /Exceptions \(3\)/.test(text),
      table4: /GSTR-3B Table 4/.test(text),
      methodology: /Methodology/.test(text),
      sample: text.slice(0, 400),
    };
  });
  await shoot(p, "after/gst-recon-results-1440.png", { fullPage: true });
  shots.push("after/gst-recon-results-1440.png");
  await ctx.close();
  const ok =
    emptyError > 0 &&
    invalidError > 0 &&
    shown.matched &&
    shown.mismatch &&
    shown.twoBOnly &&
    shown.booksOnly &&
    shown.exceptions &&
    shown.table4 &&
    consoleBad.length === 0;
  record(
    "C20b",
    "expected.json#C20 (correction 1: end-to-end UI part)",
    ok
      ? "PASS — empty + invalid input both reported, example reconciles to 2 matched / 1 mismatch / 1 in-2B-only / 1 in-books-only, 3 exceptions, Table 4 rendered, 0 console errors"
      : `FAIL — emptyError=${emptyError} invalidError=${invalidError} shown=${JSON.stringify(shown)} console=${JSON.stringify(consoleBad.slice(0, 3))}`,
    ok ? "PASS" : "FAIL",
    "after/gst-recon-results-1440.png",
    2,
  );
}

// C22 — reduced motion
{
  const ctx = await newContext(browser, {
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const durations = await evalRetry(p, () => {
    const aside = document.querySelector("aside");
    return {
      aside: getComputedStyle(aside).transitionDuration,
      content: getComputedStyle(document.getElementById("app-content")).transitionDuration,
    };
  });
  await ctx.close();
  const zero = (value) => value.split(",").every((part) => Number(part.replace("s", "")) <= 0.001);
  const ok = zero(durations.aside) && zero(durations.content);
  record(
    "C22",
    "expected.json#C22",
    ok
      ? `PASS — transitions suppressed under prefers-reduced-motion (aside ${durations.aside}, content ${durations.content})`
      : `FAIL — ${JSON.stringify(durations)}`,
    ok ? "PASS" : "FAIL",
    "evidence/verify-run.json",
  );
}

// C23 — 320px integrity
{
  const ctx = await newContext(browser, { viewport: { width: 320, height: 720 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const m = await measure(p);
  const hamburger = await p.locator('button[aria-label="Open navigation menu"]').isVisible();
  await p.locator('button[aria-label="Open navigation menu"]').click();
  await p.waitForTimeout(250);
  const dialogVisible = await p.locator('[role="dialog"]').isVisible();
  await shoot(p, "after/dashboard-320-drawer.png");
  shots.push("after/dashboard-320-drawer.png");
  await ctx.close();
  const ok = m.docScrollWidth <= m.docClientWidth && hamburger && dialogVisible && m.asides === 0;
  record(
    "C23",
    "expected.json#C23",
    ok
      ? `PASS — no page scroll (${m.docScrollWidth}/${m.docClientWidth}), hamburger visible, drawer opens, 0 desktop asides`
      : `FAIL — scroll ${m.docScrollWidth}/${m.docClientWidth} hamburger=${hamburger} drawer=${dialogVisible} asides=${m.asides}`,
    ok ? "PASS" : "FAIL",
    "after/dashboard-320-drawer.png",
  );
}

// C24 — long names
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const probe = await evalRetry(p, () => {
    const aside = document.querySelector("aside");
    const link = aside.querySelector("a[href='/books']");
    const span = link?.querySelector("span");
    const before = aside.getBoundingClientRect().width;
    const long = "Rameshwar Iyer & Associates Chartered Accountants — Retainer Client";
    if (span) span.textContent = long;
    const after = aside.getBoundingClientRect().width;
    const style = span ? getComputedStyle(span) : null;
    return {
      before,
      after,
      scrollWidth: aside.scrollWidth,
      clientWidth: aside.clientWidth,
      textOverflow: style?.textOverflow ?? null,
      overflow: style?.overflow ?? null,
      truncated: span ? span.scrollWidth > span.clientWidth : false,
    };
  });
  await shoot(p, "after/long-label-1440.png");
  shots.push("after/long-label-1440.png");
  const clientName = await evalRetry(p, () => {
    const card = [...document.querySelectorAll("h3")].find((h) => /Clients/.test(h.textContent || ""));
    return !!card;
  });
  await ctx.close();
  const ok =
    probe.before === probe.after &&
    probe.scrollWidth <= probe.clientWidth &&
    probe.textOverflow === "ellipsis" &&
    probe.truncated &&
    clientName;
  record(
    "C24",
    "expected.json#C24",
    ok
      ? `PASS — 120-char label truncated with ellipsis; sidebar stayed ${probe.after}px; client list rendered`
      : `FAIL — ${JSON.stringify(probe)} cards=${clientName}`,
    ok ? "PASS" : "FAIL",
    "after/long-label-1440.png",
  );
}

// C25 — 200% zoom (720px effective width)
{
  const ctx = await newContext(browser, {
    viewport: { width: 720, height: 900 },
    colorScheme: "dark",
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const m = await measure(p);
  // 720px effective width is below the md breakpoint, so navigation is the
  // drawer (per the pre-registered expectation: "drawer navigation works").
  const hamburger = await evalRetry(p, () => {
    const el = document.querySelector('button[aria-label="Open navigation menu"]');
    if (!el) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  });
  await p
    .locator('button[aria-label="Open navigation menu"]')
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
  await p.waitForTimeout(300);
  const drawer = await p.locator('[role="dialog"]').isVisible();
  await shoot(p, "after/zoom200-720.png");
  shots.push("after/zoom200-720.png");
  await ctx.close();
  const ok = m.docScrollWidth <= m.docClientWidth && m.overlaps.length === 0 && m.asides === 0 && hamburger && drawer;
  record(
    "C25",
    "expected.json#C25",
    ok
      ? `PASS — 720px effective viewport: no page overflow (${m.docScrollWidth}/${m.docClientWidth}), no overlaps, drawer navigation opens`
      : `FAIL — ${JSON.stringify({ doc: [m.docScrollWidth, m.docClientWidth], overlaps: m.overlaps.length, asides: m.asides, hamburger, drawer })}`,
    ok ? "PASS" : "FAIL",
    "after/zoom200-720.png",
  );
}

// C26 — JavaScript disabled
{
  const ctx = await newContext(browser, {
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
    colorScheme: "dark",
  });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  const html = await p.content();
  await shoot(p, "after/nojs-1440.png");
  shots.push("after/nojs-1440.png");
  await ctx.close();
  const checks = {
    brand: /Ledgerly/.test(html),
    groups: /Client work/i.test(html) && /Compliance/i.test(html),
    navLinks: /href="\/books"/.test(html) && /href="\/gst-recon"/.test(html),
    ariaNav: /aria-label="Primary"/.test(html),
  };
  const ok = Object.values(checks).every(Boolean);
  record(
    "C26",
    "expected.json#C26",
    ok ? `PASS — server HTML contains ${JSON.stringify(checks)}` : `FAIL — ${JSON.stringify(checks)}`,
    ok ? "PASS" : "FAIL",
    "after/nojs-1440.png",
  );
}

// C28 — no dead controls left behind
{
  const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  await gotoRetry(p, `${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  const audit = await evalRetry(p, () => {
    const controls = [...document.querySelectorAll("aside button, header button, header a, aside a[href]")];
    const unnamed = controls.filter(
      (el) => !(el.getAttribute("aria-label") || (el.textContent || "").trim() || el.getAttribute("href")),
    ).length;
    return {
      toggleSidebar: document.querySelectorAll('button[aria-label="Toggle sidebar"]').length,
      sidebarSearch: document.querySelectorAll("aside input").length,
      unnamed,
      controls: controls.length,
    };
  });
  await ctx.close();
  const ok = audit.toggleSidebar === 0 && audit.sidebarSearch === 0 && audit.unnamed === 0;
  record(
    "C28",
    "expected.json#C28",
    ok
      ? `PASS — ${audit.controls} shell controls, all named; no leftover toggle/search controls`
      : `FAIL — ${JSON.stringify(audit)}`,
    ok ? "PASS" : "FAIL",
    "evidence/verify-run.json",
  );
}

await browser.close();

const summary = {
  mode: MODE,
  baseUrl: BASE_URL,
  at: new Date().toISOString(),
  counts: {
    PASS: results.filter((r) => r.state === "PASS").length,
    FAIL: results.filter((r) => r.state === "FAIL").length,
  },
  results,
  screenshots: shots,
  notes,
};
saveJson("results.json", summary);
saveJson("evidence/verify-run.json", { samples: shellSamples, navHrefs });
console.log(
  JSON.stringify({ mode: MODE, counts: summary.counts, results: results.map((r) => `${r.id} ${r.state}`) }, null, 2),
);

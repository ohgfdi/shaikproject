#!/usr/bin/env node
/**
 * QA harness: negative controls (PHASE 1) + styling matrix (PHASE 2).
 * Runs against the local production server (default http://127.0.0.1:3100).
 * Writes one JSON result per (route, viewport) into qa-report/evidence/.
 * This file is a QA-only artifact: no application source is read or modified.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3100";
const EV = new URL("../evidence/", import.meta.url).pathname;
mkdirSync(EV, { recursive: true });

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
];

function freshResult(id, area, feature) {
  return { id, area, feature, steps: [], actual: {}, state: "PASS", evidence_level: "E3", facts: [], defects: [] };
}

async function probePage(page, route, vpName) {
  const res = {
    route,
    viewport: vpName,
    finalUrl: "",
    httpStatus: 0,
    stylesheets: [],
    stylesheetsFailed: [],
    badRequests: [],
    consoleMessages: [],
    pageErrors: [],
    bodyStyles: {},
    viewportMeta: "",
    overflowX: null,
    keyElements: [],
    cls: null,
    fontsLoaded: null,
    failedFontRequests: [],
    screenshot: "",
    domSnapshot: "",
  };
  const consoleBag = [];
  page.removeAllListeners("console");
  page.removeAllListeners("pageerror");
  page.removeAllListeners("response");
  page.removeAllListeners("requestfailed");
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) consoleBag.push({ type: m.type(), text: m.text() });
  });
  page.on("pageerror", (e) => consoleBag.push({ type: "pageerror", text: String(e) }));
  page.on("response", (r) => {
    const t = r.request().resourceType();
    const url = r.url();
    if (t === "stylesheet") res.stylesheets.push({ url, status: r.status() });
    if (r.status() >= 400) res.badRequests.push({ url, status: r.status(), type: t });
  });
  page.on("requestfailed", (r) => {
    const t = r.resourceType();
    if (t === "stylesheet") res.stylesheetsFailed.push({ url: r.url(), failure: r.failure()?.errorText });
    else if (t === "font") res.failedFontRequests.push({ url: r.url() });
  });
  await page.addInitScript(() => {
    window.__qaCls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__qaCls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  const resp = await page
    .goto(BASE + route, { waitUntil: "networkidle", timeout: 30000 })
    .catch((e) => ({ status: 0, failed: String(e) }));
  res.httpStatus = resp?.status ?? 0;
  if (resp && resp.failed) res.pageErrors.push(resp.failed);
  res.finalUrl = page.url();
  await page.waitForTimeout(400);
  const styles = await page.evaluate(() => {
    const b = document.body;
    const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
    const samples = [];
    document.querySelectorAll("h1,h2,button,input,a,form,p").forEach((el, i) => {
      if (i < 8)
        samples.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 60),
          fontFamily: cs(el, "fontFamily")?.slice(0, 60),
          padding: cs(el, "padding"),
          display: cs(el, "display"),
          color: cs(el, "color"),
          borderRadius: cs(el, "borderRadius"),
          textAlign: cs(el, "textAlign"),
          w: el.getBoundingClientRect().width,
          h: el.getBoundingClientRect().height,
        });
    });
    return {
      bodyFont: cs(document.body, "fontFamily"),
      bodyColor: cs(document.body, "color"),
      bodyBg: cs(document.body, "backgroundColor"),
      sampleCount: samples,
    };
  });
  res.bodyStyles = styles;
  res.consoleMessages = consoleBag;
  res.keyElements = styles.sampleCount;
  res.viewportMeta = await page.evaluate(() => document.querySelector("meta[name=viewport]")?.content ?? "");
  res.overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  res.cls = await page.evaluate(() => window.__qaCls);
  res.fontsLoaded = await page.evaluate(() => (document.fonts ? document.fonts.status : "unsupported"));
  const vpDir = join(EV, `vp${vpName}`);
  mkdirSync(vpDir, { recursive: true });
  const shotName = route.replace(/\W+/g, "_") || "home";
  res.screenshot = join(vpDir, `${shotName}.png`);
  await page.screenshot({ path: res.screenshot, fullPage: true });
  res.domSnapshot =
    (await page.evaluate(() => {
      const walk = (el, d) => {
        if (d > 6 || !el) return "";
        let out = `${"  ".repeat(d)}<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}>\n`;
        for (const c of Array.from(el.children).slice(0, 12)) out += walk(c, d + 1);
        return out;
      };
      return walk(document.body, 0).slice(0, 5000);
    })) ?? "";
  return res;
}

function verdict(res) {
  const cssCount = res.stylesheets.filter((s) => s.status === 200).length;
  const fontDefault =
    /times|serif/i.test(res.bodyStyles.bodyFont ?? "") && !/inter/i.test(res.bodyStyles.bodyFont ?? "");
  const transparent = res.bodyStyles.bodyBg === "rgba(0, 0, 0, 0)";
  const overflow = (res.overflowX ?? 0) > 1;
  const errs = res.consoleMessages.filter((m) => m.type === "error" || m.type === "pageerror");
  const bad = res.badRequests.length > 0 || res.stylesheetsFailed.length > 0;
  if (res.httpStatus >= 500) return "UNSTYLED_SERVER_ERROR";
  if (cssCount === 0) return "UNSTYLED";
  if (fontDefault || transparent || overflow) return "PARTIAL";
  if (errs.length || bad) return "STYLED_WITH_ERRORS";
  return "STYLED";
}

const ROUTES = [
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/templates",
  "/(app)/dashboard",
  "/(app)/settings",
  "/__qa_nonexistent_route__",
  "/offline",
];

async function main() {
  const browser = await chromium.launch();
  const all = [];
  // ---- PHASE 1: negative controls ----
  // NC1: HTTP-assertion harness must FAIL when expecting 200 on a missing route.
  const nc1 = freshResult("NC1-HTTP", "harness", "HTTP assertion negative control");
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const r = await page.goto(`${BASE}/__qa_nonexistent_route__`, { waitUntil: "domcontentloaded" });
    nc1.actual = { status: r.status(), expectedByControl: 200 };
    nc1.state = r.status() === 200 ? "FAIL_CONTROL_BROKEN" : "FAIL_AS_EXPECTED";
    mkdirSync(join(EV, "NC1"), { recursive: true });
    writeFileSync(join(EV, "NC1", "nc1.json"), JSON.stringify(nc1, null, 2));
    await page.close();
  }
  // NC2: styling detector must FAIL on a synthetic unstyled page (no CSS, serif default).
  const nc2 = freshResult("NC2-STYLING", "harness", "styling detector negative control");
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(
      `<!doctype html><html><head><title>QA control</title></head><body><h1>Control</h1><button>btn</button></body></html>`,
    );
    await page.waitForTimeout(200);
    const styles = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return {
        stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length,
        bodyFont: cs.fontFamily,
        bodyBg: cs.backgroundColor,
      };
    });
    const v = { stylesheets: styles.stylesheets, bodyFont: styles.bodyFont, defaultBg: styles.bodyBg };
    nc2.actual = v;
    const detectedUnstyled = v.stylesheets === 0 && /times|serif/i.test(v.bodyFont);
    nc2.state = detectedUnstyled ? "FAIL_AS_EXPECTED" : "FAIL_CONTROL_BROKEN";
    writeFileSync(join(EV, "NC2-nc2.json"), JSON.stringify(nc2, null, 2));
    await page.close();
  }
  // NC3 handled by oracle script (qa-report/harness/oracle.mjs). Placeholder here.

  // ---- PHASE 2: route x viewport matrix ----
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      javaScriptEnabled: true,
      bypassCSP: false,
    });
    const page = await context.newPage();
    for (const route of ROUTES) {
      const res = await probePage(page, route, vp.name);
      res.verdict = verdict(res);
      all.push(res);
    }
    await context.close();
  }
  // JS-disabled render check for the two key public pages.
  const jsOff = [];
  for (const route of ["/login", "/signup"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    const resp = await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    const styles = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { font: cs.fontFamily, sheets: document.querySelectorAll('link[rel="stylesheet"]').length };
    });
    jsOff.push({ route, status: resp?.status() ?? 0, ...styles });
    await context.close();
  }
  const out = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    negativeControls: { nc1: nc1.state, nc2: nc2.state },
    matrix: all,
    jsDisabled: jsOff,
  };
  writeFileSync(join(EV, "S-matrix.json"), JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      all.map((r) => ({
        route: r.route,
        vp: r.viewport,
        status: r.httpStatus,
        verdict: r.verdict,
        css: r.stylesheets.length,
        errs: r.consoleMessages.length,
        badReq: r.badRequests.length,
      })),
      null,
      1,
    ),
  );
  await browser.close();
}
await main();

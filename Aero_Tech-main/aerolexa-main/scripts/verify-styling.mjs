#!/usr/bin/env node
/** Phase 2 — styling matrix across routes (against a RUNNING next start).
 *  For each public + authed route: assert the served HTML carries the
 *  render-blocking stylesheet <link>, that the CSS URL returns 200 with
 *  substantial bytes, and that the critters regression signature
 *  (media="print") is absent. Emits JSON for results.json.
 */
import { writeFileSync } from "node:fs";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:3199";
const routes = [
  "/",
  "/signup",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/offline",
  "/dashboard",
  "/dashboards",
  "/datasets",
  "/books",
  "/ca-compute",
  "/ca-sources",
  "/connectors",
  "/copilot",
  "/analyses",
  "/audit",
  "/projects",
  "/reports",
  "/notebooks",
  "/models",
  "/statutes",
  "/search",
  "/settings",
  "/presentations",
  "/studio",
  "/prompts",
  "/advisor",
  "/growth",
  "/notifications",
  "/scheduled-reports",
  "/templates",
  "/apps",
  "/embed",
];

function cssLinks(html) {
  return [...html.matchAll(/<link\b[^>]*?rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
}
const isCritters = (linkHtml) =>
  /media\s*=\s*"print"[^>]*rel="stylesheet"|rel="stylesheet"[^>]*media\s*=\s*"print"/i.test(linkHtml);

const rows = [];
for (const route of routes) {
  try {
    const res = await fetch(ORIGIN + route, {
      redirect: "follow",
      headers: process.env.COOKIE ? { cookie: process.env.COOKIE } : {},
    });
    const html = await res.text();
    const links = cssLinks(html);
    const critters = links.filter(isCritters);
    let cssStatus = null,
      cssBytes = 0;
    const href = links[0]?.match(/href="([^"]+)"/)?.[1];
    if (href) {
      const cssRes = await fetch(ORIGIN + href, { headers: { cookie: html.match(/Set-Cookie/i) ? "" : "" } });
      cssStatus = cssRes.status;
      cssBytes = Number(cssRes.headers.get("content-length") ?? (await cssRes.text()).length);
    }
    rows.push({
      route,
      status: res.status,
      stylesheets: links.length,
      crittersRegression: critters.length,
      cssStatus,
      cssBytes,
      styled: res.status === 200 && links.length > 0 && cssStatus === 200 && cssBytes > 5000 && critters.length === 0,
      finalUrl: res.url.replace(ORIGIN, ""),
    });
  } catch (err) {
    rows.push({ route, status: "ERR", error: String(err.message), styled: false });
  }
}

const summary = {
  routes: rows.length,
  styled: rows.filter((r) => r.styled).length,
  crittersRegression: rows.filter((r) => r.crittersRegression > 0).length,
};
writeFileSync("verification/styling.json", JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary));

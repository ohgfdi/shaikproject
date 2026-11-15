#!/usr/bin/env node
/** Phase 5 — robustness/perf subset against RUNNING `next start`.
 *  TTFB percentiles on a fixed route sample + cold-launch consistency.
 */
import { writeFileSync } from "node:fs";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:3199";
const routes = ["/", "/signup", "/login", "/dashboard", "/datasets", "/templates"];
const rows = [];
for (const r of routes) {
  const times = [];
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(ORIGIN + r);
      await res.text();
      last = res.status;
    } catch {
      last = 0;
    }
    times.push((performance.now() - t0) | 0);
  }
  times.sort((a, b) => a - b);
  rows.push({ route: r, status: last, p50: times[2], max: times[4] });
}
const p50s = rows.map((r) => r.p50).sort((a, b) => a - b);
const summary = {
  routes: rows.length,
  medianTTFB: p50s[Math.floor(p50s.length / 2)],
  worst: p50s[p50s.length - 1],
  all200: rows.every((r) => r.status === 200),
};
writeFileSync("verification/perf.json", JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary));

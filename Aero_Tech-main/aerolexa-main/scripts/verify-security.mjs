#!/usr/bin/env node
/** Phase 4 против a RUNNING `next start` — security spot flags + cookies.
 *  Checks: security headers present, cookie flags (HttpOnly/SameSite),
 *  XSS-ish reflected payload inert, no server error leakage on bad input.
 */
import { writeFileSync } from "node:fs";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:3199";
const find = {
  securityHeaders(pong) {
    const h = [];
    if (/content-security-policy/i.test(pong)) h.push("CSP");
    if (/strict-transport/i.test(pong)) h.push("HSTS");
    if (/x-content-type-options/i.test(pong)) h.push("nosniff");
    if (/x-frame-options/i.test(pong)) h.push("frame");
    if (/referrer-policy/i.test(pong)) h.push("referrer");
    if (/permissions-policy/i.test(pong)) h.push("permissions");
    return h;
  },
};

const rows = {};
function headersOf(res) {
  const out = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const res0 = await fetch(ORIGIN + "/");
rows.securityHeaders = find.securityHeaders(JSON.stringify(headersOf(res0)));

// signup sets the session cookie — check its flags
const probeEmail = `sec${Math.floor(Math.random() * 1e9)}@example.com`;
const res = await fetch(ORIGIN + "/api/auth/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Sec Probe", email: probeEmail, password: "Passw0rdprobe" }),
});
const setCookie = res.headers.get("set-cookie") ?? "";
rows.signup = {
  status: res.status,
  cookieFlags: {
    httpOnly: /httponly/i.test(setCookie),
    sameSite: /samesite/i.test(setCookie),
    secure: /secure/i.test(setCookie),
  },
};
rows.signup.body = await res.text().then((t) => t.slice(0, 120));

// injection probes — must NOT 500 and NOT echo raw
const probes = [
  `/api/auth/signup?x=${encodeURIComponent("<script>alert(1)</script>")}`,
  `/?q=${encodeURIComponent("' OR 1=1--")}`,
  `/login?next=${encodeURIComponent("https://evil.example.com")}`,
];
rows.injection = [];
for (const p of probes) {
  const r = await fetch(ORIGIN + p, { redirect: "manual" });
  const t = await r.text();
  rows.injection.push({
    path: p.slice(0, 40),
    status: r.status,
    echoedScript: t.includes("<script>alert(1)"),
    leakedStack: /at .+\.tsx?|Error: at node_modules/i.test(t.slice(0, 2000)),
  });
}

writeFileSync("verification/security.json", JSON.stringify(rows, null, 2));
console.log(
  JSON.stringify({
    headers: rows.securityHeaders,
    cookie: rows.signup.cookieFlags,
    injection: rows.injection.map(
      (i) => `${i.status}${i.echoedScript ? "-ECHOED" : ""}${i.leakedStack ? "-LEAK" : ""}`,
    ),
  }),
);

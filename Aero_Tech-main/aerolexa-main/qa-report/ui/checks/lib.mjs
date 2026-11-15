// Shared browser harness for qa-report/ui checks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const BASE_URL = process.env.QA_BASE_URL ?? "http://localhost:3000";
export const OUT = path.join(ROOT, "qa-report/ui");
export const EMAIL = process.env.QA_EMAIL ?? "ui-fixture@ledgerly.test";
export const PASSWORD = process.env.QA_PASSWORD ?? "uitest12345";
export const WIDTHS = [1440, 768, 390];

/**
 * Authenticate through the real API. Login first, sign up only when the
 * fixture account does not exist yet: the signup route is limited to 10/hour
 * per client, so a suite that signs up on every context rates itself out.
 */
export async function login(context) {
  const api = context.request;
  const res = await api.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (res.ok()) return context;
  const signup = await api.post(`${BASE_URL}/api/auth/signup`, {
    data: { name: "UI Fixture", email: EMAIL, password: PASSWORD },
  });
  if (!signup.ok()) {
    const body = await signup.text();
    throw new Error(`login ${res.status()} then signup ${signup.status()}: ${body.slice(0, 200)}`);
  }
  return context;
}

/**
 * One authenticated storage state per browser, reused by every context. This
 * keeps the login route inside its 30/10min budget however many contexts a
 * check needs.
 */
const stateCache = new WeakMap();
export async function authedState(browser) {
  if (stateCache.has(browser)) return stateCache.get(browser);
  const context = await browser.newContext();
  await login(context);
  const state = await context.storageState();
  await context.close();
  stateCache.set(browser, state);
  return state;
}

export async function newContext(browser, opts = {}) {
  const storageState = opts.storageState ?? (await authedState(browser));
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "no-preference",
    ...opts,
    storageState,
  });
}

/** Persist the sidebar preference before the app boots (after auth, before nav). */
export async function setSidebarState(context, collapsed) {
  await context.addInitScript(
    (value) => {
      try {
        window.localStorage.setItem("ledgerly.sidebar-collapsed", value);
      } catch {
        /* storage unavailable */
      }
    },
    collapsed ? "1" : "0",
  );
}

export async function withPage(opts, fn) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await newContext(browser, opts);
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") errors.push(text);
    if (/hydration|did not match/i.test(text)) warnings.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  try {
    return await fn(page, context, { errors, warnings });
  } finally {
    await browser.close();
  }
}

export function saveJson(name, value) {
  const file = path.join(OUT, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return path.relative(ROOT, file);
}

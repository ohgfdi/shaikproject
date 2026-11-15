/**
 * Automated accessibility gate (axe-core, WCAG AA).
 *
 * Signs up a fresh user, completes the first two onboarding steps (the upload
 * step is intentionally skipped — these are structural scans of the core
 * authenticated surface), then runs an axe scan over every main page. The
 * assertion is deliberately strict for things that break assistive tech:
 * no critical or serious violations on any scanned page. Minor violations are
 * reported to stdout for triage without failing the run.
 *
 * Every page is scanned in its own isolated browser context (session cookies
 * are copied from the signed-in context) so renderer memory is fully reclaimed
 * between scans and a constrained container can never OOM-kill the run. A
 * crashed scan is retried once on a fresh context; the assertions never relax.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SCAN_PAGES: { path: string; title: string }[] = [
  { path: "/dashboard", title: "Home" },
  { path: "/projects", title: "Projects" },
  { path: "/settings", title: "Settings" },
  { path: "/search", title: "Search" },
  { path: "/notifications", title: "Notifications" },
  { path: "/advisor", title: "Business Advisor" },
];

async function signupAndReachDashboard(page: Page) {
  const stamp = Date.now();
  const email = `a11y-${stamp}@example.dev`;

  await page.goto("/signup");
  await page.getByLabel("Full name").fill("A11y Auditor");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("Testpass123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding/);

  await page.getByRole("heading", { name: "What do you do?" }).waitFor();
  await page.getByRole("button", { name: "Data Analyst" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("heading", { name: "What are you trying to accomplish?" }).waitFor();
  await page.getByRole("button", { name: "Analyze business data" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Landing on the upload step proves onboarding completed; we skip the file.
  await page.getByRole("heading", { name: "Upload your dataset" }).waitFor({ timeout: 30_000 });
}

test("core authenticated pages have no critical or serious axe violations", async ({ page }) => {
  await signupAndReachDashboard(page);

  const browser = page.context().browser();
  expect(browser).not.toBeNull();
  const cookies = await page.context().cookies();
  await page
    .context()
    .close()
    .catch(() => undefined);

  const settle = async (target: Page, path: string) => {
    await target.goto(path, { waitUntil: "domcontentloaded" });
    await target.locator("main").waitFor({ timeout: 25_000 });
    await target.waitForTimeout(400); // hydration
  };

  for (const { path, title } of SCAN_PAGES) {
    console.log(`[a11y] scanning ${title} (${path})`);
    let results: Awaited<ReturnType<typeof AxeBuilder.prototype.analyze>> | null = null;

    for (let attempt = 0; attempt < 2 && !results; attempt++) {
      const context = await browser!.newContext();
      const target = await context.newPage();
      try {
        await context.addCookies(cookies);
        await settle(target, path);
        results = await new AxeBuilder({ page: target }).analyze();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`[a11y] renderer crash on ${path} (attempt ${attempt + 1}) — retrying: ${reason}`);
      } finally {
        await context.close().catch(() => undefined);
      }
    }
    expect(results, `${title} (${path}) could not be scanned`).not.toBeNull();

    const all = (results as NonNullable<typeof results>).violations;
    const violations = all.filter((v) => v.impact === "critical" || v.impact === "serious");

    if (all.length > 0) {
      console.log(`[axe] ${title} (${path}) — ${all.length} violation(s)`);
      for (const v of all) {
        const targets = v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ");
        console.log(`  - [${v.impact}] ${v.id}: ${v.help} — ${targets}`);
      }
    }

    expect(violations, `${title} (${path}) must have no critical/serious axe violations`).toEqual([]);
  }
});

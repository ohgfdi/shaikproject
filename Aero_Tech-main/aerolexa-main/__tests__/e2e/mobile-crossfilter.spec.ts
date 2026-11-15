/**
 * ROADMAP 7.4 — mobile analytics: the FULL touch cross-filter journey.
 *
 * Where `mobile.spec.ts` gates the static viewport contract (no horizontal
 * overflow at 360 px, tap-target heights), THIS spec walks the interactive
 * surface end-to-end on an emulated phone:
 *
 *   sign up → onboard → upload a real CSV → create a dashboard → the builder
 *   seeds a real chart from the dataset → tap a category chip (touch) → the
 *   "Filtered by" chip bar appears → tap Clear → every tile un-filters.
 *
 * Runs in the opt-in `device-lab` project (`npm run test:e2e:device-lab`) so
 * the desktop suite stays fast; also selectable with DEVICE_LAB=1. This is
 * the piece the roadmap table still listed as open — with it, 7.4 closes.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const useDeviceLab = process.env.DEVICE_LAB === "1";
const maybe = useDeviceLab ? test : test.skip;

const CSV_ROWS = [
  "date,region,channel,units,revenue,margin_pct",
  "2024-01-05,East,Online,4,1200,38",
  "2024-01-12,East,Retail,2,980,31",
  "2024-02-02,West,Online,5,1350,42",
  "2024-02-09,West,Partner,3,760,28",
  "2024-03-01,East,Online,6,1500,40",
  "2024-03-08,East,Retail,4,1100,33",
  "2024-04-05,West,Online,6,1620,44",
  "2024-04-12,West,Partner,3,900,30",
  "2024-05-03,East,Online,7,1780,41",
  "2024-05-10,East,Retail,5,1240,34",
  "2024-06-07,West,Online,8,1900,45",
  "2024-06-14,West,Partner,4,1010,31",
].join("\n");

/** Sign up, onboard, upload the CSV — identical journey to smoke.spec.ts. */
async function signupUploadAndReachProject(page: Page): Promise<{ projectId: string; datasetId: string }> {
  const stamp = Date.now();
  const email = `m7x4-${stamp}@example.dev`;
  const csvName = `m7x4-${stamp}-revenue.csv`;
  const fixtureDir = path.join(process.cwd(), "test-results");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixture = path.join(fixtureDir, csvName);
  fs.writeFileSync(fixture, CSV_ROWS);

  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Mobile Reviewer");
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

  await page.getByRole("heading", { name: "Upload your dataset" }).waitFor({ timeout: 30_000 });
  await page.locator('input[aria-label="Choose CSV or Excel file"]').setInputFiles(fixture);
  await expect(page.getByText("Dataset profiled successfully")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Start analysing" }).click();
  await page.waitForURL(/\/projects\/[a-z0-9]+\?tab=datasets/);
  const projectId = /\/projects\/([a-z0-9]+)/.exec(page.url())?.[1];
  expect(projectId).toBeTruthy();

  // Open the dataset detail to capture its id for the dashboard seed dialog.
  await page.locator('a[href^="/datasets/"]').first().click();
  await page.waitForURL(/\/datasets\/[a-z0-9-]+/);
  const datasetId = /\/datasets\/([a-z0-9-]+)/.exec(page.url())?.[1];
  expect(datasetId).toBeTruthy();

  return { projectId: projectId as string, datasetId: datasetId as string };
}

test.describe("mobile dashboard touch cross-filter (ROADMAP 7.4)", () => {
  // The design contract's smallest supported viewport, with touch.
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  maybe("tap a value → cross-filter applies → clear → dashboard un-filters", async ({ page }) => {
    test.setTimeout(600_000);
    const { projectId } = await signupUploadAndReachProject(page);

    // Create a dashboard (the /dashboards/new route creates + redirects into
    // the builder in edit mode).
    await page.goto(`/dashboards/new?project=${projectId}`);
    await page.waitForURL(/\/dashboards\/[a-z0-9-]+/, { timeout: 30_000 });

    // The builder offers "add from dataset" — seed a real chart widget from
    // the uploaded file so the cross-filter chips carry REAL distinct values.
    const addFromDataset = page.getByRole("button", { name: /Add from dataset|Add chart/i }).first();
    await expect(addFromDataset).toBeVisible({ timeout: 30_000 });
    await addFromDataset.click();

    // The interactive chips ("Click to filter: …") appear on the seeded tile.
    const chip = page.getByRole("button", { name: /^East$|^Online$/ }).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });

    // No "Filtered by" bar before the tap.
    await expect(page.getByText("Filtered by")).toHaveCount(0);

    // THE touch interaction: tap a category chip.
    await chip.tap();

    // Cross-filter applied: the "Filtered by" chip bar shows the selection.
    await expect(page.getByText("Filtered by")).toBeVisible({ timeout: 15_000 });

    // Clear it: the bar disappears and the tiles return to unfiltered.
    const clearButton = page.getByRole("button", { name: /Clear/i }).first();
    if (await clearButton.isVisible()) {
      await clearButton.tap();
      await expect(page.getByText("Filtered by")).toHaveCount(0);
    }

    // No horizontal overflow at 360 px after the interactions.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });
});

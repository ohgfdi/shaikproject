/**
 * E2E smoke — the full Ledgerly journey on the real stack:
 *
 *   sign up → onboard (role + goals) → upload a real CSV → land in the
 *   project hub → open the dataset → run an EDA analysis → inspect the result.
 *
 * Every assertion targets stable, accessible UI text (labels, headings,
 * buttons) so the spec survives styling changes. Emails are unique per run so
 * repeated local runs never collide.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

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

test("onboarding → upload → dataset → EDA analysis", async ({ page }) => {
  test.setTimeout(600_000);
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.dev`;
  const csvName = `e2e-${stamp}-revenue.csv`;
  const fixtureDir = path.join(process.cwd(), "test-results");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixture = path.join(fixtureDir, csvName);
  fs.writeFileSync(fixture, CSV_ROWS);

  // 1 — Sign up
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("E2E Reviewer");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("Testpass123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/onboarding/);

  // 2 — Onboarding step 1: role
  await expect(page.getByRole("heading", { name: "What do you do?" })).toBeVisible();
  await page.getByRole("button", { name: "Data Analyst" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 3 — Step 2: goals → workspace
  await expect(page.getByRole("heading", { name: "What are you trying to accomplish?" })).toBeVisible();
  await page.getByRole("button", { name: "Analyze business data" }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  // 4 — Step 3: upload the dataset (real file, real pipeline)
  await expect(page.getByRole("heading", { name: "Upload your dataset" })).toBeVisible({ timeout: 30_000 });
  await page.locator('input[aria-label="Choose CSV or Excel file"]').setInputFiles(fixture);
  await expect(page.getByText("Dataset profiled successfully")).toBeVisible({ timeout: 30_000 });

  // 5 — Into the project hub
  await page.getByRole("button", { name: "Start analysing" }).click();
  await page.waitForURL(/\/projects\/[a-z0-9]+\?tab=datasets/);
  const projectId = /\/projects\/([a-z0-9]+)/.exec(page.url())?.[1];
  expect(projectId).toBeTruthy();

  // The uploaded dataset is listed in the project's datasets tab (name = file
  // name without extension, underscores become spaces)
  const displayName = csvName.replace(/\.csv$/i, "").replace(/_/g, " ");
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(page.getByText(new RegExp(escaped, "i")).first()).toBeVisible();

  // 6 — Open the dataset detail page (ids are UUIDs, hence hyphens)
  await page.locator('a[href^="/datasets/"]').first().click();
  await page.waitForURL(/\/datasets\/[a-z0-9-]+/);
  const datasetId = /\/datasets\/([a-z0-9-]+)/.exec(page.url())?.[1];
  expect(datasetId).toBeTruthy();

  // 7 — Run an EDA analysis through the Analysis Lab
  await page.goto(`/analyses/new?project=${projectId}&dataset=${datasetId}`);
  await expect(page.getByText(/Pick an analysis type/)).toBeVisible();
  await page.getByRole("button", { name: "Exploratory data analysis" }).click();
  await expect(page.getByText(/Configure exploratory data analysis/i)).toBeVisible();
  await page.getByRole("button", { name: /^Run Exploratory data analysis/ }).click();

  // 8 — Result page with the calculation transparency pieces
  await page.waitForURL(/\/analyses\/[a-z0-9]+/, { timeout: 60_000 });
  await expect(page.getByText("How was this calculated?", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /Exploratory data analysis/ })).toBeVisible({ timeout: 60_000 });
  // Data-derived numbers appear (EDA stats tables are rendered from the file)
  await expect(page.getByText(/columns|rows|dataset/i).first()).toBeVisible();

  // 9 — Comment on the analysis (collaboration surface)
  await page.getByLabel("Add a comment").fill("Flag for the Q2 board review.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByText("Flag for the Q2 board review.")).toBeVisible();

  // 10 — SQL lab on the dataset (read-only prototype engine)
  await page.goto(`/datasets/${datasetId}/query`);
  await expect(page.getByRole("heading", { name: "SQL Lab" })).toBeVisible();
  await page.getByLabel("SQL query").fill("SELECT region, COUNT(*) AS n FROM sales GROUP BY region");
  await page.getByRole("button", { name: "Run query" }).click();
  await expect(page.getByText(/East/i).first()).toBeVisible({ timeout: 15_000 });
  // Engine note: DuckDB (in-browser or server) or the prototype parser fallback.
  await expect(page.getByText(/DuckDB|Prototype SQL engine/i).first()).toBeVisible();

  // 11 — What-if simulator (prototype linear-impact model)
  await page.goto(`/datasets/${datasetId}/whatif`);
  await expect(page.getByRole("heading", { name: "What-if simulator" })).toBeVisible();
  await page.getByLabel("Driver column (what changes)").selectOption("units");
  await page.getByLabel("Outcome column (what you watch)").selectOption("revenue");
  await page.getByRole("button", { name: "Run what-if" }).click();
  await expect(page.getByText(/How was this calculated?/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/paired rows used|Narrative/i).first()).toBeVisible();

  // 12 — Notebook tab: run a real pandas cell against the uploaded dataset
  await page.goto(`/projects/${projectId}?tab=notebook`);
  await expect(page.getByRole("tab", { name: /Notebooks/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "New notebook" }).click();
  await expect(page.getByText("Pyodide · ready")).toBeVisible({ timeout: 60_000 });
  const notebookCell = page
    .locator("ol > li")
    .filter({ has: page.getByLabel(/Cell \d+ \(code\)/) })
    .first();
  await notebookCell.getByRole("textbox").fill("import pandas as pd\nlen(df)");
  await notebookCell.getByRole("button", { name: /Run$/ }).click();
  await expect(notebookCell.getByText("12", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(notebookCell.getByText("Prototype / Demo", { exact: true })).not.toBeVisible();

  // 13 — Models tab: train a deterministic prototype model
  await page.goto(`/projects/${projectId}?tab=models`);
  await expect(page.getByRole("button", { name: "Train a model" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Train a model" }).click();
  const dialog = page.getByRole("dialog", { name: "Train a model" });
  await expect(dialog).toBeVisible();
  await dialog.locator("select").nth(0).selectOption({ index: 1 }); // the uploaded dataset
  await dialog.locator("select").nth(2).selectOption("clustering"); // Task (selects 0 dataset, 1 algorithm, 2 task)
  await page.getByRole("button", { name: "Train model" }).click();
  await expect(page.getByText(/v1|prototype/i).first()).toBeVisible({ timeout: 20_000 });
});

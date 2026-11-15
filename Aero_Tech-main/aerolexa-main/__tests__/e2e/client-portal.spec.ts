/**
 * Browser smoke test for the public client portal.
 *
 * The portal API is fulfilled in the browser so this test exercises the page
 * itself — rendering, the deliverable viewer and the upload form — without a
 * seeded database or a real portal token. Access control and rendering are
 * covered by the unit and route suites.
 */

import { expect, test } from "@playwright/test";

// The app registers a service worker that proxies /api GETs (offline snapshots).
// Playwright route interception does not see service-worker fetches, so block it
// here and let the mocks below own every portal request.
test.use({ serviceWorkers: "block" });

const TOKEN = "lpl_e2e_portal_token_0123456789";
const SNAPSHOT = {
  engagement: { name: "Acme Manufacturing", code: "ACME-FY26" },
  firmName: "Sharma & Co",
  linkExpiresAt: "2026-12-08T09:00:00.000Z",
  deliverables: [
    {
      id: "d1",
      formatCode: "FINANCIALS",
      label: "Financial statements",
      revision: 2,
      issuedAt: "2026-11-01T09:00:00.000Z",
      udin: null,
    },
  ],
  uploads: [],
};

test("client portal shows an issued deliverable and accepts an upload", async ({ page }) => {
  await page.route("**/api/portal/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/deliverables/")) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            deliverable: {
              versionId: "d1",
              formatCode: "FINANCIALS",
              formatLabel: "Financial statements",
              revision: 2,
              issuedAt: "2026-11-01T09:00:00.000Z",
              udin: null,
              contentHash: "abc",
              assembledBody: "Balance sheet",
              parts: [{ heading: "Balance Sheet", body: "Assets 1,00,000" }],
              redactions: [],
            },
          },
        },
      });
    }
    if (url.includes("/uploads")) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            upload: {
              id: "u1",
              filename: "bank.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1024,
              sha256: "abc",
              note: null,
              uploadedAt: "2026-11-08T09:00:00.000Z",
            },
          },
        },
      });
    }
    return route.fulfill({ json: { ok: true, data: { portal: SNAPSHOT } } });
  });

  await page.goto(`/portal/${TOKEN}`);

  await expect(page.getByRole("heading", { name: "Acme Manufacturing" })).toBeVisible();
  await expect(page.getByText("Financial statements")).toBeVisible();

  await page.getByRole("button", { name: "View" }).click();
  await expect(page.getByText("Assets 1,00,000")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.setInputFiles('input[type="file"]', {
    name: "bank.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n%%EOF\n"),
  });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByText("Document received.")).toBeVisible();
});

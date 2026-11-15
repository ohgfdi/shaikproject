import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke suite. Uses the production build for fast, reliable tests.
 *
 * Run with: npm run test:e2e
 */
export default defineConfig({
  testDir: "__tests__/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Container-friendly Chromium: shared-memory filesystems are small in CI/
    // sandboxes, and a full /dev/shm crashes the renderer on heavy pages.
    launchOptions: {
      args: ["--disable-dev-shm-usage"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // S10 device-lab matrix — opt-in: `DEVICE_LAB=1 npm run test:e2e` (or the
    // dedicated npm script). Skipped in the default run so desktop stays fast.
    {
      name: "device-lab",
      testIgnore: process.env.DEVICE_LAB === "1" ? [] : ["**/*"],
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://localhost:3000/login",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // cwd defaults to the directory of this config file — the app root.
    // (A hardcoded machine-specific path broke every other checkout.)
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * The suite drives the Vite *dev* server. AuthGate only seeds the mock user
 * when `import.meta.env.DEV` is set and Keycloak is unset; `vite preview` of a
 * production build would bounce every surface at the IdP.
 *
 * Vite's own default in this repo is port 3000. The harness pins 5173 so a
 * long-running app on 3000 is not the thing under test.
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT) || 5173;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One Vite dev server. More than a couple of browsers starve it while it
  // transforms the room chunk, and the shell sits on "Loading workspace…".
  workers: process.env.CI ? 1 : 2,
  timeout: 120_000,
  expect: { timeout: 60_000 },
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-mobile",
      use: {
        // iPhone 12's preset browser is WebKit. This project is Chromium at
        // the phone viewport; override the preset or Playwright looks for a
        // WebKit binary this job does not install.
        ...devices["iPhone 12"],
        defaultBrowserType: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  outputDir: "test-results",
});

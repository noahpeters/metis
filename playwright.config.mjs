import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/ui",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx wrangler dev --config wrangler.ui.jsonc --port 8788 --var ENVIRONMENT:local --var LOCAL_AUTH_ENABLED:true --var LOCAL_AUTH_EMAIL:ui-test@from-trees.com",
    url: "http://127.0.0.1:8788",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

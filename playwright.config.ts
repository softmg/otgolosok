import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: "http://localhost:3217", viewport: { width: 390, height: 844 }, screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    // Layout invariants also run in WebKit, the engine of every iPhone browser.
    { name: "webkit", testMatch: ["layout-invariants.spec.ts", "silent-media.spec.ts"], use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: { command: "pnpm dev --port 3217", url: "http://localhost:3217", reuseExistingServer: !process.env.CI },
});

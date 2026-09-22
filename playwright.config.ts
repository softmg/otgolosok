import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: "http://localhost:3217", viewport: { width: 390, height: 844 }, screenshot: "only-on-failure" },
  webServer: { command: "pnpm dev --port 3217", url: "http://localhost:3217", reuseExistingServer: !process.env.CI },
});

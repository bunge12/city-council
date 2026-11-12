import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCI,
  // CI runners have no GPU. On the software WebGL fallback a page load with
  // the full map takes several seconds, and a test that reloads twice runs
  // close to Playwright's 30 s default when two workers share the machine.
  timeout: 60_000,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});

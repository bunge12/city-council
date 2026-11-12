import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env["CI"]);

/**
 * Where the M0 walkthrough runs. Unset, it runs against a production build
 * served by `vite preview`. Set it to the public address to check the
 * deployed game, for example
 * `BASE_URL=https://bunge12.github.io/city-council/ pnpm e2e --project walkthrough`.
 * Keep the trailing slash: the walkthrough opens pages relative to it.
 */
const remoteBase = process.env["BASE_URL"];
const walkthroughBase = remoteBase ?? "http://localhost:4173/";

/**
 * WebGPU for the walkthrough. Chrome on macOS and Windows has it on. On
 * Linux, Chromium needs the flag, and on a machine with no GPU, such as a CI
 * runner, Vulkan through SwiftShader gives it a software adapter.
 */
const webGpuArgs =
  process.platform === "linux"
    ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"]
    : ["--enable-unsafe-webgpu"];

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
  projects: [
    {
      name: "chromium",
      testIgnore: "walkthrough.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The M0 exit test, on the built client, on WebGPU and on WebGL 2.
      // It runs headed in the full Chromium build: the headless shell loses
      // its WebGPU device, and a headless page's screenshots leave out a
      // WebGPU canvas. On Linux without a display, run it under `xvfb-run`.
      name: "walkthrough",
      testMatch: "walkthrough.spec.ts",
      // Software WebGPU takes most of a CI runner's CPU, and a page in
      // another test then misses key presses. So the walkthrough starts
      // after the other projects finish. Against a public address it runs
      // alone.
      dependencies: remoteBase ? [] : ["chromium"],
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        headless: false,
        baseURL: walkthroughBase,
        launchOptions: { args: webGpuArgs },
      },
    },
  ],
  // Against a public address nothing local is needed. Run only the
  // walkthrough project then: the others expect the dev server.
  webServer: remoteBase
    ? []
    : [
        {
          command: "pnpm dev",
          url: "http://localhost:5173",
          reuseExistingServer: !isCI,
          timeout: 60_000,
        },
        {
          command: "pnpm --filter @city-council/client build && pnpm --filter @city-council/client preview",
          url: "http://localhost:4173",
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
      ],
});

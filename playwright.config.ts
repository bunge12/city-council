import { defineConfig, devices } from "@playwright/test";
import projectFiles from "./e2e/projects.json" with { type: "json" };

const isCI = Boolean(process.env["CI"]);

/** The walkthrough's spec files, a pattern shared with scripts/e2e-shard.mjs (e2e/projects.json). */
const walkthroughFiles = new RegExp(projectFiles.walkthrough);

/**
 * Where the walkthroughs run. Unset, they run against a production build
 * served by `vite preview`. Set it to the public address to check the
 * deployed game, for example
 * `BASE_URL=https://bunge12.github.io/city-council/ pnpm e2e --project walkthrough`.
 * Keep the trailing slash: the walkthrough opens pages relative to it.
 */
const remoteBase = process.env["BASE_URL"];
const walkthroughBase = remoteBase ?? "http://localhost:4173/";

/**
 * Only the walkthrough opens the production build. A CI runner that runs
 * another project sets E2E_DEV_SERVER_ONLY and skips building and serving
 * it, which saves it about twenty seconds before its first test.
 */
const devServerOnly = process.env["E2E_DEV_SERVER_ONLY"] === "1";

/**
 * WebGPU for the walkthrough. Chrome on macOS and Windows has it on. On
 * Linux, Chromium needs the flag, and on a machine with no GPU, such as a CI
 * runner, Vulkan through SwiftShader gives it a software adapter.
 */
const webGpuArgs =
  process.platform === "linux"
    ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"]
    : ["--enable-unsafe-webgpu"];

/**
 * Every test starts in a browser that already keeps the Low graphics preset
 * (issue M2-02), as if the player had chosen it. Otherwise each test's fresh
 * browser would run the first-run benchmark, which on a runner without a GPU
 * takes seconds of drawing. Tests of the presets and the benchmark clear it.
 */
const lowPreset = JSON.stringify({ preset: "low", source: "player", benchmarkMs: null, benchmarkBackend: null });
const keptPreset = {
  cookies: [],
  origins: ["http://localhost:5173", "http://localhost:4173"].map((origin) => ({
    origin,
    localStorage: [{ name: "city-council:graphics", value: lowPreset }],
  })),
};

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCI,
  // CI runners have no GPU. On the software WebGL fallback a page load with
  // the full map takes several seconds, and a test that reloads twice runs
  // close to Playwright's 30 s default when two workers share the machine.
  timeout: 60_000,
  retries: isCI ? 1 : 0,
  // In CI, file-times-reporter.ts prints the runner's CPU and each spec
  // file's seconds, for e2e/projects.json (see scripts/e2e-timings.mjs).
  reporter: isCI ? [["list"], ["html", { open: "never" }], ["./e2e/file-times-reporter.ts"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
    storageState: keptPreset,
  },
  projects: [
    {
      name: "chromium",
      // Every file the other projects do not run. In CI its files are dealt
      // out to runners by scripts/e2e-shard.mjs, by how long each takes.
      testIgnore: [walkthroughFiles, ...projectFiles.roads, ...(process.env["SCALE_WEBGPU"] ? ["scale.spec.ts"] : [])],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Road rendering (issue M1-06), on WebGPU and on WebGL 2, compared
      // with the same screenshots. Headed for the same reasons as the
      // walkthrough, against the dev server. It starts after the chromium
      // project, since software WebGPU takes most of a CI runner's CPU.
      // In CI each project has runners of its own (see
      // .github/workflows/ci.yml). There the tests of this one file are
      // split over three of them with `--shard`, which only splits a file
      // when the project is fully parallel, and each runs one worker.
      name: "roads",
      // With SCALE_WEBGPU set, the scale check runs here too, for its WebGPU numbers (see scale.spec.ts).
      testMatch: process.env["SCALE_WEBGPU"] ? [...projectFiles.roads, "scale.spec.ts"] : projectFiles.roads,
      fullyParallel: isCI,
      dependencies: remoteBase ? [] : ["chromium"],
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        headless: false,
        launchOptions: { args: webGpuArgs },
      },
    },
    {
      // The M0, M1 and M2 exit tests, on the built client, on WebGPU and on WebGL 2.
      // It runs headed in the full Chromium build: the headless shell loses
      // its WebGPU device, and a headless page's screenshots leave out a
      // WebGPU canvas. On Linux without a display, run it under `xvfb-run`.
      name: "walkthrough",
      testMatch: walkthroughFiles,
      // Software WebGPU takes most of a CI runner's CPU, and a page in
      // another test then misses key presses. So the walkthrough starts
      // after the other projects finish. Against a public address it runs
      // alone.
      dependencies: remoteBase ? [] : ["roads"],
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
        ...(devServerOnly
          ? []
          : [
              {
                command: "pnpm --filter @city-council/client build && pnpm --filter @city-council/client preview",
                url: "http://localhost:4173",
                reuseExistingServer: !isCI,
                timeout: 120_000,
              },
            ]),
      ],
});

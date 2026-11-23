import { defineConfig, devices } from "@playwright/test";
import { MEASURE_STATE, PLAYER_STATE, TEST_STATE } from "./e2e/browser-state";
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

export default defineConfig({
  testDir: "e2e",
  forbidOnly: isCI,
  // CI runners have no GPU. On the software WebGL fallback a page load with
  // the full map takes several seconds, and a test that reloads twice runs
  // close to Playwright's 30 s default when two workers share the machine.
  timeout: 60_000,
  retries: isCI ? 1 : 0,
  // In CI, file-times-reporter.ts prints the runner's CPU and writes it,
  // each file's and test's seconds and each retried test to e2e-times.json,
  // which the CI jobs upload (issue #229, scripts/e2e-timings.mjs).
  reporter: isCI ? [["list"], ["html", { open: "never" }], ["./e2e/file-times-reporter.ts"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    // A test that fails on its first attempt keeps its trace, and every
    // failure keeps a screenshot, both under test-results/ (issue #228). The
    // trace has the steps, console, network and sources, but no screenshots
    // or DOM snapshots: with snapshots grid-tool.spec.ts took 2.1 minutes on
    // two cores instead of 1.4, without them 1.5.
    trace: { mode: "retain-on-first-failure", screenshots: false, snapshots: false },
    screenshot: "only-on-failure",
    // The Low preset kept, and per project below the test switch (e2e/browser-state.ts).
    storageState: PLAYER_STATE,
  },
  projects: [
    {
      name: "chromium",
      // Every file the other projects do not run. In CI its files are dealt
      // out to runners by scripts/e2e-shard.mjs, by how long each takes.
      testIgnore: [walkthroughFiles, ...projectFiles.roads, ...projectFiles.perf, ...projectFiles.evidence],
      // Cheap frames and no autosave on an interval (issue #226). A spec that tests saving overrides it.
      use: { ...devices["Desktop Chrome"], storageState: TEST_STATE },
    },
    {
      // Road rendering (issue M1-06), on WebGPU and on WebGL 2, compared
      // with the same screenshots. Headed for the same reasons as the
      // walkthrough, against the dev server. It starts after the chromium
      // project, since software WebGPU takes most of a CI runner's CPU.
      // In CI each project has runners of its own (see
      // .github/workflows/ci.yml). There its tests are dealt out to three of
      // them by scripts/e2e-shard.mjs, by each test's seconds, and each runs
      // one worker. Fully parallel, so that the tests of one file can run
      // apart.
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
    {
      // Frame time, draw calls and memory on the scale cities (issue #225),
      // on WebGL 2, headless like the chromium project except the two
      // 30,000 segment specs that came from the roads project, which ask
      // for headed Chromium themselves (see cells-scale.spec.ts). Each spec writes its
      // figures to test-results/perf/, which .github/workflows/perf.yml sets
      // beside main's. It does not gate a merge: CI runs it nightly, after
      // each push to main and on pull requests that touch the renderer or
      // carry the `perf` label. It starts after the walkthrough so nothing
      // else shares the machine while it measures; run it alone with
      // `pnpm e2e --project perf --no-deps`. With SCALE_WEBGPU set, the
      // scale check runs in the roads project instead.
      name: "perf",
      // A perf test that timed out on a slow runner times out again on its
      // retry, and its figures come from a runner that was already slow.
      retries: 0,
      // One limit for every perf test, and no spec sets its own (issue #319,
      // `perfLimit` in e2e/projects.json, scripts/check-e2e-timeouts.mjs).
      timeout: projectFiles.perfLimit.testMinutes * 60_000,
      testMatch: process.env["SCALE_WEBGPU"] ? projectFiles.perf.filter((f) => f !== "scale.spec.ts") : projectFiles.perf,
      dependencies: remoteBase ? [] : ["walkthrough"],
      // Every frame drawn at the real settings, and no autosave in a measurement (issue #226).
      use: { ...devices["Desktop Chrome"], storageState: MEASURE_STATE },
    },
    {
      // Pictures for a pull request that changes what the city looks like
      // (issue #225), with no check a unit or chromium test does not make.
      // It runs where perf does, and with the `evidence` label.
      name: "evidence",
      testMatch: projectFiles.evidence,
      dependencies: remoteBase ? [] : ["perf"],
      // Pictures at the real settings, as a player sees them (issue #226).
      use: { ...devices["Desktop Chrome"], storageState: MEASURE_STATE },
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

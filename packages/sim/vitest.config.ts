import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds the scale city once per run, and the scale town in bench runs,
    // for the scale tests and benches to load (issue #230).
    globalSetup: ["./test/scale-setup.ts"],
    // A worker per core. Vitest leaves one for its own process by default,
    // but that process waits while the sim's tests run (issue #230).
    maxWorkers: "100%",
    // A test's time limit is there to stop one that hangs, not to hold its
    // speed: `pnpm test` holds no wall-clock time (PRD, Testing). Vitest's
    // default of 5 s failed the randomised tests at 5.3 to 5.8 s on the
    // slowest CI runners, about eleven times from 21 to 23 November 2026 (issue
    // #319). scripts/check-e2e-timeouts.mjs holds this at a minute or more.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The benches collect before each case they hold to a budget, so the
    // garbage of the setup or the case before is not collected inside its
    // runs (test/budget.ts, issue #231). The tests do not call it.
    execArgv: ["--expose-gc"],
    benchmark: {
      // In bench mode Vitest wraps every export in a getter that counts its
      // calls, to warn when a bench calls across modules a lot. The sim's hot
      // loops do, by design, so the counting adds a cost a built game never
      // pays: on the 30,000 segment city it took the grid step from 14 ms to
      // 27 ms. The benches time the sim, so they run without it.
      suppressExportGetterWarnings: true,
    },
  },
});

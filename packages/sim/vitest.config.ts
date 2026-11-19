import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds the scale city once per run, and the scale town in bench runs,
    // for the scale tests and benches to load (issue #230).
    globalSetup: ["./test/scale-setup.ts"],
    // A worker per core. Vitest leaves one for its own process by default,
    // but that process waits while the sim's tests run (issue #230).
    maxWorkers: "100%",
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

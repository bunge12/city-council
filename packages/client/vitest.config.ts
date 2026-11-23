import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The page's Vite config, with what the benches need (issue #231).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // As in packages/sim/vitest.config.ts: the limit stops a test that
      // hangs, and holds no speed (issue #319).
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // The scale cities' bench collects before each city it times, as the
      // sim's benches do (packages/sim/vitest.config.ts): on the third city
      // the garbage of generating all three landed in one tick as a 440 ms
      // pause. The tests do not call it.
      execArgv: ["--expose-gc"],
      benchmark: {
        // As in packages/sim/vitest.config.ts: the benches time the code,
        // not Vitest counting calls across modules.
        suppressExportGetterWarnings: true,
      },
    },
  }),
);

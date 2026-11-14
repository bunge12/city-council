import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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

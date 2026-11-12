import { defineConfig } from "vitest/config";

// The soak run in soak/, kept out of `pnpm test`. See soak/soak.soak.ts.
export default defineConfig({
  test: {
    include: ["soak/**/*.soak.ts"],
    environment: "node",
    testTimeout: 600_000,
    // Expose gc so the heap readings at start and end follow a full GC.
    execArgv: ["--expose-gc"],
  },
});

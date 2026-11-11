import { expect, test } from "@playwright/test";
import fixture from "../packages/sim/test/fixtures/terrain-hashes.json" with { type: "json" };

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the parts used here are declared.
declare const window: {
  cityCouncil: {
    terrainCheck(seed: number): {
      heightsHash: string;
      terrainHash: string;
      buildableShare: number;
      attempts: number;
      ms: number;
    };
  };
};

// The same committed hashes the Vitest suite checks in Node. Terrain is
// rebuilt from the seed on every machine, so the browser must match exactly.
for (const { seed, heights, terrain } of fixture.seeds) {
  test(`terrain for seed ${seed} matches the Node hashes`, async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => "cityCouncil" in globalThis);
    const check = await page.evaluate((s) => window.cityCouncil.terrainCheck(s), seed);
    console.log(`seed ${seed}: generated in ${check.ms.toFixed(0)} ms, attempts ${check.attempts}`);
    expect(check.heightsHash).toBe(heights);
    expect(check.terrainHash).toBe(terrain);
  });
}

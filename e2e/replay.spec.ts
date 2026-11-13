import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The replay fixtures the Vitest suite checks in Node, replayed in the
// browser. The sim runs the same commands from the same seed, so the state
// hash must match exactly (CLAUDE.md rules 3 to 6).

interface Fixture {
  description: string;
  seed: number;
  untilTick: number;
  log: unknown[];
  hash: string;
}

// The hook packages/client/src/main.ts puts on the page. The tooling
// tsconfig has no DOM types, so the part used here is declared.
declare const window: {
  cityCouncil: { replayCheck(seed: number, log: unknown[], untilTick: number): { hash: string; logLength: number } };
};

const dir = new URL("../packages/sim/test/fixtures/replay/", import.meta.url);
const fixtures = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, fixture: JSON.parse(readFileSync(new URL(name, dir), "utf8")) as Fixture }));

test("there are replay fixtures to check, the curves one among them", () => {
  expect(fixtures.map((f) => f.name)).toContain("curves.json");
});

for (const { name, fixture } of fixtures) {
  test(`replay fixture ${name} gives its Node hash in the browser`, async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => "cityCouncil" in globalThis);
    const result = await page.evaluate(
      ([seed, log, untilTick]) => window.cityCouncil.replayCheck(seed, log, untilTick),
      [fixture.seed, fixture.log, fixture.untilTick] as const,
    );
    expect(result.logLength).toBe(fixture.log.length);
    expect(result.hash).toBe(fixture.hash);
  });
}

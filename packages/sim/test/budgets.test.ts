// The budgets file and how a figure is judged against it (issue #232).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BUDGETS, BUDGET_INHERITED_WITHIN, BUDGET_WARN_BELOW_HEADROOM, budgetFigure, judgeBudget } from "../src/index";

describe("budgets.json", () => {
  test("every figure is held by a bench or the soak", () => {
    const root = join(import.meta.dirname, "../..");
    const sources = [
      ...readdirSync(join(root, "sim/test")).filter((f) => f.endsWith(".bench.ts")).map((f) => join(root, "sim/test", f)),
      ...readdirSync(join(root, "client/test")).filter((f) => f.endsWith(".bench.ts")).map((f) => join(root, "client/test", f)),
      join(root, "client/soak/soak.soak.ts"),
    ].map((path) => readFileSync(path, "utf8"));
    const unused = Object.keys(BUDGETS).filter((id) => !sources.some((s) => s.includes(`"${id}"`)));
    expect(unused).toEqual([]);
  });

  test("the soak's figures share one step time, which its report counts against", () => {
    const soak = Object.entries(BUDGETS).filter(([id]) => id.startsWith("soak."));
    expect(soak.length).toBeGreaterThan(0);
    expect(new Set(soak.map(([, f]) => f.overMs)).size).toBe(1);
  });

  test("warns below more than 1x headroom", () => {
    expect(BUDGET_WARN_BELOW_HEADROOM).toBeGreaterThan(1);
  });

  test("an unknown figure throws, so a typo fails the bench", () => {
    expect(() => budgetFigure("no.such-figure")).toThrow(/no figure no.such-figure/);
  });
});

describe("judgeBudget", () => {
  test("takes the figure's statistic from the timings", () => {
    const figure = budgetFigure("grower.tick");
    expect(figure.statistic).toBe("p50");
    const row = judgeBudget("grower.tick", "a tick", { mean: 100, p50: figure.budget / 4, max: 1000 });
    expect(row).toMatchObject({ figure: "grower.tick", case: "a tick", measured: figure.budget / 4, headroom: 4, pass: true });
  });

  test("a time passes under its budget, not at it", () => {
    const { budget } = budgetFigure("town.step");
    expect(judgeBudget("town.step", "a step", { mean: budget }).pass).toBe(false);
    expect(judgeBudget("town.step", "a step", { mean: budget * 0.99 }).pass).toBe(true);
    expect(judgeBudget("town.step", "a step", { mean: budget * 2 }).headroom).toBe(0.5);
  });

  test("a count passes at its budget, and with none over has no headroom to show", () => {
    const { budget } = budgetFigure("soak.idle-steps");
    expect(judgeBudget("soak.idle-steps", "idle steps", budget).pass).toBe(true);
    expect(judgeBudget("soak.idle-steps", "idle steps", budget + 1).pass).toBe(false);
    expect(judgeBudget("soak.idle-steps", "idle steps", 0).headroom).toBeNull();
  });

  test("a miss the base already had on this machine is inherited, and one the change made is not", () => {
    const { budget } = budgetFigure("town.step");
    const over = budget * 1.05;
    expect(judgeBudget("town.step", "a step", { mean: over })).toMatchObject({ pass: false, inherited: false, base: null });
    expect(judgeBudget("town.step", "a step", { mean: over }, over)).toMatchObject({ pass: false, inherited: true, base: over });
    expect(judgeBudget("town.step", "a step", { mean: over }, over / BUDGET_INHERITED_WITHIN)).toMatchObject({ pass: false, inherited: true });
    expect(judgeBudget("town.step", "a step", { mean: over }, over / (BUDGET_INHERITED_WITHIN * 1.01)).inherited).toBe(false);
    expect(judgeBudget("town.step", "a step", { mean: over }, budget * 0.5).inherited).toBe(false);
  });

  test("a figure inside its budget is not inherited, whatever the base", () => {
    const { budget } = budgetFigure("town.step");
    expect(judgeBudget("town.step", "a step", { mean: budget * 0.5 }, budget * 2)).toMatchObject({ pass: true, inherited: false });
  });

  test("a count of steps is never inherited, and a base of nothing is no base", () => {
    const { budget } = budgetFigure("soak.idle-steps");
    expect(judgeBudget("soak.idle-steps", "idle steps", budget + 1, budget + 1)).toMatchObject({ pass: false, inherited: false });
    const step = budgetFigure("town.step").budget;
    for (const base of [0, -1, Number.NaN, Infinity]) {
      expect(judgeBudget("town.step", "a step", { mean: step * 2 }, base)).toMatchObject({ inherited: false, base: null });
    }
  });

  test("refuses a measurement of the wrong kind", () => {
    expect(() => judgeBudget("town.step", "a step", 3)).toThrow(/pass the case's timings/);
    expect(() => judgeBudget("soak.idle-steps", "idle steps", { mean: 3 })).toThrow(/pass the number/);
    expect(() => judgeBudget("grower.tick", "a tick", { mean: 3 })).toThrow(/has no p50/);
  });
});

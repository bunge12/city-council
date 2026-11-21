import { describe, expect, it } from "vitest";
import { DEMAND_BALANCE, POPS_BALANCE, checkDemandBalance, checkPopsBalance } from "../src/index";
import { resolveDemandBalance } from "../src/demand/balance";
import { resolvePopsBalance } from "../src/pops/balance";
import demandJson from "../balance/demand.json" with { type: "json" };
import popsJson from "../balance/pops.json" with { type: "json" };

// M3-01: the pop and demand numbers have a home in the balance files, and a
// file with a field missing or out of range is refused with a clear error.

type Json = Record<string, unknown>;
const clone = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** `data` with the field at `path` removed. */
function without(data: unknown, path: string[]): Json {
  const out = clone(data);
  const last = path.at(-1) as string;
  let at: Json = out;
  for (const key of path.slice(0, -1)) at = at[key] as Json;
  const kept = Object.fromEntries(Object.entries(at).filter(([key]) => key !== last));
  if (path.length === 1) return kept;
  let parent: Json = out;
  for (const key of path.slice(0, -2)) parent = parent[key] as Json;
  parent[path.at(-2) as string] = kept;
  return out;
}

/** `data` with the field at `path` set to `value`. */
function withField(data: unknown, path: string[], value: unknown): Json {
  const out = clone(data);
  let at: Json = out;
  for (const key of path.slice(0, -1)) at = at[key] as Json;
  at[path.at(-1) as string] = value;
  return out;
}

/** Every path to a number or a list in `data`, skipping words for people. */
function leaves(data: unknown, path: string[] = []): string[][] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [path];
  return Object.entries(data)
    .filter(([key]) => !key.startsWith("_"))
    .flatMap(([key, inner]) => leaves(inner, [...path, key]));
}

/** Every path to an object or a leaf in `data`, so a whole group can go missing too. */
function fields(data: unknown, path: string[] = []): string[][] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [path];
  const own = path.length > 0 ? [path] : [];
  return [...own, ...Object.entries(data).filter(([key]) => !key.startsWith("_")).flatMap(([key, inner]) => fields(inner, [...path, key]))];
}

describe("the pops balance", () => {
  it("is well formed and holds the numbers later issues read", () => {
    expect(checkPopsBalance(popsJson)).toEqual([]);
    expect(POPS_BALANCE.popSizeCap).toEqual([5, 20, 100]);
    // The one turnover number the PRD fixes.
    expect(POPS_BALANCE.turnover.childrenLeaveYears).toBe(18);
    expect(POPS_BALANCE.workerShare.withChildren).toBeLessThan(POPS_BALANCE.workerShare.withoutChildren);
  });

  it("names every missing field", () => {
    for (const path of fields(popsJson)) {
      const errors = checkPopsBalance(without(popsJson, path));
      expect(errors.join("; "), path.join(".")).toMatch(`${path.join(".")} is missing`);
    }
  });

  it("refuses numbers out of range", () => {
    const bad = (path: string[], value: unknown) => checkPopsBalance(withField(popsJson, path, value));
    expect(bad(["popSizeCap"], [5, 20])).toEqual(["popSizeCap must list 3 whole numbers from 1 to 255, one per density"]);
    expect(bad(["popSizeCap"], [0, 20, 100])).toEqual(["popSizeCap must list 3 whole numbers from 1 to 255, one per density"]);
    expect(bad(["popSizeCap"], [5, 2.5, 100])).toEqual(["popSizeCap must list 3 whole numbers from 1 to 255, one per density"]);
    expect(bad(["popSizeCap"], [20, 5, 100])).toEqual(["popSizeCap must not fall as density rises"]);
    expect(bad(["newcomer", "education", "high"], 1.2)).toEqual(["newcomer.education.high must be a share from 0 to 1"]);
    expect(bad(["newcomer", "wealth", "high"], 0.3)).toEqual([expect.stringMatching(/^newcomer\.wealth must add to 1/)]);
    expect(bad(["newcomer", "childrenShare"], -0.1)).toEqual(["newcomer.childrenShare must be a share from 0 to 1"]);
    expect(bad(["workerShare", "withChildren"], 0.7)).toEqual(["workerShare.withChildren must not be above workerShare.withoutChildren"]);
    expect(bad(["workerShare", "withChildren"], 2)).toEqual(["workerShare.withChildren must be a number at least 0 and at most 1"]);
    expect(bad(["turnover", "deathsPerPersonYear"], -0.01)).toEqual(["turnover.deathsPerPersonYear must be a number at least 0 and at most 1"]);
    expect(bad(["turnover", "childrenLeaveYears"], 0)).toEqual(["turnover.childrenLeaveYears must be a number above 0"]);
    expect(bad(["turnover", "replacementsPerPopYear"], "5%")).toEqual(["turnover.replacementsPerPopYear must be a number at least 0 and at most 1"]);
    expect(bad(["turnover", "marriages"], 0.1)).toEqual(['turnover has an unknown field "marriages"']);
    expect(bad(["pets"], 1)).toEqual(['the file has an unknown field "pets"']);
    expect(checkPopsBalance([])).toEqual(["the pops balance is not an object"]);
  });

  it("throws naming the file when loaded with a problem", () => {
    expect(() => resolvePopsBalance(without(popsJson, ["turnover", "birthsPerPersonYear"]))).toThrow("balance/pops.json: turnover.birthsPerPersonYear is missing");
  });
});

describe("the demand balance", () => {
  it("is well formed and holds the numbers later issues read", () => {
    expect(checkDemandBalance(demandJson)).toEqual([]);
    // About 17,000 new residents a game year at full demand, from "Pacing" in the PRD.
    expect(DEMAND_BALANCE.arrivalsPerYearAtFullDemand).toBe(17000);
    expect(DEMAND_BALANCE.outsidePull.bar).toBeGreaterThan(0);
    // Open office jobs count against industrial demand (M3.md, "Office standing in for industry").
    expect(DEMAND_BALANCE.industrial.openOfficeJobs).toBeLessThan(0);
  });

  it("names every missing field", () => {
    for (const path of fields(demandJson)) {
      const errors = checkDemandBalance(without(demandJson, path));
      expect(errors.join("; "), path.join(".")).toMatch(`${path.join(".")} is missing`);
    }
  });

  it("refuses a weight with the wrong sign for what the PRD says it does", () => {
    for (const path of leaves(demandJson).filter((p) => ["residential", "commercial", "office", "industrial"].includes(p[0] ?? ""))) {
      const value = Number(path.reduce<unknown>((at, key) => (at as Json)[key], demandJson));
      const errors = checkDemandBalance(withField(demandJson, path, -value || -1));
      expect(errors, path.join(".")).toEqual([expect.stringMatching(`^${path.join("\\.")} must be a number`)]);
    }
  });

  it("refuses numbers out of range", () => {
    const bad = (path: string[], value: unknown) => checkDemandBalance(withField(demandJson, path, value));
    expect(bad(["dailyShare"], 0)).toEqual(["dailyShare must be a number above 0 and at most 1"]);
    expect(bad(["dailyShare"], 1.5)).toEqual(["dailyShare must be a number above 0 and at most 1"]);
    expect(bad(["arrivalsPerYearAtFullDemand"], -1)).toEqual(["arrivalsPerYearAtFullDemand must be a number at least 0"]);
    expect(bad(["outsidePull", "bar"], 150)).toEqual(["outsidePull.bar must be a number at least 0 and at most 100"]);
    expect(bad(["outsidePull", "untilResidents"], 12.5)).toEqual(["outsidePull.untilResidents must be a whole number at least 0"]);
    expect(bad(["spendingByWealth", "high"], -2)).toEqual(["spendingByWealth.high must be a number at least 0"]);
    expect(bad(["residential", "openJobs"], Number.NaN)).toEqual(["residential.openJobs must be a number at least 0 and at most 1000"]);
    expect(bad(["residential", "taxes"], -1)).toEqual(['residential has an unknown field "taxes"']);
    expect(bad(["farming"], {})).toEqual(['the file has an unknown field "farming"']);
    expect(checkDemandBalance(null)).toEqual(["the demand balance is not an object"]);
  });

  it("throws naming the file when loaded with a problem", () => {
    expect(() => resolveDemandBalance(withField(demandJson, ["dailyShare"], 2))).toThrow("balance/demand.json: dailyShare must be a number above 0 and at most 1");
  });
});

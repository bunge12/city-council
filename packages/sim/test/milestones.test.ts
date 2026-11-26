// Population milestones, their grants and the density unlocks (M4-12).

import { describe, expect, it } from "vitest";
import {
  BUILDING_ALIVE,
  BUILDING_TYPES,
  CREDITED,
  DENSITY_UNLOCKS,
  LINE,
  MILESTONES,
  TIME_BALANCE,
  UNLOCKS,
  checkMilestones,
  checkProgressionBalance,
  createState,
  deserialize,
  hashState,
  isUnlocked,
  milestoneLabel,
  milestonesAt,
  migrateState,
  planZoneCells,
  replayFrom,
  serialize,
  step,
  submit,
  unlockMilestone,
  type Command,
  type SimState,
} from "../src/index";
import { reachMilestones } from "../src/progression/milestones";
import { credited } from "./credited";
import { holdDemand } from "./demand-helper";
import { withoutMilestones } from "./before-milestones";
import progressionJson from "../balance/progression.json" with { type: "json" };

/** Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000) (build-road.test.ts). */
const SEED = 2026;
const DAY = TIME_BALANCE.ticksPerDay;
const ROAD = { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" };
/** One strip of cells along the south side of `ROAD`. */
const SOUTH = [{ from: { x: 4202, z: 4583 }, to: { x: 4390, z: 4583 }, width: 20 }];
/** And the north side. */
const NORTH = [{ from: { x: 4202, z: 4617 }, to: { x: 4390, z: 4617 }, width: 20 }];
/** Six cells deep along the south side of `ROAD`, deep enough for a tower. */
const SOUTH_DEEP = [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }];
/** And the north side. */
const NORTH_DEEP = [{ from: { x: 4202, z: 4629 }, to: { x: 4390, z: 4629 }, width: 44 }];

/** Item `i` of `list`, which must have one. */
function nth<T>(list: readonly T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new RangeError(`no item ${i}`);
  return item;
}

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

/** Submits and steps until `c` has applied or been dropped. Returns the reason it was refused at submit, or null. */
function send(state: SimState, c: Command): string | null {
  const result = submit(state, c);
  if (!result.ok) return result.reason;
  step(state);
  while (state.pending.length > 0) step(state);
  return null;
}

/** A city on seed 2026 with one street, credited with `credit` milestones. */
function street(credit = 0): SimState {
  const state = credit > 0 ? credited(createState(SEED), credit) : createState(SEED);
  expect(send(state, command("BuildRoad", ROAD))).toBeNull();
  return state;
}

/** Sets the highest population the city has had, which is what the milestones follow (stats.ts keeps it as pops come and go). */
function peak(state: SimState, population: number): void {
  state.stats.highestPopulation = population;
}

const grantsThisMonth = (state: SimState): number => state.budget.month[LINE.grants] ?? 0;

describe("progression.json", () => {
  it("has about ten milestones in rising order up to 500,000 residents, each with a name, a priced grant and its unlocks", () => {
    expect(MILESTONES.length).toBeGreaterThanOrEqual(8);
    expect(MILESTONES.length).toBeLessThanOrEqual(12);
    expect(nth(MILESTONES, MILESTONES.length - 1).population).toBe(500_000);
    for (let i = 1; i < MILESTONES.length; i++) expect(nth(MILESTONES, i).population).toBeGreaterThan(nth(MILESTONES, i - 1).population);
    for (const m of MILESTONES) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(m.grant) && m.grant > 0).toBe(true);
    }
    for (const entry of progressionJson.milestones) {
      expect(entry.grant.sourceYear).toBeGreaterThanOrEqual(1900);
      expect(entry.grant.source.length).toBeGreaterThan(0);
    }
  });

  it("opens density 2 and City Hall at the first milestone and density 3 in the middle of the curve", () => {
    expect(unlockMilestone("density2")).toBe(0);
    expect(unlockMilestone("cityHall")).toBe(0);
    const d3 = unlockMilestone("density3");
    expect(d3).toBeGreaterThan(1);
    expect(d3).toBeLessThan(MILESTONES.length - 2);
    for (const id of UNLOCKS) expect(nth(MILESTONES, unlockMilestone(id)).unlocks).toContain(id);
  });

  it("names every problem: out of order, an unknown or doubled unlock, one nobody opens, and a grant with no source", () => {
    const good = structuredClone(progressionJson);
    expect(checkProgressionBalance(good)).toEqual([]);
    const bad = structuredClone(progressionJson);
    nth(bad.milestones, 1).population = nth(bad.milestones, 0).population;
    nth(bad.milestones, 2).unlocks = ["density9"];
    nth(bad.milestones, 3).unlocks = ["density2"];
    nth(bad.milestones, 4).unlocks = [];
    (nth(bad.milestones, 5).grant as { source?: string }).source = "";
    const errors = checkProgressionBalance(bad);
    expect(errors).toContain(`milestones[1].population must be a whole number of residents above ${nth(bad.milestones, 0).population}`);
    expect(errors.some((e) => e.startsWith('milestones[2].unlocks names "density9"'))).toBe(true);
    expect(errors).toContain("milestones[3].unlocks names density2, which milestones[0] opens already");
    expect(errors).toContain("no milestone opens density3");
    expect(errors).toContain("milestones[5].grant.source is missing");
  });
});

describe("reaching a milestone", () => {
  it("is reached the first time the population passes it, and pays its grant once on the grants line", () => {
    const state = createState(SEED);
    const first = nth(MILESTONES, 0);
    peak(state, first.population - 1);
    step(state);
    expect(state.milestones.length).toBe(0);
    const before = state.budget.treasury;
    peak(state, first.population);
    const tick = state.tick;
    step(state);
    expect(Array.from(state.milestones)).toEqual([tick]);
    expect(state.budget.treasury).toBe(before + first.grant);
    expect(grantsThisMonth(state)).toBe(first.grant);
    for (let i = 0; i < 20; i++) step(state);
    expect(state.budget.treasury).toBe(before + first.grant);
  });

  it("is never lost when the population falls, and passing it again after a fall pays nothing", () => {
    const state = createState(SEED);
    const first = nth(MILESTONES, 0);
    peak(state, first.population + 200);
    step(state);
    const after = state.budget.treasury;
    const reached = state.milestones;
    // A fall: the population is below the milestone, the highest it has had is not.
    state.stats.totals["population"] = first.population - 500;
    for (let i = 0; i < 10; i++) step(state);
    expect(state.milestones).toBe(reached);
    expect(isUnlocked(state, "density2")).toBe(true);
    // And back past it.
    state.stats.totals["population"] = first.population + 100;
    for (let i = 0; i < 10; i++) step(state);
    expect(state.milestones).toBe(reached);
    expect(state.budget.treasury).toBe(after);
  });

  it("reaches every milestone a jump in population passes on the one tick, each grant paid", () => {
    const state = createState(SEED);
    const d3 = unlockMilestone("density3");
    peak(state, nth(MILESTONES, d3).population);
    const before = state.budget.treasury;
    step(state);
    expect(state.milestones.length).toBe(d3 + 1);
    const paid = MILESTONES.slice(0, d3 + 1).reduce((sum, m) => sum + m.grant, 0);
    expect(state.budget.treasury).toBe(before + paid);
    expect(isUnlocked(state, "density3")).toBe(true);
    peak(state, 10_000_000);
    step(state);
    expect(state.milestones.length).toBe(MILESTONES.length);
  });

  it("is not reached while the game is paused, and is on the tick it resumes", () => {
    const state = createState(SEED);
    expect(send(state, command("SetSpeed", { speed: 0 }))).toBeNull();
    peak(state, nth(MILESTONES, 0).population);
    for (let i = 0; i < 5; i++) step(state);
    expect(state.milestones.length).toBe(0);
    expect(send(state, command("SetSpeed", { speed: 1 }))).toBeNull();
    expect(state.milestones.length).toBe(1);
  });

  it("counts how many milestones a population reaches", () => {
    expect(milestonesAt(0)).toBe(0);
    expect(milestonesAt(nth(MILESTONES, 0).population - 1)).toBe(0);
    expect(milestonesAt(nth(MILESTONES, 0).population)).toBe(1);
    expect(milestonesAt(nth(MILESTONES, MILESTONES.length - 1).population)).toBe(MILESTONES.length);
  });

  it("pays nothing for a milestone credited by a test or a migration", () => {
    const state = credited(createState(SEED));
    const before = state.budget.treasury;
    peak(state, 1_000_000);
    reachMilestones(state);
    expect(state.budget.treasury).toBe(before);
    expect(Array.from(state.milestones)).toEqual(MILESTONES.map(() => CREDITED));
  });
});

describe("the density locks", () => {
  it("refuses density 2 before its milestone, naming it, and paints it after", () => {
    const state = street();
    const reason = `density 2 (Medium) is locked until the ${nth(MILESTONES, 0).name} milestone, at ${nth(MILESTONES, 0).population.toLocaleString("en-US")} residents`;
    const r2 = { zone: "residential", density: 2, rects: SOUTH };
    expect(submit(state, command("ZoneCells", r2))).toEqual({ ok: false, reason });
    expect(planZoneCells(state, r2)).toEqual({ ok: false, reason });
    expect(milestoneLabel("density2")).toBe(`the ${nth(MILESTONES, 0).name} milestone, at ${nth(MILESTONES, 0).population.toLocaleString("en-US")} residents`);
    // Density 1 and clearing are never locked.
    expect(send(state, command("ZoneCells", { zone: "commercial", density: 1, rects: NORTH }))).toBeNull();
    expect(send(state, command("ZoneCells", { zone: "none", rects: NORTH }))).toBeNull();
    peak(state, nth(MILESTONES, 0).population);
    step(state);
    expect(send(state, command("ZoneCells", r2))).toBeNull();
    expect(state.log.at(-1)?.type).toBe("ZoneCells");
    // Density 3 waits for its own milestone.
    const r3 = { zone: "office", density: 3, rects: NORTH };
    expect(submit(state, command("ZoneCells", r3))).toMatchObject({ ok: false, reason: expect.stringContaining(`locked until the ${nth(MILESTONES, unlockMilestone("density3")).name} milestone`) }); // prettier-ignore
    peak(state, nth(MILESTONES, unlockMilestone("density3")).population);
    step(state);
    expect(send(state, command("ZoneCells", r3))).toBeNull();
  });

  it("refuses a locked stroke at submit, so nothing is queued", () => {
    const state = street();
    for (const [level, unlock] of Object.entries(DENSITY_UNLOCKS)) expect(isUnlocked(state, unlock), `density ${level}`).toBe(false);
    expect(submit(state, command("ZoneCells", { zone: "residential", density: 2, rects: SOUTH })).ok).toBe(false);
    expect(state.pending.length).toBe(0);
  });

  it("keeps cells zoned at a locked density growing", () => {
    // Zoned on a credited city, then the credit taken away, as a city loaded from before the milestones with a low population is.
    const state = street(MILESTONES.length);
    expect(send(state, command("ZoneCells", { zone: "residential", density: 3, rects: SOUTH_DEEP }))).toBeNull();
    expect(send(state, command("ZoneCells", { zone: "residential", density: 3, rects: NORTH_DEEP }))).toBeNull();
    state.milestones = new Int32Array(0);
    expect(isUnlocked(state, "density3")).toBe(false);
    holdDemand({ residential: 100 }, () => {
      while (state.tick < 20 * DAY) step(state);
    });
    expect(densityBuildings(state, 3)).toBeGreaterThan(0);
  });
});

/** Live buildings of density `density`. */
function densityBuildings(state: SimState, density: number): number {
  const b = state.buildings;
  let n = 0;
  for (let id = 0; id < b.flags.length; id++) {
    if (((b.flags[id] ?? 0) & BUILDING_ALIVE) !== 0 && BUILDING_TYPES[b.type[id] ?? 0]?.density === density) n++;
  }
  return n;
}

describe("milestones in state", () => {
  it("are checked on load: an Int32Array of ticks of the past or credited, no more than there are milestones", () => {
    expect(checkMilestones(new Int32Array(0), 0)).toBeNull();
    expect(checkMilestones(Int32Array.from([CREDITED, 5]), 5)).toBeNull();
    expect(checkMilestones([5], 5)).toBe("they are not an Int32Array");
    expect(checkMilestones(Int32Array.from([6]), 5)).toMatch(/neither a tick of the city's past/);
    expect(checkMilestones(new Int32Array(MILESTONES.length + 1), 5)).toMatch(/this build has/);
  });

  it("save, load and replay to the same hash with a milestone reached", () => {
    const state = createState(SEED);
    peak(state, nth(MILESTONES, 0).population);
    for (let i = 0; i < 3; i++) step(state);
    expect(state.milestones.length).toBe(1);
    const loaded = deserialize(serialize(state)).state;
    expect(Array.from(loaded.milestones)).toEqual(Array.from(state.milestones));
    expect(hashState(loaded)).toBe(hashState(state));
    // A replay of a credited city's log from a city credited the same way.
    const city = street(MILESTONES.length);
    expect(send(city, command("ZoneCells", { zone: "residential", density: 2, rects: SOUTH }))).toBeNull();
    while (city.tick < 3 * DAY) step(city);
    const replayed = replayFrom(credited(createState(SEED)), city.log, city.tick);
    expect(hashState(replayed)).toBe(hashState(city));
  });

  it("credit an M3 city zoned at density 3 with every milestone its highest population passed, pay no grant, and keep its density 3 cells growing", () => {
    const state = street(MILESTONES.length);
    expect(send(state, command("ZoneCells", { zone: "residential", density: 3, rects: SOUTH_DEEP }))).toBeNull();
    expect(send(state, command("ZoneCells", { zone: "residential", density: 3, rects: NORTH_DEEP }))).toBeNull();
    // Saved once its first tower stands, with ground left for more.
    holdDemand({ residential: 100 }, () => {
      while (densityBuildings(state, 3) === 0) step(state);
    });
    // A version 33 city: no milestones, a highest population past the first two.
    const v33 = { ...withoutMilestones(structuredClone(state)), version: 33 } as unknown as { version: number } & Record<string, unknown>;
    (v33["stats"] as { highestPopulation: number }).highestPopulation = nth(MILESTONES, 1).population + 10;
    const before = (v33["budget"] as { treasury: number }).treasury;
    const migrated = migrateState(v33);
    expect(Array.from(migrated.milestones)).toEqual([CREDITED, CREDITED]);
    expect(migrated.budget.treasury).toBe(before);
    expect(isUnlocked(migrated, "density2")).toBe(true);
    expect(isUnlocked(migrated, "density3")).toBe(false);
    // Density 3 is locked for new strokes, and the cells zoned at it grow on.
    expect(submit(migrated, command("ZoneCells", { zone: "office", density: 3, rects: NORTH_DEEP })).ok).toBe(false);
    const had = densityBuildings(migrated, 3);
    holdDemand({ residential: 100 }, () => {
      while (migrated.tick < 30 * DAY) step(migrated);
    });
    expect(densityBuildings(migrated, 3)).toBeGreaterThan(had);
    expect(migrated.budget.month[LINE.grants]).toBe(0);
  });
});

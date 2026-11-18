import { describe, expect, it } from "vitest";
import {
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  GROWER_SYSTEM,
  cellAt,
  SYSTEMS,
  TIME_BALANCE,
  ZONING_BALANCE,
  createGrowth,
  createState,
  dayOf,
  deserialize,
  freeFrontCells,
  growthOnTick,
  planDay,
  hashState,
  readBuilding,
  residentsFor,
  serialize,
  step,
  typesFor,
  type BuildingRow,
  type Command,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { removeBuilding } from "../src/buildings/buildings";
import { candidateSets } from "../src/buildings/candidates";
import { grow } from "../src/buildings/grower";
import { freeFrontage, lotOptions } from "../src/buildings/lots";
import { segmentBuildings } from "../src/buildings/where";
import { nextInt, seedRng } from "../src/rng";
import { isSegment, segmentIdLimit } from "../src/roads/network";
import { nextColumn, nextColumnInto, syncCells, type Column } from "../src/zoning/cell-index";
import { enqueue } from "../src/commands";
import growthJson from "./fixtures/replay/growth.json";
import { expectReplay, runFixture, type ReplayFixture } from "./replay-helper";

const fixture = growthJson as ReplayFixture;

// M2-10: the grower.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const typeId = (index: number) => BUILDING_TYPES[index]?.id;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

/** A street running east from (4200, 4600) for `places` cells. Its north strip runs from z 4595 back, its south strip from z 4605 on. */
function street(places = 24): SimState {
  const state = createState(SEED);
  ok(state, command("BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4200 + CELL * places, z: 4600 }, type: "street" }));
  return state;
}

/**
 * Zones `d` cells deep along the street from place `p0` for `w` places, on
 * the north side, the south side or both, with one ZoneCells command.
 */
function zone(state: SimState, zoneId: string, density: number, p0: number, w: number, d: number, sides: "north" | "south" | "both" = "north"): void {
  const x0 = 4200 + CELL * p0 + 2;
  const x1 = 4200 + CELL * (p0 + w) - 2;
  const rect = (edge: number, sign: number) => {
    const z = edge + (sign * CELL * d) / 2;
    return { from: { x: x0, z }, to: { x: x1, z }, width: CELL * d - 4 };
  };
  const rects = [];
  if (sides !== "south") rects.push(rect(4595, -1));
  if (sides !== "north") rects.push(rect(4605, 1));
  ok(state, command("ZoneCells", { zone: zoneId, density, rects }));
}

function runDays(state: SimState, days: number): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) step(state);
}

function buildings(state: SimState): BuildingRow[] {
  const out: BuildingRow[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (state.buildings.flags[id]) out.push(readBuilding(state.buildings, id));
  return out;
}

/** The grower's kept candidates agree with a fresh scan of the city. */
function expectCandidatesCurrent(state: SimState): void {
  const { kept, fresh } = candidateSets(state, syncCells(state), () => segmentBuildings(state));
  expect(kept).toEqual(fresh);
}

describe("the growth rate", () => {
  it("spreads a day's quota over its ticks, on ticks fixed by the quota and the tick alone", () => {
    for (const quota of [0, 1, 7, 100, 250, BUILDINGS_BALANCE.growthPerDayMax]) {
      for (let day = 0; day < 3; day++) {
        let n = 0;
        let most = 0;
        for (let t = day * DAY; t < (day + 1) * DAY; t++) {
          n += growthOnTick(t, quota);
          most = Math.max(most, growthOnTick(t, quota));
        }
        expect(n).toBe(quota);
        expect(most).toBe(Math.ceil(quota / DAY));
      }
    }
  });

  it("plans a day from the free front cells, to build them out by a deadline fillDays after they came", () => {
    const { fillDays, frontCellsPerBuilding: per, growthPerDayMin, growthPerDayMax } = BUILDINGS_BALANCE;
    const g = createGrowth();
    planDay(g, 0, 0);
    expect(g).toEqual({ quota: growthPerDayMin, day: 0, deadline: fillDays, free: 0, used: 0 });
    // New zoning: a full fillDays from today, the quota rounded up.
    planDay(g, 5, 480);
    expect(g).toEqual({ quota: Math.ceil(480 / (per * fillDays)), day: 5, deadline: 5 + fillDays, free: 480, used: 0 });
    // Fewer cells, all of them built on by the grower: the same deadline, so the quota follows the days left.
    g.used = 440;
    planDay(g, 5 + fillDays - 2, 40);
    expect(g.deadline).toBe(5 + fillDays);
    expect(g.quota).toBe(Math.ceil(40 / (per * 2)));
    expect(g.used).toBe(0);
    // 360 new cells the day before the deadline: the deadline is the old and
    // the new weighted by their cells, so the 40 planned are not held back a month.
    g.used = 20;
    planDay(g, 5 + fillDays - 1, 380);
    expect(g.deadline).toBe(5 + fillDays - 1 + Math.ceil((20 * 1 + 360 * fillDays) / 380));
    // Held between the min and the max.
    planDay(g, 100, 10_000_000);
    expect(g.quota).toBe(growthPerDayMax);
    planDay(g, 100 + fillDays - 1, 0);
    expect(g.quota).toBe(growthPerDayMin);
  });

  it("sees new zoning that the day's building hid: the cells that came are counted net of what the grower used", () => {
    const { fillDays } = BUILDINGS_BALANCE;
    const g = createGrowth();
    planDay(g, 0, 100);
    // The grower built on 30 cells and 20 new ones came: F fell, but 20 came.
    g.used = 30;
    planDay(g, 25, 90);
    expect(g.deadline).toBe(25 + Math.ceil((70 * 5 + 20 * fillDays) / 90));
    // A bulldoze took 10 cells, not the grower: nothing came, nothing moves.
    const deadline = g.deadline;
    planDay(g, 26, 80);
    expect(g.deadline).toBe(deadline);
  });

  it("past its deadline, presses on while the grower still builds, and waits fillDays once it stops", () => {
    const { fillDays, frontCellsPerBuilding: per } = BUILDINGS_BALANCE;
    const g = createGrowth();
    planDay(g, 0, 100);
    g.used = 70;
    planDay(g, fillDays, 30);
    expect(g.deadline).toBe(fillDays + 1);
    expect(g.quota).toBe(Math.ceil(30 / per));
    g.used = 25;
    planDay(g, fillDays + 1, 5);
    expect(g.deadline).toBe(fillDays + 2);
    // Nothing built yesterday: what is left fits no lot.
    planDay(g, fillDays + 2, 5);
    expect(g.deadline).toBe(2 * fillDays + 2);
    expect(g.quota).toBe(BUILDINGS_BALANCE.growthPerDayMin);
  });

  it("holds a saved quota above the cap to the cap", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6, "both");
    runDays(state, 1);
    state.growth = { ...state.growth, quota: 1e12 };
    const before = buildings(state).length;
    step(state);
    expect(buildings(state).length - before).toBeLessThanOrEqual(Math.ceil(BUILDINGS_BALANCE.growthPerDayMax / DAY));
  });

  it("runs in the step as its own system", () => {
    expect(SYSTEMS.map((s) => s.name)).toContain(GROWER_SYSTEM);
    const state = street();
    const names: string[] = [];
    while (state.tick < DAY) step(state, { start: (name) => names.push(name), end: () => {} });
    expect(names).toContain(GROWER_SYSTEM);
  });
});

describe("residents", () => {
  const byId = (id: string) => {
    const type = BUILDING_TYPES.find((t) => t.id === id);
    if (!type) throw new Error(id);
    return type;
  };

  it("scale with lot area between the type's low and high figure", () => {
    const rng = seedRng(1);
    const apartments = byId("apartments");
    expect(residentsFor(rng, apartments, 3, 4)).toBe(50);
    expect(residentsFor(rng, apartments, 4, 6)).toBe(100);
    expect(residentsFor(rng, apartments, 4, 4)).toBe(67);
    const tower = byId("high-tower");
    expect(residentsFor(rng, tower, 5, 5)).toBe(600);
    expect(residentsFor(rng, tower, 6, 6)).toBe(1000);
    expect(residentsFor(rng, byId("corner-store"), 2, 2)).toBe(0);
    // Nothing drawn for a type that scales.
    expect(rng).toEqual(seedRng(1));
  });

  it("are drawn per building for a single family home, between its low and high figure", () => {
    const rng = seedRng(1);
    const home = byId("single-family-home");
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(residentsFor(rng, home, 2, 4));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("a street zoned R1", () => {
  const state = street();
  zone(state, "residential", 1, 0, 24, 6, "both");
  const zonedAt = state.tick;
  runDays(state, 30);

  it("grows houses along it over a game month, with households of different sizes", () => {
    const all = buildings(state);
    expect(all.length).toBeGreaterThan(10);
    const homes = all.filter((b) => typeId(b.type) === "single-family-home");
    expect(homes.length).toBeGreaterThan(3);
    expect(new Set(homes.map((b) => b.residents)).size).toBeGreaterThan(1);
    for (const b of all) {
      expect(["single-family-home", "plex"]).toContain(typeId(b.type));
      expect(b.builtAt).toBeGreaterThan(zonedAt);
    }
    // Houses of one type do not all draw the same model.
    expect(new Set(homes.map((b) => b.variant)).size).toBeGreaterThan(1);
  });

  it("fills the street in about a month and then stops", () => {
    const count = buildings(state).length;
    const more = deserialize(serialize(state)).state;
    runDays(more, 30);
    // A few gaps may still fill, but the street is close to full by now.
    expect(buildings(more).length - count).toBeLessThanOrEqual(4);
  });

  it("keeps its candidates as a fresh scan would find them", () => {
    expectCandidatesCurrent(state);
  });
});

describe("density 2 and 3 strips", () => {
  it("grow townhomes on a shallow R2 strip", () => {
    const state = street();
    zone(state, "residential", 2, 0, 24, 3);
    runDays(state, 20);
    const all = buildings(state);
    expect(all.length).toBeGreaterThan(3);
    for (const b of all) expect(typeId(b.type)).toBe("townhomes");
  });

  it("grow apartments on a deep R2 strip, townhomes only on gaps too narrow for them", () => {
    const state = street();
    zone(state, "residential", 2, 0, 24, 6);
    runDays(state, 20);
    const all = buildings(state);
    expect(all.filter((b) => typeId(b.type) === "apartments").length).toBeGreaterThan(2);
    for (const b of all) {
      if (typeId(b.type) === "townhomes") expect(b.width).toBeLessThan(3);
      else expect(typeId(b.type)).toBe("apartments");
    }
  });

  it("leave an R3 lot under 4 x 4 empty", () => {
    const state = street();
    zone(state, "residential", 3, 0, 3, 6);
    const rng = state.rng.slice();
    runDays(state, 10);
    expect(buildings(state)).toEqual([]);
    // It drew, found no lot, and gave up: the draws still advance the generator.
    expect(state.rng).not.toEqual(rng);
  });

  it("grows a tower on an R3 lot of 4 x 4 or more", () => {
    const state = street();
    zone(state, "residential", 3, 0, 6, 6);
    runDays(state, 3);
    const all = buildings(state);
    expect(all.length).toBe(1);
    expect(["low-tower", "high-tower"]).toContain(typeId(all[0]?.type ?? -1));
  });
});

describe("building from an end of the free frontage (issue 194)", () => {
  /** The places along the street a building's lot covers. A street is one segment, so they are consecutive. */
  function placesOf(b: BuildingRow): number[] {
    const step = b.dir === 0 ? 1 : -1;
    return Array.from({ length: b.width }, (_, i) => b.firstPlace + i * step);
  }

  /** The north side's free places among `zoned`: not under a building. */
  function freePlaces(state: SimState, zoned: readonly number[]): number[] {
    const built = new Set(buildings(state).flatMap(placesOf));
    return zoned.filter((p) => !built.has(p));
  }

  /** Steps until a building comes or goes, up to `days`. False if none did. */
  function stepToNextBuilding(state: SimState, days: number): boolean {
    const count = buildings(state).length;
    const until = state.tick + days * DAY;
    while (state.tick < until) {
      step(state);
      if (buildings(state).length !== count) return true;
    }
    return false;
  }

  it("finds the ends of the free frontage, the nearer first and toward node A on a tie", () => {
    const state = street();
    zone(state, "office", 3, 5, 7, 6);
    const front = cellAt(state, 4200 + CELL * 7 + CELL / 2, 4595 - CELL / 2);
    if (!front) throw new Error("no cell north of the street");
    const at = (place: number) => freeFrontage(state, { ...front, place, depth: 0 });
    const ends = (place: number) => at(place).ends.map((r) => r.place);
    expect(at(7).width).toBe(7);
    expect(ends(7)).toEqual([5, 11]);
    expect(ends(10)).toEqual([11, 5]);
    expect(ends(8)).toEqual([5, 11]);
    expect(ends(5)).toEqual([5, 11]);
    // Unzoned ground has no frontage.
    expect(ends(3)).toEqual([]);
    // Other zoning ends a run: a cell of it on its own is both its ends.
    zone(state, "commercial", 1, 8, 1, 6);
    expect(ends(7)).toEqual([7, 5]);
    expect(at(7).width).toBe(3);
    expect(ends(8)).toEqual([8]);
    expect(at(8).width).toBe(1);
  });

  it("fills a 7 x 6 O3 lot with no cell left over, whatever the draw", () => {
    const zoned = [5, 6, 7, 8, 9, 10, 11];
    for (let seed = 1; seed <= 12; seed++) {
      const state = street();
      zone(state, "office", 3, 5, 7, 6);
      state.rng.set(seedRng(seed));
      runDays(state, 30);
      const widths = buildings(state).map((b) => b.width).sort();
      // Office types on one strip are 3, 4 or 5, or 6 wide: 7 is 3 + 4.
      expect(widths, `seed ${seed}`).toEqual([3, 4]);
      expect(freePlaces(state, zoned), `seed ${seed}`).toEqual([]);
    }
  });

  it("puts the first building on a 7 x 6 O3 lot against one end, whatever the draw", () => {
    const zoned = [5, 6, 7, 8, 9, 10, 11];
    for (let seed = 1; seed <= 12; seed++) {
      const state = street();
      zone(state, "office", 3, 5, 7, 6);
      state.rng.set(seedRng(seed));
      expect(stepToNextBuilding(state, 10)).toBe(true);
      const [first] = buildings(state);
      if (!first) throw new Error("nothing grew");
      const covers = placesOf(first);
      expect(covers.includes(5) || covers.includes(11), `seed ${seed}: places ${covers.join(", ")}`).toBe(true);
      // What is left is one piece, not a gap either side.
      const free = freePlaces(state, zoned);
      expect(free.length === 0 || (free.at(-1) as number) - (free[0] as number) === free.length - 1).toBe(true);
    }
  });

  it("keeps the free frontage of a long strip in one piece as it fills", () => {
    const zoned = Array.from({ length: 24 }, (_, p) => p);
    for (const [zoneId, density] of [["residential", 1], ["residential", 2], ["commercial", 2], ["industrial", 3]] as const) {
      const state = street();
      zone(state, zoneId, density, 0, 24, 6);
      let grew = 0;
      while (stepToNextBuilding(state, 10)) {
        grew++;
        const free = freePlaces(state, zoned);
        if (free.length === 0) break;
        expect((free.at(-1) as number) - (free[0] as number), `${zoneId} ${density}: free places ${free.join(", ")}`).toBe(free.length - 1);
      }
      expect(grew).toBeGreaterThan(2);
    }
  });
});

describe("the grower and state", () => {
  it("waits for a change of roads to settle", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6);
    while (state.growth.day !== dayOf(state.tick) || growthOnTick(state.tick, state.growth.quota) === 0) step(state);
    state.cellsReadyAt = state.tick + 1;
    const rng = state.rng.slice();
    grow(state);
    expect(buildings(state)).toEqual([]);
    expect(state.rng).toEqual(rng);
  });

  it("keeps its candidates current through a rezone and a removed building", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6, "both");
    runDays(state, 8);
    expectCandidatesCurrent(state);
    zone(state, "commercial", 1, 4, 8, 6, "both");
    expectCandidatesCurrent(state);
    const first = buildings(state)[0];
    if (!first) throw new Error("nothing grew");
    removeBuilding(state, first.id);
    expectCandidatesCurrent(state);
    zone(state, "none", 1, 0, 2, 6, "both");
    runDays(state, 5);
    expectCandidatesCurrent(state);
  });

  it("keeps its candidates current through roads built across, beside and over grown lots, and bulldozed", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6, "both");
    zone(state, "mixed", 1, 0, 24, 6, "south");
    runDays(state, 12);
    expectCandidatesCurrent(state);
    const before = buildings(state).length;
    // A street across the strips: it cuts the street in two and blocks the cells under it.
    ok(state, command("BuildRoad", { from: { x: 4300, z: 4500 }, to: { x: 4300, z: 4700 }, type: "street" }));
    expectCandidatesCurrent(state);
    // A T-junction on the north side only.
    ok(state, command("BuildRoad", { from: { x: 4252, z: 4600 }, to: { x: 4252, z: 4520 }, type: "street" }));
    expectCandidatesCurrent(state);
    runDays(state, 4);
    expectCandidatesCurrent(state);
    const net = state.roads;
    const across: number[] = [];
    for (let seg = 0; seg < net.segA.length; seg++) {
      if (!isSegment(net, seg)) continue;
      const ax = net.nodeX[net.segA[seg] ?? 0] ?? 0;
      const bx = net.nodeX[net.segB[seg] ?? 0] ?? 0;
      if (ax === 4300 && bx === 4300) across.push(seg);
    }
    expect(across.length).toBeGreaterThan(0);
    ok(state, command("BulldozeRoad", { segments: across }));
    expectCandidatesCurrent(state);
    runDays(state, 4);
    expectCandidatesCurrent(state);
    expect(buildings(state).length).toBeGreaterThan(before);
  });

  it("keeps its candidates current through random roads, zoning and growth", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6, "both");
    runDays(state, 3);
    const rng = seedRng(105);
    const zones = ["residential", "commercial", "office", "industrial", "mixed", "none"];
    const at = (lo: number, hi: number) => lo + 8 * nextInt(rng, Math.floor((hi - lo) / 8) + 1);
    for (let round = 0; round < 80; round++) {
      const pick = nextInt(rng, 5);
      const live: number[] = [];
      for (let seg = 0; seg < state.roads.segA.length; seg++) if (isSegment(state.roads, seg)) live.push(seg);
      const some = live[nextInt(rng, live.length)] ?? 0;
      const net = state.roads;
      const a = { x: net.nodeX[net.segA[some] ?? 0] ?? 0, z: net.nodeZ[net.segA[some] ?? 0] ?? 0 };
      const b = { x: net.nodeX[net.segB[some] ?? 0] ?? 0, z: net.nodeZ[net.segB[some] ?? 0] ?? 0 };
      let c: Command;
      if (pick < 2) {
        const x = at(4120, 4600);
        const z = at(4440, 4900);
        const along = nextInt(rng, 2) === 0;
        const to = along ? { x: x + at(48, 240), z } : { x, z: z + at(48, 240) };
        c = command("BuildRoad", { from: { x, z }, to, type: "street" });
      } else if (pick === 2) {
        c = command("BulldozeRoad", { segments: [some] });
      } else {
        // Over a live segment, so it lands on its cells.
        const long = Math.hypot(b.x - a.x, b.z - a.z) > 1 && Math.hypot(b.x - a.x, b.z - a.z) < 256;
        c = command("ZoneCells", {
          zone: zones[nextInt(rng, zones.length)],
          density: 1 + nextInt(rng, 3),
          rects: [long ? { from: a, to: b, width: at(16, 104) } : { from: a, to: { x: a.x + 64, z: a.z }, width: 96 }],
        });
      }
      submit(state, c);
      for (let i = 0; i < 1 + nextInt(rng, 3 * DAY); i++) step(state);
      expectCandidatesCurrent(state);
    }
    const applied = state.log.map((e) => e.type);
    expect(applied.filter((t) => t === "BuildRoad").length).toBeGreaterThan(3);
    expect(applied.filter((t) => t === "BulldozeRoad").length).toBeGreaterThan(3);
    expect(applied.filter((t) => t === "ZoneCells").length).toBeGreaterThan(8);
    expect(state.buildings.flags.length).toBeGreaterThan(3);
  });

  it("hashes the same after a save and reload while it grows as a city that never stopped", () => {
    const straight = street();
    zone(straight, "residential", 1, 0, 24, 6, "both");
    zone(straight, "mixed", 2, 0, 24, 6, "south");
    const saved = deserialize(serialize(straight)).state;
    runDays(straight, 6);
    runDays(saved, 3);
    // Mid-run, mid-day, with buildings on the ground.
    for (let i = 0; i < 37; i++) step(saved);
    const reloaded = deserialize(serialize(saved)).state;
    while (reloaded.tick < straight.tick) step(reloaded);
    expect(buildings(reloaded).length).toBeGreaterThan(3);
    expect(hashState(reloaded)).toBe(hashState(straight));
  });

  it("gives the same city from the same commands", () => {
    const run = () => {
      seq = 0;
      const state = street();
      zone(state, "commercial", 2, 0, 24, 6, "both");
      runDays(state, 12);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe("the pace and the frontage", () => {
  // Seed 2026's flat square fits ten 192 m streets, two across and five down,
  // each zoned R1 six deep on both sides.
  const ROWS = [4450, 4562, 4674, 4786, 4898];
  const COLS = [4120, 4408];
  function streets(n: number): SimState {
    const state = createState(SEED);
    for (let i = 0; i < n; i++) {
      const x = COLS[Math.floor(i / ROWS.length)] ?? 0;
      const z = ROWS[i % ROWS.length] ?? 0;
      ok(state, command("BuildRoad", { from: { x, z }, to: { x: x + 24 * CELL, z }, type: "street" }));
      const rect = (side: number) => ({ from: { x: x + 2, z: z + side * 29 }, to: { x: x + 24 * CELL - 2, z: z + side * 29 }, width: 44 });
      ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [rect(-1), rect(1)] }));
    }
    return state;
  }

  /** Game days from now until no free front cell is left, or -1 past `most` days. */
  function daysToFill(state: SimState, most: number): number {
    const from = state.tick;
    while (freeFrontCells(state) > 0) {
      if (state.tick - from > most * DAY) return -1;
      step(state);
    }
    return (state.tick - from) / DAY;
  }

  it("fills one street and ten in about fillDays game days", () => {
    const { fillDays } = BUILDINGS_BALANCE;
    const one = streets(1);
    const ten = streets(10);
    expect(freeFrontCells(ten)).toBe(10 * freeFrontCells(one));
    const oneDays = daysToFill(one, 2 * fillDays);
    const tenDays = daysToFill(ten, 2 * fillDays);
    // One street builds at the floor of one a day, so its days are its
    // buildings. Built from the ends of the frontage (issue 194), it leaves
    // fewer one-cell gaps and fills with fewer, wider buildings: 21 days.
    for (const days of [oneDays, tenDays]) {
      expect(days).toBeGreaterThan(0.6 * fillDays);
      expect(days).toBeLessThan(1.2 * fillDays);
    }
    expect(buildings(ten).length).toBeGreaterThan(8 * buildings(one).length);
  }, 60_000);

  it("fills ten streets zoned three days apart within about fillDays of the last", () => {
    // The draw is uniform over every free cell, so an early street fills with
    // the rest, not on its own month: the pace can promise the whole of it.
    const { fillDays } = BUILDINGS_BALANCE;
    const state = createState(SEED);
    const zonedOn: number[] = [];
    const fullOn: number[] = [];
    const freeOn = (i: number) => {
      // Free front cells along street i: its own segments, as the grower counts them.
      const x = COLS[Math.floor(i / ROWS.length)] ?? 0;
      const z = ROWS[i % ROWS.length] ?? 0;
      let n = 0;
      const { offset, zone: zones } = state.cells;
      const where = segmentBuildings(state);
      for (let seg = 0; seg + 1 < offset.length; seg++) {
        if (!isSegment(state.roads, seg)) continue;
        const a = state.roads.segA[seg] ?? 0;
        if (state.roads.nodeZ[a] !== z || (state.roads.nodeX[a] ?? 0) < x - 1 || (state.roads.nodeX[a] ?? 0) > x + 24 * CELL + 1) continue;
        for (let slot = offset[seg] ?? 0; slot < (offset[seg + 1] ?? 0); slot += ZONING_BALANCE.zoneDepthCells) {
          const at = slot - (offset[seg] ?? 0);
          if ((zones[slot] ?? 0) !== 0 && (where[seg]?.[at] ?? -1) === -1) n++;
        }
      }
      return n;
    };
    for (let i = 0; i < 10; i++) {
      const x = COLS[Math.floor(i / ROWS.length)] ?? 0;
      const z = ROWS[i % ROWS.length] ?? 0;
      ok(state, command("BuildRoad", { from: { x, z }, to: { x: x + 24 * CELL, z }, type: "street" }));
      const rect = (side: number) => ({ from: { x: x + 2, z: z + side * 29 }, to: { x: x + 24 * CELL - 2, z: z + side * 29 }, width: 44 });
      ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [rect(-1), rect(1)] }));
      zonedOn.push(dayOf(state.tick));
      for (let d = 0; d < 3; d++) {
        runDays(state, 1);
        for (let j = 0; j <= i; j++) if (fullOn[j] === undefined && freeOn(j) === 0) fullOn[j] = dayOf(state.tick);
      }
    }
    for (let d = 0; d < 2 * fillDays && fullOn.filter((f) => f !== undefined).length < 10; d++) {
      runDays(state, 1);
      for (let j = 0; j < 10; j++) if (fullOn[j] === undefined && freeOn(j) === 0) fullOn[j] = dayOf(state.tick);
    }
    const last = zonedOn.at(-1) ?? 0;
    for (let j = 0; j < 10; j++) {
      expect(fullOn[j], `street ${j}`).toBeDefined();
      expect((fullOn[j] ?? 0) - last, `street ${j}`).toBeLessThan(1.1 * fillDays);
    }
    // And all of it inside a month of the last street.
    expect(Math.max(...fullOn) - last).toBeLessThan(fillDays);
  }, 120_000);

  it("hashes the same saved and loaded mid-day, several buildings a day, as a city that never stopped", () => {
    const straight = streets(10);
    runDays(straight, 4);
    const saved = deserialize(serialize(straight)).state;
    runDays(straight, 3);
    for (let i = 0; i < 37; i++) step(saved);
    expect(saved.growth.quota).toBeGreaterThan(1);
    const reloaded = deserialize(serialize(saved)).state;
    while (reloaded.tick < straight.tick) step(reloaded);
    expect(reloaded.growth).toEqual(straight.growth);
    expect(hashState(reloaded)).toBe(hashState(straight));
  }, 60_000);
});

describe("replay fixture growth", () => {
  it("replays to its recorded hash, with the same buildings", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    const all = buildings(state);
    expect(all.length).toBeGreaterThan(10);
    const kinds = new Set(all.map((b) => typeId(b.type)));
    for (const kind of ["single-family-home", "townhomes"]) expect(kinds).toContain(kind);
    expect(buildings(runFixture(fixture).state)).toEqual(all);
  });

  it("gives the same hash on every run", () => {
    expect(new Set([runFixture(fixture).hash, runFixture(fixture).hash])).toEqual(new Set([fixture.hash]));
  });

  /** Replays the fixture, saving and loading the city at `at` and stepping on from the copy. */
  function replaySavedAt(at: number): SimState {
    let state = createState(fixture.seed);
    let next = 0;
    while (state.tick < fixture.untilTick) {
      if (state.tick === at && state.log.length === next) {
        state = deserialize(serialize(state)).state;
        at = -1;
      }
      for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
      step(state);
    }
    return state;
  }

  it.each([150, 451, 777, 1234])("hashes the same saved and loaded at tick %d, mid-growth", (at) => {
    expect(hashState(replaySavedAt(at))).toBe(fixture.hash);
  });
});

describe("the grower's queries make no garbage and change no answer (issue 166)", () => {
  /**
   * A street cut in two by a street from the north, so strips run on across
   * the cut, zoned so every refusal the grower meets comes up, and grown
   * for ten days.
   */
  function town(): SimState {
    const state = street(30);
    ok(state, command("BuildRoad", { from: { x: 4200 + CELL * 15, z: 4300 }, to: { x: 4200 + CELL * 15, z: 4600 }, type: "street" }));
    // R1 six deep, past its deepest lot of five; I1 on past the cut, its back rows behind its buildings.
    zone(state, "residential", 1, 0, 13, 6, "north");
    zone(state, "industrial", 1, 16, 14, 6, "north");
    // R3 two deep, short of its shallowest lot of four; O3 two wide, short of its narrowest of three.
    zone(state, "residential", 3, 0, 10, 2, "south");
    zone(state, "office", 3, 12, 2, 6, "south");
    // C3, where through-lot types grow.
    zone(state, "commercial", 3, 16, 14, 6, "south");
    runDays(state, 10);
    expect(buildings(state).length).toBeGreaterThan(5);
    return state;
  }

  it("asks the lot finder without reasons and gets the same answer, the problem alone on a refusal", () => {
    const state = town();
    const index = syncCells(state);
    const seen = new Set<string>();
    let asked = 0;
    for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) {
      const places = index.segs[seg]?.places ?? 0;
      for (let place = 0; place < places; place++) {
        for (let side = 0; side < 2; side++) {
          for (let depth = 0; depth < ZONING_BALANCE.zoneDepthCells; depth++) {
            const ref = { segment: seg, side, place, depth };
            const told = lotOptions(state, ref);
            const quiet = lotOptions(state, ref, false);
            asked++;
            if (told.ok) {
              expect(quiet).toEqual(told);
              seen.add("ok");
            } else {
              expect(quiet).toEqual({ ok: false, problem: told.problem, reason: "" });
              seen.add(told.problem);
            }
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(500);
    // The refusals the grower meets most, and the ones before them.
    for (const answer of ["ok", "built", "unzoned", "too-shallow", "too-narrow", "too-deep", "off-road"]) expect(seen).toContain(answer);
  });

  it("lists each zone and density's types once, as the balance has them", () => {
    for (let zone = 0; zone <= ZONING_BALANCE.zones.length + 1; zone++) {
      for (let density = 0; density <= 4; density++) {
        expect(typesFor(zone, density)).toEqual(BUILDING_TYPES.filter((t) => t.zoneNumber === zone && t.density === density));
      }
    }
    expect(typesFor(1, 1).length).toBeGreaterThan(0);
  });

  it("steps along a strip into a column it is given as nextColumn does, the same column included", () => {
    const state = town();
    const index = syncCells(state);
    const into: Column = { seg: -1, side: -1, place: -1, dir: -1 };
    let crossed = 0;
    for (let seg = 0; seg < segmentIdLimit(state.roads); seg++) {
      const places = index.segs[seg]?.places ?? 0;
      for (let place = 0; place < places; place++) {
        for (let side = 0; side < 2; side++) {
          for (let dir = 0; dir < 2; dir++) {
            const col = { seg, side, place, dir };
            const next = nextColumn(index, col);
            const before = { ...into };
            expect(nextColumnInto(index, col, into)).toBe(next !== null);
            expect(into).toEqual(next ?? before);
            if (next && next.seg !== seg) crossed++;
            const self = { ...col };
            if (nextColumnInto(index, self, self)) expect(self).toEqual(next);
            else expect(self).toEqual(col);
          }
        }
      }
    }
    // Some steps run on into the next segment, where the search is.
    expect(crossed).toBeGreaterThan(0);
  });
});

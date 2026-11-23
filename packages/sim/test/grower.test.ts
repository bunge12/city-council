import { describe, expect, it } from "vitest";
import {
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  GROWER_SYSTEM,
  cellAt,
  SYSTEMS,
  TIME_BALANCE,
  ZONING_BALANCE,
  createState,
  dayQuotas,
  deserialize,
  growthOnTick,
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
import { holdEach } from "./hold-each";

const fixture = growthJson as ReplayFixture;

// M2-10: the grower. Its pace follows the demand bars since M3-07
// (grower-demand.test.ts). Most tests here are of where and what it builds,
// and hold every bar at 100 so any zoning fills, as it did in M2.

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
    const apartments = byId("apartments");
    expect(residentsFor(apartments, 3, 4)).toBe(50);
    expect(residentsFor(apartments, 4, 6)).toBe(100);
    expect(residentsFor(apartments, 4, 4)).toBe(67);
    const tower = byId("high-tower");
    expect(residentsFor(tower, 5, 5)).toBe(600);
    expect(residentsFor(tower, 6, 6)).toBe(1000);
    expect(residentsFor(byId("corner-store"), 2, 2)).toBe(0);
  });

  it("are four for every single family home, which takes one household (M3-08)", () => {
    const home = byId("single-family-home");
    expect(home.oneHousehold).toBe(true);
    expect(residentsFor(home, 1, 2)).toBe(4);
    expect(residentsFor(home, 2, 4)).toBe(4);
  });
});

describe("a street zoned R1", () => {
  const state = street();
  zone(state, "residential", 1, 0, 24, 6, "both");
  const zonedAt = state.tick;
  runDays(state, 30);

  it("grows houses along it on the pull from outside, with households of different sizes", () => {
    const all = buildings(state);
    // Since M3-21 the bar climbs to the pull more slowly (dailyShare 0.05), so fewer houses than the 10 before.
    expect(all.length).toBeGreaterThan(5);
    const homes = all.filter((b) => typeId(b.type) === "single-family-home");
    expect(homes.length).toBeGreaterThan(3);
    // Every house has room for four. The households that move in draw their
    // own sizes (M3-08, arrivals.test.ts); this street reaches no outside
    // connection, so nobody does.
    for (const home of homes) expect(home.residents).toBe(4);
    for (const b of all) {
      expect(["single-family-home", "plex"]).toContain(typeId(b.type));
      expect(b.builtAt).toBeGreaterThan(zonedAt);
    }
    // Houses of one type do not all draw the same model.
    expect(new Set(homes.map((b) => b.variant)).size).toBeGreaterThan(1);
  });

  it("fills the street within the month and then stops", () => {
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
  holdEach();
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
    // It tried, found no lot and set the cells aside (M3-25): a try spends
    // nothing from the generator, so a city with none set aside, loaded from
    // a save, takes the same draws.
    expect(state.rng).toEqual(rng);
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
  holdEach();
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
  holdEach();
  it("waits for a change of roads to settle", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6);
    // On to a tick that would grow a house.
    while (growthOnTick(state.tick, dayQuotas(state.demand)[1] ?? 0) === 0) step(state);
    state.cellsReadyAt = state.tick + 1;
    const rng = state.rng.slice();
    // Since M3-21 a house can come on the tick that zones, 50 a day at full demand.
    const before = buildings(state);
    grow(state);
    expect(buildings(state)).toEqual(before);
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
    // The cells under the street across come back, and grow again.
    const bulldozed = buildings(state).length;
    runDays(state, 4);
    expectCandidatesCurrent(state);
    expect(buildings(state).length).toBeGreaterThan(bulldozed);
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

describe("replay fixture growth", () => {
  it("replays to its recorded hash, with the same buildings", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    const all = buildings(state);
    // Since M3-21 the bar climbs to the pull more slowly (dailyShare 0.05), so fewer houses than the 10 before.
    expect(all.length).toBeGreaterThan(5);
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
  // Slow enough that free ground is left on every strip after the town's days.
  holdEach({ residential: 20, commercial: 20, office: 20, industrial: 20 });
  /**
   * A street cut in two by a street from the north, so strips run on across
   * the cut, zoned so every refusal the grower meets comes up, and grown
   * for a day.
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
    // Until a few have grown: since M3-21 houses come 50 a day at full demand, and a whole day fills the R1 strip, leaving no free cell too deep for a lot.
    for (let t = 0; t < DAY && buildings(state).length <= 5; t++) step(state);
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

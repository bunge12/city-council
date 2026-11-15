import { describe, expect, it } from "vitest";
import {
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  GROWER_SYSTEM,
  SYSTEMS,
  TIME_BALANCE,
  ZONING_BALANCE,
  createState,
  deserialize,
  growthOnTick,
  hashState,
  readBuilding,
  residentsFor,
  serialize,
  step,
  type BuildingRow,
  type Command,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { removeBuilding } from "../src/buildings/buildings";
import { candidateSets } from "../src/buildings/candidates";
import { grow } from "../src/buildings/grower";
import { segmentBuildings } from "../src/buildings/where";
import { nextInt, seedRng } from "../src/rng";
import { isSegment } from "../src/roads/network";
import { syncCells } from "../src/zoning/cell-index";
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
  it("adds growthPerDay buildings a day, on ticks fixed by the tick alone", () => {
    for (let day = 0; day < 5; day++) {
      let n = 0;
      for (let t = day * DAY; t < (day + 1) * DAY; t++) n += growthOnTick(t);
      expect(n).toBe(BUILDINGS_BALANCE.growthPerDay);
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

describe("the grower and state", () => {
  it("waits for a change of roads to settle", () => {
    const state = street();
    zone(state, "residential", 1, 0, 24, 6);
    while (growthOnTick(state.tick) === 0) step(state);
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

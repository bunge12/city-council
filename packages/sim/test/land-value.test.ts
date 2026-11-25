import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  GROWER_SYSTEM,
  LAND_VALUE_BALANCE,
  LAND_VALUE_SYSTEM,
  ROAD_TYPES,
  SYSTEMS,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingJobs,
  cellAt,
  cellShapesInChunk,
  cellsInChunk,
  CHUNK_SIZE,
  CHUNKS_PER_SIDE,
  cellsSettled,
  checkLandValueBalance,
  createState,
  deserialize,
  falloff,
  findCentre,
  findLot,
  hashState,
  landValueAt,
  landValueAtPoint,
  landValuesOfShapes,
  nextMonth,
  replay,
  serialize,
  step,
  type CellInfo,
  type CellRef,
  type Command,
  type SimState,
} from "../src/index";
import landValueJson from "../balance/landvalue.json" with { type: "json" };
import { BALANCE_FILES } from "../src/balance-stamp";
import { addBuilding, removeBuilding } from "../src/buildings/buildings";
import { seeBuilding } from "../src/buildings/bulldoze";
import { buildingInfo, forPlacedBuildings, middleSums, pollutionSets } from "../src/buildings/where";
import { terrainOf } from "../src/terrain/cache";
import { waterDistanceAt } from "../src/landvalue/water";
import { nextInt, seedRng } from "../src/rng";
import { holdEach } from "./hold-each";
import { submit } from "./seen-ends";

// M3-13: land value.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const LV = LAND_VALUE_BALANCE;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

/** A road of `type` running east from (4200, `z`) for `places` cells. */
function road(state: SimState, z: number, type = "street", places = 48): void {
  ok(state, command("BuildRoad", { from: { x: 4200, z }, to: { x: 4200 + CELL * places, z }, type }));
}

/**
 * Zones `d` cells deep beside the street at z 4600 from place `p0` for `w`
 * places, on its north (-1) or south (1) side, in rectangles of at most 24
 * places so none passes `maxRectSide`.
 */
function zoneSide(state: SimState, sign: -1 | 1, zoneId: string, density: number, p0: number, w: number, d: number): void {
  const z = (sign < 0 ? 4595 : 4605) + (sign * CELL * d) / 2;
  const rects = [];
  for (let p = p0; p < p0 + w; p += 24) {
    const end = Math.min(p0 + w, p + 24);
    rects.push({ from: { x: 4200 + CELL * p + 2, z }, to: { x: 4200 + CELL * end - 2, z }, width: CELL * d - 4 });
  }
  ok(state, command("ZoneCells", { zone: zoneId, density, rects }));
}
const zoneNorth = (state: SimState, zoneId: string, density: number, p0: number, w: number, d: number) => zoneSide(state, -1, zoneId, density, p0, w, d);
const zoneSouth = (state: SimState, zoneId: string, density: number, p0: number, w: number, d: number) => zoneSide(state, 1, zoneId, density, p0, w, d);

/** The front cell, at depth 0, nearest the road at z `zRoad` going north from it at `x`. */
function frontCell(state: SimState, x: number, zRoad: number): CellInfo {
  for (let z = zRoad; z > zRoad - 40; z -= 0.5) {
    const cell = cellAt(state, x, z);
    if (cell && cell.depth === 0) return cell;
  }
  throw new Error(`no front cell north of (${x}, ${zRoad})`);
}

function ref(cell: CellRef): CellRef {
  return { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth };
}

function value(state: SimState, cell: CellRef): number {
  const v = landValueAt(state, cell);
  if (!v) throw new Error("no such cell");
  return v.value;
}

function industrialCount(state: SimState): number {
  let n = 0;
  for (let id = 0; id < state.buildings.flags.length; id++) {
    if (state.buildings.flags[id] && BUILDING_TYPES[state.buildings.type[id] ?? 0]?.zone === "industrial") n++;
  }
  return n;
}

describe("the land value balance", () => {
  const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(landValueJson)) as Record<string, unknown>;

  it("is well formed and part of the balance stamp", () => {
    expect(checkLandValueBalance(landValueJson)).toEqual([]);
    expect(BALANCE_FILES["landvalue"]).toBe(landValueJson);
  });

  it("refuses a field that is missing or out of range, with a clear error", () => {
    const without = (key: string) => Object.fromEntries(Object.entries(copy()).filter(([k]) => k !== key));
    expect(checkLandValueBalance(without("water"))).toEqual(["water is missing"]);
    expect(checkLandValueBalance(without("base"))).toEqual(["base is missing"]);
    expect(checkLandValueBalance({ ...copy(), base: 101 })).toEqual(["base must be a whole number at least 0 and at most 100"]);
    expect(checkLandValueBalance({ ...copy(), squareSize: 4 })).toEqual(["squareSize must be a whole number at least 8 and at most 500"]);
    expect(checkLandValueBalance({ ...copy(), water: { points: 25, near: 400, far: 48 } })).toEqual(["water.far must be more than water.near"]);
    expect(checkLandValueBalance({ ...copy(), water: { points: 25, near: 0, far: 1600 } })).toEqual(["water.far must be a number at least 0 and at most 1000"]);
    expect(checkLandValueBalance({ ...copy(), centre: { points: 30, near: 0 } })).toEqual(["centre.far is missing"]);
    expect(checkLandValueBalance({ ...copy(), roadAccess: { street: 10, avenue: 15 } })).toEqual(["roadAccess.oneWay is missing"]);
    expect(checkLandValueBalance({ ...copy(), roadAccess: { street: 10, avenue: 15, oneWay: 12, highway: 1 } })).toEqual(['roadAccess has an unknown field "highway"']);
    expect(checkLandValueBalance({ ...copy(), industry: [{ strength: 10, radius: 100 }] })).toEqual(["industry must list one entry for each density, 1 to 3"]);
    const industry = [{ strength: 10, radius: 0 }, ...LV.industry.slice(1)];
    expect(checkLandValueBalance({ ...copy(), industry })).toEqual(["industry[0].radius must be a number above 0 and at most 2000"]);
    expect(checkLandValueBalance({ ...copy(), rent: 4 })).toEqual(['the file has an unknown field "rent"']);
  });
});

describe("land value inputs, each alone", () => {
  it("falls in a straight line, rounded down, from near to far", () => {
    const f = { points: 30, near: 100, far: 400 };
    expect(falloff(f, 0)).toBe(30);
    expect(falloff(f, 100)).toBe(30);
    expect(falloff(f, 250)).toBe(15);
    expect(falloff(f, 399)).toBe(0);
    expect(falloff(f, 400)).toBe(0);
    expect(falloff(f, Number.POSITIVE_INFINITY)).toBe(0);
    expect(falloff(f, 101)).toBe(29);
  });

  it("measures the exact distance to the nearest water sample", () => {
    const t = terrainOf(SEED);
    const n = t.samples;
    const reach = Math.ceil(LV.water.far / t.spacing);
    const rng = seedRng(7);
    for (let k = 0; k < 200; k++) {
      const i = nextInt(rng, n);
      const j = nextInt(rng, n);
      let best = Number.POSITIVE_INFINITY;
      for (let jj = Math.max(0, j - reach); jj <= Math.min(n - 1, j + reach); jj++) {
        for (let ii = Math.max(0, i - reach); ii <= Math.min(n - 1, i + reach); ii++) {
          if ((t.heights[jj * n + ii] ?? 0) > t.waterLevel) continue;
          const d2 = (ii - i) * (ii - i) + (jj - j) * (jj - j);
          if (d2 <= reach * reach && d2 < best) best = d2;
        }
      }
      const got = waterDistanceAt(t, i * t.spacing, j * t.spacing);
      // Beyond the reach the map may still find water up to the corner of the search square; only the falloff reads it, and it is 0 there.
      if (best === Number.POSITIVE_INFINITY) expect(got === Number.POSITIVE_INFINITY || got > LV.water.far).toBe(true);
      else expect(got).toBe(Math.sqrt(best) * t.spacing);
    }
  });

  it("falls with distance from water", () => {
    const state = createState(SEED);
    const t = terrainOf(SEED);
    const street = ROAD_TYPES.findIndex((r) => r.id === "street");
    const rng = seedRng(11);
    const seen: { d: number; water: number; rest: number }[] = [];
    while (seen.length < 400) {
      const x = nextInt(rng, t.samples * t.spacing);
      const z = nextInt(rng, t.samples * t.spacing);
      if ((t.heights[Math.floor(z / t.spacing) * t.samples + Math.floor(x / t.spacing)] ?? 0) <= t.waterLevel) continue;
      const v = landValueAtPoint(state, x, z, street);
      seen.push({ d: waterDistanceAt(t, x, z), water: v.water, rest: v.value - v.water });
    }
    seen.sort((a, b) => a.d - b.d);
    for (let k = 1; k < seen.length; k++) expect(seen[k]?.water).toBeLessThanOrEqual(seen[k - 1]?.water ?? 0);
    expect(seen[0]?.water).toBe(LV.water.points);
    expect(seen.at(-1)?.water).toBe(0);
    // Nothing else moved: no centre, no industry, one road type.
    expect(new Set(seen.map((s) => s.rest))).toEqual(new Set([LV.base + (LV.roadAccess["street"] ?? 0)]));
  });

  it("falls with distance from the centre, and a city with no centre takes nothing from it", () => {
    const state = createState(SEED);
    const street = ROAD_TYPES.findIndex((r) => r.id === "street");
    // In the dry square, far from water.
    expect(landValueAtPoint(state, 4400, 4700, street).centre).toBe(0);
    state.centre = { x: 4400, z: 4700, weight: 10, due: 1e9 };
    const at = (dx: number) => landValueAtPoint(state, 4400 + dx * 0.6, 4700 + dx * 0.8, street);
    const parts = [0, LV.centre.near, 1000, 2000, 3000, LV.centre.far].map((d) => at(d).centre);
    expect(parts[0]).toBe(LV.centre.points);
    expect(parts[1]).toBe(LV.centre.points);
    for (let k = 1; k < parts.length; k++) expect(parts[k]).toBeLessThanOrEqual(parts[k - 1] ?? 0);
    expect(parts[2]).toBeLessThan(LV.centre.points);
    expect(parts.at(-1)).toBe(0);
    expect(at(1000).value - at(1000).centre).toBe(at(0).value - at(0).centre);
  });

  it("is higher on an avenue than on a street, as the file says", () => {
    expect(LV.roadAccess["avenue"]).toBeGreaterThan(LV.roadAccess["street"] ?? 0);
    const state = createState(SEED);
    road(state, 4600, "street", 24);
    road(state, 4900, "avenue", 24);
    const onStreet = landValueAt(state, ref(frontCell(state, 4300, 4600)));
    const onAvenue = landValueAt(state, ref(frontCell(state, 4300, 4900)));
    if (!onStreet || !onAvenue) throw new Error("no cells");
    expect(onStreet.road).toBe(LV.roadAccess["street"]);
    expect(onAvenue.road).toBe(LV.roadAccess["avenue"]);
    expect(onAvenue.water).toBe(onStreet.water);
    expect(onAvenue.value).toBeGreaterThan(onStreet.value);
  });

  it("falls inside an industrial building's radius and not outside it", () => {
    const state = createState(SEED);
    road(state, 4600, "street", 48);
    zoneSouth(state, "industrial", 1, 30, 8, 6);
    const near = ref(frontCell(state, 4200 + CELL * 32, 4600));
    const far = ref(frontCell(state, 4200 + CELL * 2, 4600));
    const before = { near: landValueAt(state, near), far: landValueAt(state, far) };
    const lot = findLot(state, ref(cellAt(state, 4200 + CELL * 32, 4612) as CellInfo));
    if (!lot.ok) throw new Error(lot.reason);
    const id = addBuilding(state, { ...lot.lot, residents: 0, variant: 0 });
    const type = BUILDING_TYPES[lot.lot.type];
    expect(type?.zone).toBe("industrial");
    const corners = buildingInfo(state, id)?.corners ?? [];
    const cx = ((corners[0] ?? 0) + (corners[2] ?? 0) + (corners[4] ?? 0) + (corners[6] ?? 0)) / 4;
    const radius = LV.industry[(type?.density ?? 1) - 1]?.radius ?? 0;
    // The far cell is out of reach, 30 places west.
    expect(cx - (4200 + CELL * 2)).toBeGreaterThan(radius);
    const after = { near: landValueAt(state, near), far: landValueAt(state, far) };
    expect(before.near?.pollution).toBe(0);
    expect(after.near?.pollution).toBeGreaterThan(0);
    expect(after.near?.value).toBeLessThan(before.near?.value ?? 0);
    expect(after.far).toEqual(before.far);
    // And comes back when it goes.
    removeBuilding(state, id);
    expect(landValueAt(state, near)).toEqual(before.near);
  });
});

describe("a chunk's values at once", () => {
  it("are each cell's value as landValueAt gives it, on two road types beside a factory", () => {
    const state = createState(SEED);
    road(state, 4600, "street", 48);
    road(state, 4700, "avenue", 48);
    zoneSouth(state, "industrial", 1, 30, 8, 6);
    const lot = findLot(state, ref(cellAt(state, 4200 + CELL * 32, 4612) as CellInfo));
    if (!lot.ok) throw new Error(lot.reason);
    addBuilding(state, { ...lot.lot, residents: 0, variant: 0 });
    const chunk = Math.floor(4600 / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(4400 / CHUNK_SIZE);
    const shapes = cellShapesInChunk(state, chunk);
    const cells = cellsInChunk(state, chunk);
    expect(shapes.slots.length).toBeGreaterThan(100);
    const values = landValuesOfShapes(state, shapes);
    expect(values.length).toBe(shapes.slots.length);
    const seen = new Set<number>();
    cells.forEach((c, k) => {
      expect(c.index).toBe(shapes.slots[k]);
      expect(values[k], `cell ${k}`).toBe(value(state, c));
      seen.add(values[k] ?? 0);
    });
    // Polluted street cells, clean street cells and avenue cells at least.
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe("the city centre", () => {
  it("is the middle of the jobs, or of the homes while there are none", () => {
    const state = createState(SEED);
    road(state, 4600, "street", 48);
    zoneNorth(state, "residential", 1, 0, 8, 3);
    zoneNorth(state, "office", 1, 30, 16, 3);
    const place = (x: number) => {
      const lot = findLot(state, ref(frontCell(state, x, 4600)));
      if (!lot.ok) throw new Error(lot.reason);
      return addBuilding(state, { ...lot.lot, residents: BUILDING_TYPES[lot.lot.type]?.residents[0] ?? 0, variant: 0 });
    };
    expect(findCentre(state)).toEqual({ x: 0, z: 0, weight: 0 });
    place(4200 + CELL * 2);
    const homes = findCentre(state);
    expect(homes.weight).toBeGreaterThan(0);
    const offices = [place(4200 + CELL * 31), place(4200 + CELL * 44)];
    const centre = findCentre(state);
    let jobs = 0;
    let x = 0;
    let z = 0;
    forPlacedBuildings(state, (id, bx, bz) => {
      if (!offices.includes(id)) return;
      const j = buildingJobs(state.buildings, id);
      jobs += j;
      x += j * bx;
      z += j * bz;
    });
    expect(centre.weight).toBe(jobs);
    // Lot centres are summed in whole eighths of a metre.
    expect(Math.abs(centre.x - x / jobs)).toBeLessThanOrEqual(1 / 16);
    expect(Math.abs(centre.z - z / jobs)).toBeLessThanOrEqual(1 / 16);
    expect(centre.x).toBeGreaterThan(4200 + CELL * 30);
  });

  it("is worked out on the first tick of each game month, and each day until the city has one", () => {
    // Before the grower, so a building grown on a month's first tick sees that month's centre.
    const order = SYSTEMS.map((s) => s.name);
    expect(order.indexOf(LAND_VALUE_SYSTEM)).toBeLessThan(order.indexOf(GROWER_SYSTEM));
    expect(nextMonth(0)).toBe(31 * DAY);
    expect(nextMonth(31 * DAY - 1)).toBe(31 * DAY);
    expect(nextMonth(31 * DAY)).toBe(59 * DAY);
    const state = createState(SEED);
    step(state);
    expect(state.centre).toEqual({ x: 0, z: 0, weight: 0, due: DAY });
    road(state, 4600, "street", 24);
    zoneNorth(state, "residential", 1, 0, 24, 3);
    while (state.centre.weight === 0) step(state);
    // The first houses came on day 1 or later; the centre came on the day after the first.
    expect(state.tick % DAY).toBe(1);
    expect(state.centre.due).toBe(31 * DAY);
    const first = { ...state.centre };
    while (state.tick < 31 * DAY) step(state);
    expect(state.centre).toEqual(first);
    step(state);
    expect(state.centre.due).toBe(59 * DAY);
  });
});

describe("land value over time", () => {
  // Factories need industrial demand, which a city with no residents lacks (M3-07).
  holdEach();
  /** A street with R1 on the north side and I3 to the south, grown for `days`. */
  function town(days: number): SimState {
    const state = createState(SEED);
    road(state, 4600, "street", 48);
    zoneNorth(state, "residential", 1, 0, 48, 3);
    zoneSouth(state, "industrial", 3, 0, 48, 6);
    const until = state.tick + days * DAY;
    while (state.tick < until) step(state);
    return state;
  }

  it("is lower beside a factory the grower builds, within the game day it comes", () => {
    const state = createState(SEED);
    road(state, 4600, "street", 48);
    zoneNorth(state, "residential", 1, 0, 48, 3);
    const cells = [4, 12, 20, 28, 36, 44].map((p) => ref(frontCell(state, 4200 + CELL * p + CELL / 2, 4600)));
    // No centre, so the houses the grower builds meanwhile do not move the values: only the factory does.
    state.centre = { x: 0, z: 0, weight: 0, due: Number.MAX_SAFE_INTEGER };
    const before = cells.map((c) => value(state, c));
    zoneSouth(state, "industrial", 3, 0, 48, 6);
    let days = 0;
    while (industrialCount(state) === 0 && days < 30) {
      const until = state.tick + DAY;
      while (state.tick < until) step(state);
      days++;
    }
    expect(industrialCount(state)).toBeGreaterThan(0);
    const after = cells.map((c) => value(state, c));
    expect(after.some((v, k) => v < (before[k] ?? 0))).toBe(true);
    for (let k = 0; k < cells.length; k++) expect(after[k]).toBeLessThanOrEqual(before[k] ?? 0);
  });

  it("keeps the pollution and the sums the centre reads the same as ones built afresh from state", () => {
    const state = town(40);
    const { kept, fresh } = pollutionSets(state);
    expect(kept.some((p) => p > 0)).toBe(true);
    expect(kept).toEqual(fresh);
    const sums = middleSums(state);
    expect(sums.kept[0]).toBeGreaterThan(0);
    expect(sums.kept).toEqual(sums.fresh);
    // Bulldoze a factory, and the kept grid takes it off exactly.
    const id = state.buildings.flags.findIndex((f, i) => f !== 0 && BUILDING_TYPES[state.buildings.type[i] ?? 0]?.zone === "industrial");
    ok(state, command("BulldozeBuilding", { buildings: [seeBuilding(state.buildings, id)] }));
    const again = pollutionSets(state);
    expect(again.kept).toEqual(again.fresh);
    expect(again.kept).not.toEqual(kept);
    const sumsAgain = middleSums(state);
    expect(sumsAgain.kept).toEqual(sumsAgain.fresh);
    expect(sumsAgain.kept).not.toEqual(sums.kept);
  });

  it("hashes and values the same after a save and reload in the middle of a month as a city that never stopped", () => {
    const live = town(28);
    expect(live.centre.weight).toBeGreaterThan(0);
    expect(live.centre.due).toBe(31 * DAY);
    const loaded = deserialize(serialize(live)).state;
    expect(hashState(loaded)).toBe(hashState(live));
    const cells = [4, 20, 36].map((p) => ref(frontCell(live, 4200 + CELL * p + CELL / 2, 4600)));
    // Past the month's first tick, where the centre moves.
    while (live.tick < 33 * DAY) {
      step(live);
      step(loaded);
      if (live.tick % 25 === 0) {
        expect(hashState(loaded)).toBe(hashState(live));
        expect(cells.map((c) => landValueAt(loaded, c))).toEqual(cells.map((c) => landValueAt(live, c)));
      }
    }
    expect(live.centre.due).toBe(59 * DAY);
    expect(hashState(loaded)).toBe(hashState(live));
  });

  it("waits for a change of roads to settle on a month's first tick, and a city saved then hashes and values the same", () => {
    const live = town(30);
    while (live.tick < 31 * DAY - 2) step(live);
    // A grid of streets big enough to settle over several ticks, past the month's first tick.
    ok(live, command("BuildRoadGrid", { origin: { x: 4100, z: 4620 }, along: { x: 4100 + 6 * 96, z: 4620 }, across: { x: 4100, z: 4620 + 3 * 96 }, depth: 86, width: 86, type: "street" }));
    expect(live.cellsReadyAt).toBeGreaterThan(31 * DAY + 1);
    while (live.tick < 31 * DAY) step(live);
    expect(live.centre.due).toBe(31 * DAY);
    const loaded = deserialize(serialize(live)).state;
    const cells = [4, 20, 36].map((p) => ref(frontCell(live, 4200 + CELL * p + CELL / 2, 4600)));
    step(live);
    step(loaded);
    // Due, but the cells have not settled: it waits.
    expect(live.centre.due).toBe(31 * DAY);
    while (live.tick < 32 * DAY) {
      step(live);
      step(loaded);
      expect(hashState(loaded)).toBe(hashState(live));
    }
    expect(live.centre.due).toBe(59 * DAY);
    expect(cells.map((c) => landValueAt(loaded, c))).toEqual(cells.map((c) => landValueAt(live, c)));
  });

  it("keeps its pollution and sums right through a street across the factories, its bulldozing and an undo", () => {
    const state = town(40);
    const check = () => {
      while (!cellsSettled(state)) step(state);
      step(state);
      const pollution = pollutionSets(state);
      expect(pollution.kept).toEqual(pollution.fresh);
      const sums = middleSums(state);
      expect(sums.kept).toEqual(sums.fresh);
      expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
    };
    const before = industrialCount(state);
    expect(before).toBeGreaterThan(0);
    ok(state, command("BuildRoad", { from: { x: 4300, z: 4560 }, to: { x: 4300, z: 4700 }, type: "street" }));
    check();
    ok(state, command("UpgradeRoad", { segments: [frontCell(state, 4250, 4600).segment], type: "avenue" }));
    check();
    ok(state, command("BulldozeRoad", { segments: [frontCell(state, 4500, 4600).segment] }));
    check();
    expect(industrialCount(state)).toBeLessThan(before);
    ok(state, command("Undo", {}));
    check();
  });

  it("replays to the same values on the same ticks", () => {
    const live = createState(SEED);
    road(live, 4600, "street", 48);
    zoneNorth(live, "residential", 1, 0, 48, 3);
    zoneSouth(live, "industrial", 3, 0, 48, 6);
    const cells = [4, 20, 36].map((p) => ref(frontCell(live, 4200 + CELL * p + CELL / 2, 4600)));
    const seen = new Map<number, { hash: string; values: unknown }>();
    for (const tick of [5 * DAY, 20 * DAY, 31 * DAY + 1, 35 * DAY]) {
      while (live.tick < tick) step(live);
      seen.set(tick, { hash: hashState(live), values: cells.map((c) => landValueAt(live, c)) });
    }
    expect(industrialCount(live)).toBeGreaterThan(0);
    for (const [tick, { hash, values }] of seen) {
      const again = replay(SEED, live.log, tick);
      expect(hashState(again), `hash at ${tick}`).toBe(hash);
      expect(cells.map((c) => landValueAt(again, c)), `values at ${tick}`).toEqual(values);
    }
  });
});

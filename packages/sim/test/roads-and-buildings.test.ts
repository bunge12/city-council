import { describe, expect, it } from "vitest";
import {
  BUILDING_CHANGED,
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  buildingPeople,
  ROAD_TYPES,
  TIME_BALANCE,
  ZONING_BALANCE,
  buildingInfo,
  cellAt,
  createState,
  deserialize,
  findLot,
  hashState,
  isBuilding,
  previewBuildRoad,
  previewBuildRoadGrid,
  previewBulldozeRoad,
  readBuilding,
  serialize,
  step,
  type BuildingRow,
  type Command,
  type Lot,
  type SimState,
  applyBuildingDelta,
  applyCellDelta,
  applyRoadDelta,
  drainBuildingDelta,
  drainCellDelta,
  drainRoadChanges,
  encodeRoadDelta,
  prepareDerived,
  recordBuildingChanges,
  recordCellChanges,
  recordRoadChanges,
  replay,
} from "../src/index";
import { holdEach } from "./hold-each";
import { submit, withEnds } from "./seen-ends";
import { enqueue } from "../src/commands";
import fixtureJson from "./fixtures/replay/roads-and-buildings.json";
import { expectReplay, runFixture, type ReplayFixture } from "./replay-helper";
import { addBuilding, checkBuildings } from "../src/buildings/buildings";
import { addPop } from "../src/pops/pops";
import { candidateSets } from "../src/buildings/candidates";
import { buildingIndexSets, lotStands, segmentBuildings } from "../src/buildings/where";
import { nextInt, seedRng } from "../src/rng";
import { isSegment, segmentIdLimit } from "../src/roads/network";
import { cellsSettled, cellsWalked, syncCells } from "../src/zoning/cell-index";

// M2-11: roads, rezoning and buildings.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const typeId = (index: number) => BUILDING_TYPES[index]?.id;
const halfWidth = (id: string) => (ROAD_TYPES.find((t) => t.id === id)?.width ?? 0) / 2;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
/** Submits `c` and steps once; it must apply. */
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}
const road = (from: [number, number], to: [number, number], type = "street") =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });

/** A street running east from (4200, 4600) for 24 cells, its north strip from z 4595 back, its south strip from z 4605 on. */
function street(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4600], [4392, 4600]));
  return state;
}

/** Zones `d` cells deep along the street from place `p0` for `w` places, on the north side, the south side or both. */
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

/** Fills every free front cell along the street with the largest lot it has, west to east, both sides. */
function fill(state: SimState): number[] {
  const ids: number[] = [];
  for (const z of [4591, 4609]) {
    for (let x = 4204; x < 4392; x += CELL) {
      const cell = cellAt(state, x, z);
      if (!cell) continue;
      const result = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
      if (result.ok) ids.push(build(state, result.lot));
    }
  }
  return ids;
}

function build(state: SimState, lot: Lot): number {
  const type = BUILDING_TYPES[lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...lot, residents: type.residents[1], variant: 0 });
}

function live(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id)) out.push(id);
  return out;
}

function rows(state: SimState): BuildingRow[] {
  return live(state).map((id) => readBuilding(state.buildings, id));
}

/** The x range a building's lot covers. */
function xRange(state: SimState, id: number): [number, number] {
  const corners = buildingInfo(state, id)?.corners;
  if (!corners) throw new Error(`building ${id} has no lot`);
  const xs = [corners[0], corners[2], corners[4], corners[6]] as number[];
  return [Math.min(...xs), Math.max(...xs)];
}

/**
 * Every building stands on cells that are all there and open, its row
 * names a cell its segment has, and the building index kept current agrees
 * with one built afresh. What every test here ends on.
 */
/**
 * The pollution grids kept and built afresh hold the same points. A plain
 * loop with the first square that differs, not toEqual: the grid has
 * 140,625 squares, and a deep compare of it on every soundness check took
 * the random road test past 5 s on CI.
 */
function expectSameGrid(kept: Int32Array, fresh: Int32Array): void {
  expect(kept.length).toBe(fresh.length);
  let at = 0;
  while (at < kept.length && kept[at] === fresh[at]) at++;
  if (at < kept.length) expect({ square: at, points: kept[at] }).toEqual({ square: at, points: fresh[at] });
}

function expectSound(state: SimState): void {
  expect(checkBuildings(state.buildings, state.roads, state.tick)).toBeNull();
  // Once the step on the tick the cells settle by has run: that step removes
  // what a change blocked (upkeep.ts), so between the step before it and it
  // the cells are settled and those buildings still stand.
  if (cellsSettled(state) && state.tick > state.cellsReadyAt) for (const id of live(state)) expect(lotStands(state, id), `building ${id} stands`).toBe(true);
  const { kept, fresh } = buildingIndexSets(state);
  expect(kept.chunks).toEqual(fresh.chunks);
  expect(Array.from(kept.cells)).toEqual(Array.from(fresh.cells));
  const candidates = candidateSets(state, syncCells(state), () => segmentBuildings(state));
  expect(candidates.kept).toEqual(candidates.fresh);
  // The land value grid and the sums the city centre reads (M3-13).
  expectSameGrid(kept.pollution, fresh.pollution);
  expect(kept.sums).toEqual(fresh.sums);
  expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
}

/** A street with houses on both sides of it, R1 four deep. */
function housesBothSides(): { state: SimState; ids: number[] } {
  const state = street();
  zone(state, "residential", 1, 0, 24, 4, "both");
  const ids = fill(state);
  expect(ids.length).toBeGreaterThan(10);
  return { state, ids };
}

describe("a road that goes", () => {
  it("takes its cells and every building on them, and leaves no building pointing at a missing cell", () => {
    const { state, ids } = housesBothSides();
    // A second street, with houses of its own, that stays.
    ok(state, road([4200, 4800], [4392, 4800]));
    ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4779 }, to: { x: 4390, z: 4779 }, width: 28 }] }));
    const others: number[] = [];
    for (let x = 4204; x < 4392; x += CELL) {
      const cell = cellAt(state, x, 4791);
      const result = cell && findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
      if (result?.ok) others.push(build(state, result.lot));
    }
    const first = cellAt(state, 4300, 4591)?.segment as number;
    const payload = { segments: [first] };
    const preview = previewBulldozeRoad(state, withEnds(state.roads, payload));
    expect(preview.ok && preview.clears.ids).toEqual(ids);
    ok(state, command("BulldozeRoad", payload));
    for (const id of ids) expect(isBuilding(state.buildings, id), `building ${id}`).toBe(false);
    expect(live(state)).toEqual(others);
    expectSound(state);
  });

  it("takes its buildings when the build is undone", () => {
    const { state, ids } = housesBothSides();
    // The first undo takes back the zoning and leaves the houses (issue 111), the second the street.
    ok(state, command("Undo", {}));
    expect(live(state)).toEqual(ids);
    ok(state, command("Undo", {}));
    expect(live(state)).toEqual([]);
    expect(state.cells.zone.length).toBe(0);
    expectSound(state);
  });

  it("frees the ground for the grower once its buildings are gone", () => {
    const { state } = housesBothSides();
    ok(state, command("BulldozeRoad", { segments: [cellAt(state, 4300, 4591)?.segment as number] }));
    ok(state, road([4200, 4600], [4392, 4600]));
    expect(live(state)).toEqual([]);
    expectSound(state);
  });
});

describe("a road that comes", () => {
  it("clears only the houses with a cell under it, as its preview says", () => {
    const { state, ids } = housesBothSides();
    // A household in every other house, so the preview's residents are people and not room.
    for (const [i, home] of ids.entries()) if (i % 2 === 0) addPop(state, { home, size: 2, education: 1, wealth: 1, children: 0, satisfaction: 60 });
    const payload = { from: { x: 4296, z: 4500 }, to: { x: 4296, z: 4700 }, type: "street" };
    const preview = previewBuildRoad(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    // The houses in the new street's way, by their ground.
    const half = halfWidth("street");
    const inTheWay = ids.filter((id) => {
      const [lo, hi] = xRange(state, id);
      return lo < 4296 + half && hi > 4296 - half;
    });
    expect(inTheWay.length).toBeGreaterThan(0);
    expect(preview.clears.ids).toEqual(inTheWay);
    // The people living there, not the room the houses hold (M3-12).
    expect(preview.clears.residents).toBe(inTheWay.reduce((n, id) => n + buildingPeople(state, id), 0));
    expect(preview.clears.residents).toBeGreaterThan(0);
    // The preview took its rehearsal back.
    expect(hashState(state)).toBe(hashState(deserialize(serialize(state)).state));
    ok(state, command("BuildRoad", payload));
    expect(live(state)).toEqual(ids.filter((id) => !inTheWay.includes(id)));
    expectSound(state);
  });

  it("clears the houses a grid's streets cross, as its preview says", () => {
    const { state } = housesBothSides();
    const payload = { origin: { x: 4248, z: 4520 }, along: { x: 4344, z: 4520 }, across: { x: 4248, z: 4680 }, depth: 70, width: 86, type: "street" };
    const preview = previewBuildRoadGrid(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.clears.ids.length).toBeGreaterThan(0);
    const before = live(state);
    ok(state, command("BuildRoadGrid", payload));
    while (!cellsSettled(state)) step(state);
    step(state);
    expect(live(state)).toEqual(before.filter((id) => !preview.clears.ids.includes(id)));
    expectSound(state);
  });

  it("refuses to undo a bulldoze while houses stand where the road was, and undoes it once they are cleared (M2 review, #147)", () => {
    const state = street();
    // A street from the north meets this one at x 4296.
    ok(state, road([4296, 4450], [4296, 4600]));
    const across = cellAt(state, 4296 + halfWidth("street") + 2, 4500)?.segment as number;
    ok(state, command("BulldozeRoad", { segments: [across] }, "p2"));
    // The ground under it is free now: zone it and build on it.
    zone(state, "residential", 1, 0, 24, 4, "north");
    const ids = fill(state);
    const half = halfWidth("street");
    const under = ids.filter((id) => {
      const [lo, hi] = xRange(state, id);
      return lo < 4296 + half && hi > 4296 - half;
    });
    expect(under.length).toBeGreaterThan(0);
    expect(submit(state, command("Undo", {}, "p2"))).toEqual({ ok: false, reason: "Cannot undo: buildings now stand on ground that road would take back" });
    const b = state.buildings;
    ok(state, command("BulldozeBuilding", { buildings: under.map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] })) }));
    ok(state, command("Undo", {}, "p2"));
    expect(live(state)).toEqual(ids.filter((id) => !under.includes(id)));
    expectSound(state);
  });

  it("splits a street under a building's frontage and leaves the building standing on the same ground", () => {
    const state = street();
    zone(state, "residential", 3, 9, 6, 6);
    const tower = build(state, lotAt(state, 4300, 4591));
    expect(typeId(state.buildings.type[tower] ?? 0)).toBe("high-tower");
    zone(state, "residential", 1, 15, 9, 4);
    const houses = fill(state);
    const before = live(state).map((id) => buildingInfo(state, id)?.corners);
    // A street from the south meets this one at x 4296, under the tower's frontage across the road.
    ok(state, road([4296, 4600], [4296, 4700]));
    expect(live(state)).toEqual([tower, ...houses].sort((p, q) => p - q));
    expect(live(state).map((id) => buildingInfo(state, id)?.corners)).toEqual(before);
    // The houses east of the cut now name the new piece.
    const piece = cellAt(state, 4380, 4591)?.segment as number;
    expect(houses.some((id) => state.buildings.firstSeg[id] === piece)).toBe(true);
    expectSound(state);
    // Undone, the street is one piece again and every building is back on its first segment.
    ok(state, command("Undo", {}));
    expect(live(state).map((id) => buildingInfo(state, id)?.corners)).toEqual(before);
    expectSound(state);
  });
});

/** The cell at depth 0 whose ground holds the point. */
function cellRef(state: SimState, x: number, z: number) {
  const cell = cellAt(state, x, z);
  if (!cell) throw new Error(`no cell at ${x}, ${z}`);
  return { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 };
}

function lotAt(state: SimState, x: number, z: number): Lot {
  const result = findLot(state, cellRef(state, x, z));
  if (!result.ok) throw new Error(result.reason);
  return result.lot;
}

describe("an upgrade", () => {
  it("keeps the buildings on the road, moved out with its edge", () => {
    const { state, ids } = housesBothSides();
    const seg = cellAt(state, 4300, 4591)?.segment as number;
    const before = rows(state);
    ok(state, command("UpgradeRoad", { segments: [seg], type: "avenue" }));
    expect(live(state)).toEqual(ids);
    expect(rows(state)).toEqual(before);
    const north = buildingInfo(state, ids[0] as number)?.corners as number[];
    expect(north[1]).toBeCloseTo(4600 - halfWidth("avenue"));
    expectSound(state);
  });

  it("keeps them when a one-way is reversed, their rows renumbered from the new node A", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600], "oneWay"));
    zone(state, "residential", 1, 0, 24, 4, "both");
    const ids = fill(state);
    const before = rows(state);
    const seg = cellAt(state, 4300, 4591)?.segment as number;
    ok(state, command("UpgradeRoad", { segments: [seg], type: "oneWay" }));
    expect(live(state)).toEqual(ids);
    // The ends swap, so each lot's first cell is on the other side, counted from the other end, and the lot runs back toward node A.
    const places = 24;
    expect(rows(state)).toEqual(before.map((r) => ({ ...r, firstSide: 1 - r.firstSide, firstPlace: places - 1 - r.firstPlace, dir: 1 - r.dir })));
    expectSound(state);
  });
});

describe("rezoning built land", () => {
  // The cleared lot grows shops, which need commercial demand (M3-07).
  holdEach();
  it("leaves the building standing; cleared, the lot grows under the new zoning", () => {
    const state = street();
    zone(state, "residential", 1, 0, 2, 4);
    // Since M3-21 the grower may have built the house on the tick that zoned it, 50 a day at full demand.
    const [house] = [...live(state), ...fill(state)];
    expect(typeId(state.buildings.type[house as number] ?? 0)).toBe("single-family-home");
    const row = readBuilding(state.buildings, house as number);
    // Rezoned to C2, then cleared: the house stays both times.
    zone(state, "commercial", 2, 0, 2, 4);
    expect(readBuilding(state.buildings, house as number)).toEqual(row);
    ok(state, command("ZoneCells", { zone: "none", rects: [{ from: { x: 4202, z: 4579 }, to: { x: 4214, z: 4579 }, width: 28 }] }));
    expect(readBuilding(state.buildings, house as number)).toEqual(row);
    zone(state, "commercial", 2, 0, 2, 4);
    // The grower finds nothing to build while it stands.
    const until = state.tick + 3 * DAY;
    while (state.tick < until) step(state);
    expect(live(state)).toEqual([house]);
    ok(state, command("BulldozeBuilding", { buildings: [{ id: house, segment: row.firstSeg, side: row.firstSide, place: row.firstPlace, builtAt: row.builtAt }] }));
    expect(live(state)).toEqual([]);
    const later = state.tick + 3 * DAY;
    while (state.tick < later && live(state).length === 0) step(state);
    const [shop] = live(state);
    expect(shop).toBeDefined();
    expect(BUILDING_TYPES[state.buildings.type[shop as number] ?? 0]).toMatchObject({ zone: "commercial", density: 2 });
    expectSound(state);
  });
});

describe("BulldozeBuilding", () => {
  function housed(): { state: SimState; ids: number[] } {
    const state = street();
    zone(state, "residential", 1, 0, 8, 4);
    return { state, ids: fill(state) };
  }
  const seen = (state: SimState, id: number) => ({
    id,
    segment: state.buildings.firstSeg[id],
    side: state.buildings.firstSide[id],
    place: state.buildings.firstPlace[id],
    builtAt: state.buildings.builtAt[id],
  });

  it("removes the buildings it names and frees their ground at once", () => {
    const { state, ids } = housed();
    const [a, b, ...rest] = ids as [number, number, ...number[]];
    ok(state, command("BulldozeBuilding", { buildings: [seen(state, b), seen(state, a)] }));
    expect(live(state)).toEqual(rest);
    // Freed in ascending id order, so the next building takes b's id.
    expect(Array.from(state.buildings.free)).toEqual([a, b]);
    expect(findLot(state, cellRef(state, 4204, 4591)).ok).toBe(true);
    expectSound(state);
  });

  it("refuses a building that changed since the player saw it, with a reason", () => {
    const { state, ids } = housed();
    const id = ids[0] as number;
    const stale = seen(state, id);
    ok(state, command("BulldozeBuilding", { buildings: [stale] }));
    // Gone: refused.
    expect(submit(state, command("BulldozeBuilding", { buildings: [stale] }))).toEqual({ ok: false, reason: BUILDING_CHANGED });
    // Its id handed to a building on other ground: refused too.
    const cell = cellRef(state, 4300, 4609);
    zone(state, "residential", 1, 10, 4, 4, "south");
    const result = findLot(state, cellRef(state, 4300, 4609));
    if (!result.ok) throw new Error(result.reason);
    expect(build(state, result.lot)).toBe(id);
    expect(cell.side).toBe(1);
    expect(submit(state, command("BulldozeBuilding", { buildings: [stale] }))).toEqual({ ok: false, reason: BUILDING_CHANGED });
    expect(isBuilding(state.buildings, id)).toBe(true);
  });

  it("refuses a building cleared and built again on the same lot under the same id (M2 review, #147)", () => {
    const { state, ids } = housed();
    const id = ids[0] as number;
    const row = readBuilding(state.buildings, id);
    const stale = seen(state, id);
    ok(state, command("BulldozeBuilding", { buildings: [stale] }));
    // The grower's next building on that lot takes the freed id and starts from the same first cell.
    expect(addBuilding(state, row)).toBe(id);
    expect(seen(state, id)).toEqual({ ...stale, builtAt: state.tick });
    expect(submit(state, command("BulldozeBuilding", { buildings: [stale] }))).toEqual({ ok: false, reason: BUILDING_CHANGED });
    expect(isBuilding(state.buildings, id)).toBe(true);
  });

  it("refuses the whole command when one building of it changed", () => {
    const { state, ids } = housed();
    const [a, b] = ids as [number, number];
    const c = command("BulldozeBuilding", { buildings: [seen(state, a), { ...seen(state, b), place: 99 }] });
    expect(submit(state, c)).toEqual({ ok: false, reason: BUILDING_CHANGED });
    expect(live(state)).toEqual(ids);
  });

  it("refuses a malformed payload, a building named twice and too many buildings", () => {
    const { state, ids } = housed();
    const a = seen(state, ids[0] as number);
    for (const payload of [{}, { buildings: [] }, { buildings: [{ id: 0 }] }, { buildings: [{ ...a, id: 0.5 }] }, { buildings: "all" }]) {
      expect(submit(state, command("BulldozeBuilding", payload)).ok, JSON.stringify(payload)).toBe(false);
    }
    expect(submit(state, command("BulldozeBuilding", { buildings: [a, a] }))).toEqual({ ok: false, reason: `Building ${a.id} is named twice` });
    const many = Array.from({ length: BUILDINGS_BALANCE.bulldozeMaxBuildings + 1 }, (_, i) => ({ ...a, id: i }));
    expect(submit(state, command("BulldozeBuilding", { buildings: many })).ok).toBe(false);
  });

  it("drops a second clear of the same building, since the first changed it", () => {
    const { state, ids } = housed();
    const a = seen(state, ids[0] as number);
    const first = command("BulldozeBuilding", { buildings: [a] });
    const second = command("BulldozeBuilding", { buildings: [a] }, "p2");
    expect(submit(state, first)).toEqual({ ok: true });
    expect(submit(state, second)).toEqual({ ok: true });
    // One clear a tick (`cellCommandsPerTick`, M2 review #147): the second is checked on the next.
    expect(step(state)).toEqual([]);
    expect(step(state)).toEqual([{ seq: second.seq, playerId: "p2", type: "BulldozeBuilding", reason: BUILDING_CHANGED }]);
  });
});

describe("a big change of roads", () => {
  /** A city of houses and a grid over it too big to settle in one tick. */
  function gridOverHouses(): { state: SimState; payload: unknown } {
    const state = createState(SEED);
    for (const z of [4500, 4600, 4700, 4800]) ok(state, road([4150, z], [4650, z]));
    const rects = [];
    for (const x of [4152, 4402]) for (const z of [4550, 4750]) rects.push({ from: { x, z }, to: { x: x + 246, z }, width: 200 });
    ok(state, command("ZoneCells", { zone: "residential", density: 1, rects }));
    for (const z of [4500, 4600, 4700, 4800]) {
      for (const side of [-1, 1]) {
        for (let x = 4154; x < 4650; x += CELL) {
          const cell = cellAt(state, x, z + side * 9);
          const result = cell && findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
          if (result?.ok) build(state, result.lot);
        }
      }
    }
    const payload = { origin: { x: 4176, z: 4450 }, along: { x: 4624, z: 4450 }, across: { x: 4176, z: 4850 }, depth: 70, width: 60, type: "street" };
    return { state, payload };
  }

  it("removes the buildings it blocks on the tick its cells settle by, and a city saved mid-settle does the same", () => {
    const { state, payload } = gridOverHouses();
    const preview = previewBuildRoadGrid(state, payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.clears.ids.length).toBeGreaterThan(0);
    const before = live(state);
    ok(state, command("BuildRoadGrid", payload));
    const ready = state.cellsReadyAt;
    expect(ready).toBeGreaterThan(state.tick + 1);
    // Following the grid did not walk its cells in one step, past the tick budget.
    expect(cellsWalked(state)).toBe(false);
    // Mid-settle: nothing the grid blocks has gone yet.
    step(state);
    expect(cellsWalked(state)).toBe(false);
    expect(live(state)).toEqual(before);
    // One copy saved now and one saved on the last tick before the cells settle.
    const early = deserialize(serialize(state)).state;
    let late: SimState | null = null;
    let goneAt = -1;
    while (state.tick <= ready) {
      if (state.tick === ready) late = deserialize(serialize(state)).state;
      const tick = state.tick;
      step(state);
      step(early);
      if (late && late.tick === tick) step(late);
      if (goneAt < 0 && live(state).length < before.length) goneAt = tick;
      expect(hashState(early), `tick ${tick}`).toBe(hashState(state));
      if (late) expect(hashState(late), `tick ${tick}`).toBe(hashState(state));
    }
    expect(goneAt).toBe(ready);
    expect(live(state)).toEqual(before.filter((id) => !preview.clears.ids.includes(id)));
    expectSound(state);
  });
});

describe("the building index across changes of roads", () => {
  // Random zones of every kind, grown to 40 buildings: hold every bar up (M3-07).
  holdEach();
  it("kept current agrees with one built afresh, through random roads, bulldozes, undos, upgrades and growth", () => {
    const state = createState(SEED);
    for (const z of [4500, 4600, 4700]) ok(state, road([4150, z], [4650, z]));
    for (const x of [4200, 4400, 4600]) ok(state, road([x, 4450], [x, 4750]));
    // A stroke waits for the streets' cells to settle (M2 review, #147).
    while (!cellsSettled(state)) step(state);
    const zones = ["residential", "commercial", "office", "industrial", "mixed"];
    const rng = seedRng(106);
    for (let i = 0; i < 6; i++) {
      const x = 4150 + nextInt(rng, 400);
      const z = 4450 + nextInt(rng, 250);
      ok(state, command("ZoneCells", { zone: zones[nextInt(rng, 5)], density: 1 + nextInt(rng, 3), rects: [{ from: { x, z }, to: { x: x + 200, z }, width: 120 }] }));
    }
    while (live(state).length < 40) step(state);
    for (let round = 0; round < 30; round++) {
      const pick = nextInt(rng, 5);
      const limit = segmentIdLimit(state.roads);
      const segs = Array.from({ length: limit }, (_, s) => s).filter((s) => isSegment(state.roads, s));
      const seg = segs[nextInt(rng, segs.length)] as number;
      let c: Command;
      if (pick === 0) {
        const x = 4150 + CELL * nextInt(rng, 60);
        c = road([x, 4450], [x + CELL * nextInt(rng, 10), 4750]);
      } else if (pick === 1) {
        const z = 4450 + CELL * nextInt(rng, 35);
        c = road([4150, z], [4650, z + CELL * nextInt(rng, 4)]);
      } else if (pick === 2) c = command("BulldozeRoad", { segments: [seg] });
      else if (pick === 3) c = command("UpgradeRoad", { segments: [seg], type: nextInt(rng, 2) === 0 ? "avenue" : "street" });
      else c = command("Undo", {});
      submit(state, c);
      step(state);
      expectSound(state);
      for (let i = 0; i < 1 + nextInt(rng, DAY); i++) step(state);
      expectSound(state);
    }
  });
});

/**
 * The commands behind fixtures/replay/roads-and-buildings.json, stepped
 * live, picking what to clear from the city as it is then, as a player
 * would. On seed 2026: p1 builds a street, zones R1 four deep along its
 * north side and p2 R1 three deep along its south side. Twelve days of
 * growth, then p2 runs a street south from x 4336, which splits the first
 * one under the houses across it and clears the houses in its way. p1
 * clears its lowest-numbered house on the north side with BulldozeBuilding,
 * then runs a street north from x 4280 through its houses. p2 bulldozes its
 * street. Six days on its undo is refused, since houses grew on the ground
 * meanwhile; p2 clears them and undoes. Twenty-four days. Until M3-07 the
 * south side was C1; a city with no residents now wants no shops.
 */
function playSession(): SimState {
  const state = createState(SEED);
  let n = 0;
  const send = (type: string, payload: unknown, playerId = "p1") => {
    expect(submit(state, { seq: ++n, playerId, type, payload }), type).toEqual({ ok: true });
  };
  const until = (tick: number) => {
    while (state.tick < tick) step(state);
  };
  send("BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
  until(1);
  send("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4579 }, to: { x: 4390, z: 4579 }, width: 28 }] });
  send("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4617 }, to: { x: 4390, z: 4617 }, width: 20 }] }, "p2");
  until(12 * DAY);
  send("BuildRoad", { from: { x: 4336, z: 4600 }, to: { x: 4336, z: 4700 }, type: "street" }, "p2");
  until(13 * DAY);
  const north = live(state).filter((id) => state.buildings.firstSide[id] === 0 && state.buildings.zone[id] === 1);
  const house = north[0] as number;
  send("BulldozeBuilding", {
    buildings: [
      {
        id: house,
        segment: state.buildings.firstSeg[house],
        side: state.buildings.firstSide[house],
        place: state.buildings.firstPlace[house],
        builtAt: state.buildings.builtAt[house],
      },
    ],
  });
  until(14 * DAY);
  send("BuildRoad", { from: { x: 4280, z: 4500 }, to: { x: 4280, z: 4600 }, type: "street" });
  until(16 * DAY);
  send("BulldozeRoad", withEnds(state.roads, { segments: [cellAt(state, 4343, 4680)?.segment as number] }), "p2");
  until(22 * DAY);
  // Houses grew on the cells where the street was, so the undo would clear
  // them, and it is refused (M2 review, #147). p2 clears them and undoes.
  expect(submit(state, { seq: ++n, playerId: "p2", type: "Undo", payload: {} }).ok).toBe(false);
  const half = halfWidth("street");
  const inTheWay = live(state).filter((id) => {
    const [lo, hi] = xRange(state, id);
    return lo < 4336 + half && hi > 4336 - half && (buildingInfo(state, id)?.corners?.[1] ?? 0) > 4600;
  });
  expect(inTheWay.length).toBeGreaterThan(0);
  const b = state.buildings;
  send("BulldozeBuilding", { buildings: inTheWay.map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] })) }, "p2");
  until(22 * DAY + 1);
  send("Undo", {}, "p2");
  until(24 * DAY);
  return state;
}

const fixture = fixtureJson as ReplayFixture;

describe("replay fixture roads-and-buildings", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    expectSound(state);
  });

  it("matches the same commands stepped live", () => {
    const state = playSession();
    expect(state.log).toEqual(fixture.log);
    expect(hashState(state)).toBe(fixture.hash);
  });

  it("builds, grows and clears along the way", () => {
    const at = (tick: number) => replay(fixture.seed, fixture.log, tick);
    const count = (s: SimState) => live(s).length;
    // Side 0 is the north side of the first street, side 1 the south.
    const bySide = (s: SimState, side: number) => live(s).filter((id) => s.buildings.firstSide[id] === side).length;
    // Grown on both sides by day 12.
    const grown = at(1200);
    expect(bySide(grown, 0)).toBeGreaterThan(0);
    expect(bySide(grown, 1)).toBeGreaterThan(0);
    // The street south clears houses on its side, and the houses across the split stand.
    const split = at(1201);
    expect(bySide(split, 1)).toBeLessThan(bySide(grown, 1));
    expect(bySide(split, 0)).toBe(bySide(grown, 0));
    // BulldozeBuilding clears one house.
    expect(count(at(1301))).toBe(count(at(1300)) - 1);
    // The street north clears houses.
    expect(bySide(at(1401), 0)).toBeLessThan(bySide(at(1400), 0));
    // The undo of the bulldoze waits for the houses on its ground to be cleared (M2 review, #147).
    expect(count(at(2201))).toBeLessThan(count(at(2200)));
    expect(fixture.log.filter((e) => e.type === "Undo").map((e) => e.tick)).toEqual([2201]);
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

  it.each([600, 1201, 1350, 1601, 2100, 2201])("hashes the same saved and loaded at tick %d", (at) => {
    expect(hashState(replaySavedAt(at))).toBe(fixture.hash);
  });

  it("gives the same hash replayed twice", () => {
    expect(runFixture(fixture).hash).toBe(runFixture(fixture).hash);
  });
});

describe("a client's copy", () => {
  /** A copy of `state` that follows it by deltas, as the mirror does. */
  function follow(state: SimState): { copy: SimState; sync: () => void } {
    const copy = deserialize(serialize(state)).state;
    prepareDerived(copy);
    recordRoadChanges(state.roads);
    recordCellChanges(state);
    recordBuildingChanges(state);
    // Asked about buildings, so it keeps its building index.
    buildingIndexSets(copy);
    const sync = () => {
      const changes = drainRoadChanges(state.roads);
      const roads = changes ? encodeRoadDelta(state.roads, changes) : null;
      if (roads) expect(typeof applyRoadDelta(copy.roads, roads)).not.toBe("string");
      const cells = drainCellDelta(state);
      if (roads || cells) expect(typeof applyCellDelta(copy, cells, roads ? [...roads.segIds] : [])).not.toBe("string");
      const buildings = drainBuildingDelta(state);
      if (buildings) expect(typeof applyBuildingDelta(copy, buildings)).not.toBe("string");
    };
    return { copy, sync };
  }

  it("keeps its building index right through a reverse, a split and a bulldoze", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4304, 4600], "oneWay"));
    ok(state, road([4304, 4600], [4392, 4600], "oneWay"));
    zone(state, "residential", 1, 0, 24, 4, "both");
    fill(state);
    const { copy, sync } = follow(state);
    const check = () => {
      sync();
      expect(rows(copy)).toEqual(rows(state));
      const { kept, fresh } = buildingIndexSets(copy);
      expect(Array.from(kept.cells)).toEqual(Array.from(fresh.cells));
      expect(kept.chunks).toEqual(fresh.chunks);
      expect(Array.from(kept.cells)).toEqual(Array.from(buildingIndexSets(state).kept.cells));
      expect(kept.sums).toEqual(fresh.sums);
      expect(kept.sums).toEqual(buildingIndexSets(state).kept.sums);
      expectSameGrid(kept.pollution, fresh.pollution);
    };
    ok(state, command("UpgradeRoad", { segments: [cellAt(state, 4350, 4591)?.segment as number], type: "oneWay" }));
    check();
    ok(state, road([4256, 4600], [4256, 4700]));
    check();
    ok(state, command("BulldozeRoad", { segments: [cellAt(state, 4230, 4591)?.segment as number] }));
    check();
  });
});

describe("undo of a bulldoze over ground built on since (M2 review, #147)", () => {
  /** p1's street at z 4600, bulldozed by p1, and p2's street 32 m north of it, inside the ground the first one's cells held. */
  function bulldozedThenBuiltBeside(): SimState {
    const state = street();
    const seg = cellAt(state, 4300, 4591)?.segment as number;
    ok(state, command("BulldozeRoad", withEnds(state.roads, { segments: [seg] })));
    ok(state, command("BuildRoad", { from: { x: 4200, z: 4568 }, to: { x: 4392, z: 4568 }, type: "street" }, "p2"));
    while (!cellsSettled(state)) step(state);
    return state;
  }

  it("is refused when buildings stand on ground the street would take back", () => {
    const state = bulldozedThenBuiltBeside();
    // p2 zones the south side of its street, over where the first street and its cells were.
    ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4597 }, to: { x: 4390, z: 4597 }, width: 46 }] }, "p2"));
    const until = state.tick + 20 * DAY;
    while (state.tick < until && live(state).length === 0) step(state);
    expect(live(state).length).toBeGreaterThan(0);
    const before = hashState(state);
    expect(submit(state, command("Undo", {}))).toEqual({ ok: false, reason: "Cannot undo: buildings now stand on ground that road would take back" });
    expect(hashState(state)).toBe(before);
    // Once p2's buildings there are cleared, the undo goes through.
    const b = state.buildings;
    const seen = live(state).map((id) => ({ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] }));
    ok(state, command("BulldozeBuilding", { buildings: seen }, "p2"));
    ok(state, command("Undo", {}));
    expectSound(state);
  });

  it("goes through when only empty ground, or zoning, lies there", () => {
    const state = bulldozedThenBuiltBeside();
    ok(state, command("Undo", {}));
    expect(cellAt(state, 4300, 4591)).not.toBeNull();
    expectSound(state);
  });

  it("is held, not refused, while a change of roads settles, and checked once the cells settle", () => {
    const state = bulldozedThenBuiltBeside();
    ok(state, command("BuildRoadGrid", { origin: { x: 4104, z: 4704 }, along: { x: 4680, z: 4704 }, across: { x: 4104, z: 4992 }, depth: 86, width: 86, type: "street" }, "p2"));
    expect(cellsSettled(state)).toBe(false);
    const undo = command("Undo", {});
    expect(submit(state, undo)).toEqual({ ok: true });
    step(state);
    expect(state.pending.map((c) => c.seq)).toEqual([undo.seq]);
    while (state.pending.length > 0) step(state);
    expect(state.log.at(-1)?.seq).toBe(undo.seq);
    expect(state.log.at(-1)?.tick).toBe(state.cellsReadyAt);
  });
});

describe("undo of a narrowing over ground built on since (M2 review, #147)", () => {
  it("is refused when the road's wider cells would take back ground a tower now stands on", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600], "avenue"));
    // p2's street 108 m north: the avenue's deepest cells overlap its sixth row, and win it, being older.
    ok(state, command("BuildRoad", { from: { x: 4200, z: 4492 }, to: { x: 4392, z: 4492 }, type: "street" }, "p2"));
    const seg = cellAt(state, 4300, 4591)?.segment as number;
    ok(state, command("UpgradeRoad", withEnds(state.roads, { segments: [seg], type: "street" })));
    while (!cellsSettled(state)) step(state);
    // A street's cells stop 4 m nearer: p2's sixth row is free, and p2 zones it R3.
    ok(state, command("ZoneCells", { zone: "residential", density: 3, rects: [{ from: { x: 4202, z: 4521 }, to: { x: 4390, z: 4521 }, width: 46 }] }, "p2"));
    const deep = (s: SimState) => live(s).filter((id) => (s.buildings.depth[id] ?? 0) === 6);
    const until = state.tick + 60 * DAY;
    while (state.tick < until && deep(state).length === 0) step(state);
    expect(deep(state).length).toBeGreaterThan(0);
    expect(submit(state, command("Undo", {}))).toEqual({ ok: false, reason: "Cannot undo: buildings now stand on ground that road would take back" });
  });
});

import { describe, expect, it } from "vitest";
import {
  BUILDINGS_BALANCE,
  BUILDING_TYPES,
  CELL_LEFT,
  CELL_OPEN,
  NO_BUILDING,
  ZONING_BALANCE,
  applyBuildingDelta,
  buildingInfo,
  buildingOnSlot,
  buildingsInChunk,
  cellAt,
  cellSlot,
  cellStatuses,
  checkBuildingsBalance,
  createState,
  deserialize,
  drainBuildingDelta,
  drainCellDelta,
  drainRoadChanges,
  findLot,
  hashState,
  isBuilding,
  readBuilding,
  recordBuildingChanges,
  recordCellChanges,
  recordRoadChanges,
  serialize,
  step,
  submit,
  type CellRef,
  type Command,
  type Lot,
  type SimState,
} from "../src/index";
import buildingsJson from "../balance/buildings.json";
import { addBuilding, removeBuilding } from "../src/buildings/buildings";
import { cellBuildings } from "../src/buildings/where";
import { nextInt, seedRng } from "../src/rng";
import { cloneState } from "../src/state";
import { nextColumn, syncCells } from "../src/zoning/cell-index";
import { fromLocal, localIndex } from "../src/zoning/cells";

// M2-09: buildings in state, building types and the lot finder.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
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
const road = (from: [number, number], to: [number, number], extra: Record<string, unknown> = {}) =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street", ...extra });

/** A street running east from (4200, 4600) for 24 cells. Its left strip is north of it, from z 4595 back to 4547. */
function street(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4600], [4392, 4600]));
  return state;
}

/** The centre of the cell at place `p` along x from 4200 and `k` deep in the north strip of `street`. */
const north = (p: number, k: number): [number, number] => [4200 + CELL * p + CELL / 2, 4595 - CELL * k - CELL / 2];

/**
 * Zones the north strip of `street` from place `p0` for `w` places, `d`
 * cells deep, with one ZoneCells command.
 */
function zoneNorth(state: SimState, zone: string, density: number, p0: number, w: number, d: number): void {
  const [x0, zMid0] = north(p0, 0);
  const [x1] = north(p0 + w - 1, 0);
  const z = zMid0 - (CELL * (d - 1)) / 2;
  ok(
    state,
    command("ZoneCells", {
      zone,
      density,
      rects: [{ from: { x: x0 - 2, z }, to: { x: x1 + 2, z }, width: CELL * (d - 1) + 4 }],
    }),
  );
}

/** The cell whose ground holds the point. */
function refAt(state: SimState, [x, z]: [number, number]): CellRef {
  const cell = cellAt(state, x, z);
  if (!cell) throw new Error(`no cell at ${x}, ${z}`);
  return { segment: cell.segment, side: cell.side, place: cell.place, depth: cell.depth };
}

function lotAt(state: SimState, at: [number, number]): Lot {
  const result = findLot(state, refAt(state, at));
  if (!result.ok) throw new Error(`no lot: ${result.reason}`);
  return result.lot;
}

/** Adds the building a lot fits, with the type's low residents. */
function build(state: SimState, lot: Lot, variant = 0): number {
  const type = BUILDING_TYPES[lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...lot, residents: type.residents[0], variant });
}

describe("building types", () => {
  it("are all well formed in the balance file", () => {
    expect(checkBuildingsBalance(buildingsJson)).toEqual([]);
    expect(BUILDINGS_BALANCE.types.length).toBe(BUILDING_TYPES.length);
  });

  it("refuse a type missing any field", () => {
    for (const field of ["id", "name", "zone", "density", "width", "depth", "residents"]) {
      const types = buildingsJson.types.map((t, i) => (i === 3 ? Object.fromEntries(Object.entries(t).filter(([key]) => key !== field)) : t));
      const errors = checkBuildingsBalance({ ...buildingsJson, types });
      expect(errors.some((e) => e.includes(`types[3].${field} is missing`)), field).toBe(true);
    }
  });

  it("refuse two types of one zone and density that take the same lot shape", () => {
    const types = buildingsJson.types.map((t) => ({ ...t }));
    // Plexes reach down to 2 x 4, which single family homes take.
    const plex = types.findIndex((t) => t.id === "plex");
    types[plex] = { ...(types[plex] as (typeof types)[number]), width: [2, 3] };
    const errors = checkBuildingsBalance({ ...buildingsJson, types });
    expect(errors.some((e) => /"plex" and "single-family-home" both take a 2 x \d lot/.test(e))).toBe(true);
    // The same shape in another density is fine.
    const other = buildingsJson.types.map((t) => (t.id === "plex" ? { ...t, density: 2, width: [6, 6], depth: [6, 6] } : t));
    expect(checkBuildingsBalance({ ...buildingsJson, types: other })).toEqual([]);
  });

  it("refuse unknown zones and densities, and lots past the size limits", () => {
    const bad = (patch: Record<string, unknown>) => checkBuildingsBalance({ ...buildingsJson, types: [{ ...buildingsJson.types[0], ...patch }] });
    expect(bad({ zone: "farm" })).toEqual([expect.stringMatching(/zone "farm" is not a zone/)]);
    expect(bad({ density: 4 })).toEqual([expect.stringMatching(/density 4 is not a density/)]);
    expect(bad({ width: [1, BUILDINGS_BALANCE.maxLotWidth + 1] })).toEqual([expect.stringMatching(/width/)]);
    expect(bad({ depth: [0, 2] })).toEqual([expect.stringMatching(/depth/)]);
    expect(bad({ depth: [3, DEPTH + 1] })).toEqual([expect.stringMatching(/depth/)]);
    expect(bad({ residents: [4, 1] })).toEqual([expect.stringMatching(/residents/)]);
  });

  it("give three or four types to every density of commercial, office, industrial and mixed, as proposals", () => {
    for (const zone of ["commercial", "office", "industrial", "mixed"]) {
      for (const density of [1, 2, 3]) {
        const types = BUILDING_TYPES.filter((t) => t.zone === zone && t.density === density);
        expect(types.length, `${zone} ${density}`).toBeGreaterThanOrEqual(3);
        expect(types.length, `${zone} ${density}`).toBeLessThanOrEqual(4);
        expect(types.every((t) => t.proposal === true)).toBe(true);
      }
    }
    // The six housing types are the PRD's, not proposals.
    expect(BUILDING_TYPES.filter((t) => t.zone === "residential").map((t) => [t.id, t.proposal ?? false])).toEqual([
      ["single-family-home", false],
      ["plex", false],
      ["townhomes", false],
      ["apartments", false],
      ["low-tower", false],
      ["high-tower", false],
    ]);
  });
});

describe("the lot finder", () => {
  // Each row of the PRD's housing table, at its smallest and its largest lot.
  const rows: [string, number, number, number][] = [];
  const add = (id: string, density: number, [w0, w1]: number[], [d0, d1]: number[]) => {
    rows.push([id, density, w0 as number, d0 as number], [id, density, w1 as number, d1 as number]);
  };
  add("single-family-home", 1, [1, 2], [2, 4]);
  add("plex", 1, [3, 3], [3, 5]);
  add("townhomes", 2, [1, 5], [2, 3]);
  add("apartments", 2, [3, 4], [4, 6]);
  add("low-tower", 3, [4, 4], [4, 6]);
  add("high-tower", 3, [5, 6], [5, 6]);

  it.each(rows)("gives a %s on a lot zoned R%d, %d wide and %d deep", (id, density, w, d) => {
    const state = street();
    zoneNorth(state, "residential", density, 4, w, d);
    // From the cell at the road at either end of the lot, and its far corner.
    for (const [p, k] of [
      [4, 0],
      [4 + w - 1, 0],
      [4 + w - 1, d - 1],
    ] as const) {
      const lot = lotAt(state, north(p, k));
      expect(typeId(lot.type)).toBe(id);
      expect([lot.width, lot.depth]).toEqual([w, d]);
    }
  });

  it("gives townhomes on a shallow R2 strip and apartments on a deep one", () => {
    const shallow = street();
    zoneNorth(shallow, "residential", 2, 0, 24, 3);
    const town = lotAt(shallow, north(10, 0));
    expect(typeId(town.type)).toBe("townhomes");
    expect([town.width, town.depth]).toEqual([5, 3]);

    const deep = street();
    zoneNorth(deep, "residential", 2, 0, 24, 6);
    const flats = lotAt(deep, north(10, 0));
    expect(typeId(flats.type)).toBe("apartments");
    expect([flats.width, flats.depth]).toEqual([4, 6]);
  });

  it("gives a wide R1 lot a plex and a narrow one a house", () => {
    const wide = street();
    zoneNorth(wide, "residential", 1, 0, 24, 6);
    expect(typeId(lotAt(wide, north(8, 0)).type)).toBe("plex");
    const narrow = street();
    zoneNorth(narrow, "residential", 1, 8, 2, 6);
    const house = lotAt(narrow, north(8, 0));
    expect(typeId(house.type)).toBe("single-family-home");
    expect([house.width, house.depth]).toEqual([2, 4]);
  });

  it("finds nothing on an R3 lot of 3 x 6, and says why", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 3, 6);
    for (const at of [north(4, 0), north(6, 5)]) {
      const result = findLot(state, refAt(state, at));
      expect(result).toEqual({
        ok: false,
        problem: "too-narrow",
        reason: "R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 wide",
        need: { width: 4, depth: 4 },
        room: { width: 3, depth: 6 },
      });
    }
  });

  it("says when the zoned ground is too shallow", () => {
    const state = street();
    zoneNorth(state, "residential", 3, 4, 8, 3);
    const result = findLot(state, refAt(state, north(6, 0)));
    expect(result.ok === false && result.problem).toBe("too-shallow");
    expect(result.ok === false && result.reason).toBe("R3 needs a lot at least 4 wide and 4 deep; the zoned ground here is 3 deep");
  });

  it("refuses a cell that does not exist, is unzoned, blocked, built on or cut off from the road", () => {
    const state = street();
    const ref = refAt(state, north(4, 0));
    expect(findLot(state, { ...ref, place: 999 })).toMatchObject({ ok: false, problem: "no-cell" });
    expect(findLot(state, ref)).toMatchObject({ ok: false, problem: "unzoned" });
    zoneNorth(state, "residential", 1, 0, 24, 6);
    // A street across the strip blocks the cells under it.
    ok(state, road([4300, 4600], [4300, 4520]));
    expect(findLot(state, refAt(state, [4300, 4580]))).toMatchObject({ ok: false, problem: "blocked" });
    const lot = lotAt(state, north(2, 0));
    build(state, lot);
    expect(findLot(state, refAt(state, north(2, 0)))).toMatchObject({ ok: false, problem: "built", reason: "A building stands here" });
    // A cell behind a built one is cut off from the road.
    expect(findLot(state, refAt(state, north(lot.firstPlace, lot.depth)))).toMatchObject({ ok: false, problem: "off-road" });
  });

  it("fits a lot beside a building, never over it", () => {
    const state = street();
    zoneNorth(state, "residential", 2, 0, 9, 6);
    const first = lotAt(state, north(0, 0));
    expect([first.firstPlace, first.width, first.depth]).toEqual([0, 4, 6]);
    build(state, first);
    // Five places are left: room for apartments of four. Of the lots that
    // hold the cell asked about, the one that starts first along the strip.
    expect(lotAt(state, north(8, 0)).firstPlace).toBe(5);
    const second = lotAt(state, north(4, 0));
    expect(typeId(second.type)).toBe("apartments");
    expect([second.firstPlace, second.width]).toEqual([4, 4]);
    build(state, second);
    // One place is left: one townhome.
    const last = lotAt(state, north(8, 0));
    expect(typeId(last.type)).toBe("townhomes");
    expect([last.firstPlace, last.width, last.depth]).toEqual([8, 1, 3]);
  });

  it("runs a lot across a T-junction on the far side of the street", () => {
    const state = street();
    // A street from the south side meets it at x 4296, which splits it.
    ok(state, road([4296, 4600], [4296, 4700]));
    zoneNorth(state, "residential", 3, 9, 6, 6);
    const lot = lotAt(state, north(9, 0));
    expect(typeId(lot.type)).toBe("high-tower");
    expect([lot.width, lot.depth]).toEqual([6, 6]);
    // Its columns are on both pieces.
    const index = syncCells(state);
    const segs = new Set<number>([lot.firstSeg]);
    let col: ReturnType<typeof nextColumn> = { seg: lot.firstSeg, side: lot.firstSide, place: lot.firstPlace, dir: lot.dir };
    for (let i = 1; i < lot.width; i++) {
      col = col && nextColumn(index, col);
      if (col) segs.add(col.seg);
    }
    expect(segs.size).toBe(2);
    const id = build(state, lot);
    // Every cell of it says so, on both pieces.
    for (let p = 9; p < 15; p++) {
      for (let k = 0; k < 6; k++) {
        const cell = cellAt(state, ...north(p, k));
        expect(cell && buildingOnSlot(state, cell.index), `${p}, ${k}`).toBe(id);
      }
    }
    expect(buildingOnSlot(state, (cellAt(state, ...north(15, 0)) as { index: number }).index)).toBe(NO_BUILDING);
  });

  it("runs a lot across two streets drawn end to end in a straight line", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4296, 4600]));
    ok(state, road([4296, 4600], [4392, 4600]));
    zoneNorth(state, "residential", 3, 9, 6, 6);
    const lot = lotAt(state, north(14, 5));
    expect(typeId(lot.type)).toBe("high-tower");
    expect(lot.width).toBe(6);
  });

  it("stops a strip where the road turns a corner", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4296, 4600]));
    ok(state, road([4296, 4600], [4296, 4700]));
    const index = syncCells(state);
    const ref = refAt(state, north(11, 0));
    // The last column on either side of the first street leads nowhere.
    for (const side of [0, 1]) expect(nextColumn(index, { seg: ref.segment, side, place: ref.place, dir: ref.place === 0 ? 1 : 0 })).toBeNull();
  });

  it("fits lots wider than one cell along a curve", () => {
    const state = createState(SEED);
    ok(state, road([4150, 4700], [4450, 4700], { control: { x: 4300, z: 4550 } }));
    // Zone every open cell of the strip on the outside of the bend R3.
    const statuses = cellStatuses(state);
    const zoned: number[] = [];
    statuses.forEach((s, slot) => {
      if (s === CELL_OPEN) zoned.push(slot);
    });
    for (const slot of zoned) {
      state.cells.zone[slot] = 1;
      state.cells.density[slot] = 3;
    }
    const seg = cellAt(state, 4300, 4620)?.segment ?? -1;
    for (const side of [0, 1]) {
      const result = findLot(state, { segment: seg, side, place: 10, depth: 0 });
      expect(result.ok && result.lot.width, `side ${side}`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("buildings in state", () => {
  /** A street with R2 apartments and townhomes along its north side. */
  function built(): { state: SimState; ids: number[] } {
    const state = street();
    zoneNorth(state, "residential", 2, 0, 12, 6);
    const ids = [build(state, lotAt(state, north(0, 0)), 1), build(state, lotAt(state, north(4, 0)), 2)];
    return { state, ids };
  }

  it("holds each building's lot, type and numbers in flat arrays, with no class instances, maps or closures", () => {
    const { state, ids } = built();
    expect(ids).toEqual([0, 1]);
    expect(readBuilding(state.buildings, 1)).toEqual({
      id: 1,
      firstSeg: refAt(state, north(4, 0)).segment,
      firstSide: CELL_LEFT,
      firstPlace: 4,
      dir: 0,
      width: 4,
      depth: 6,
      zone: 1,
      density: 2,
      type: BUILDING_TYPES.findIndex((t) => t.id === "apartments"),
      residents: 50,
      variant: 2,
      builtAt: state.tick,
    });
    expect(Object.getPrototypeOf(state.buildings)).toBe(Object.prototype);
    for (const [key, value] of Object.entries(state.buildings)) {
      expect(ArrayBuffer.isView(value), key).toBe(true);
      expect(typeof value).not.toBe("function");
    }
    expect(cloneState(state).buildings).toEqual(state.buildings);
  });

  it("serialises, deserialises and hashes the same with buildings", () => {
    const { state } = built();
    const back = deserialize(serialize(state)).state;
    expect(hashState(back)).toBe(hashState(state));
    expect(back.buildings).toEqual(state.buildings);
    expect(hashState(cloneState(state))).toBe(hashState(state));
    // The loaded city knows which cells are built on.
    const slot = (cellAt(back, ...north(5, 3)) as { index: number }).index;
    expect(buildingOnSlot(back, slot)).toBe(1);
    expect(hashState(back)).not.toBe(hashState(street()));
  });

  it("frees an id on removal and hands it out again", () => {
    const { state, ids } = built();
    removeBuilding(state, ids[0] as number);
    expect(isBuilding(state.buildings, 0)).toBe(false);
    expect(Array.from(state.buildings.free)).toEqual([0]);
    expect(state.buildings.flags[0]).toBe(0);
    expect(state.buildings.type[0]).toBe(0);
    expect(buildingOnSlot(state, (cellAt(state, ...north(0, 0)) as { index: number }).index)).toBe(NO_BUILDING);
    // The ground is free again.
    const lot = lotAt(state, north(0, 0));
    expect(build(state, lot)).toBe(0);
    expect(state.buildings.free).toHaveLength(0);
    expect(deserialize(serialize(state)).state.buildings).toEqual(state.buildings);
  });

  it("refuses a save whose buildings are malformed", () => {
    const { state } = built();
    const refused = (change: (s: SimState) => void, reason: RegExp) => {
      const copy = cloneState(state);
      change(copy);
      expect(() => deserialize(serialize(copy))).toThrow(reason);
    };
    refused((s) => void (s.buildings.type[0] = 9999), /buildings are malformed: building 0 has an unknown type/);
    refused((s) => void (s.buildings.width[1] = 6), /lot does not fit its type/);
    refused((s) => void (s.buildings.firstSeg[0] = 999), /segment that is not there/);
    refused((s) => void (s.buildings.builtAt[0] = s.tick + 1), /built on a bad tick/);
    refused((s) => void (s.buildings.free = Int32Array.of(0)), /free list is malformed/);
    refused((s) => void (s.buildings.zone = s.buildings.zone.slice(1)), /arrays differ in length/);
    refused((s) => {
      removeBuilding(s, 0);
      s.buildings.residents[0] = 3;
    }, /free id 0 has a row/);
  });

  it("keeps which building stands where as a fresh copy of the city works it out", () => {
    const state = street();
    zoneNorth(state, "residential", 1, 0, 24, 6);
    ok(state, command("ZoneCells", { zone: "commercial", density: 2, rects: [{ from: { x: 4204, z: 4610 }, to: { x: 4388, z: 4610 }, width: 12 }] }));
    const rng = seedRng(104);
    const slots = Array.from(state.cells.zone.keys());
    for (let i = 0; i < 60; i++) {
      const live = Array.from(state.buildings.flags.keys()).filter((id) => isBuilding(state.buildings, id));
      if (live.length > 0 && nextInt(rng, 3) === 0) {
        removeBuilding(state, live[nextInt(rng, live.length)] as number);
      } else {
        const slot = slots[nextInt(rng, slots.length)] as number;
        const result = findLot(state, refOfSlot(state, slot));
        if (result.ok) build(state, result.lot, nextInt(rng, 4));
      }
      const fresh = cloneState(state);
      expect(cellBuildings(state)).toEqual(cellBuildings(fresh));
      for (let id = 0; id < state.buildings.flags.length; id++) expect(buildingInfo(state, id)).toEqual(buildingInfo(fresh, id));
    }
    expect(state.buildings.free.length).toBeGreaterThan(0);
    expect(state.buildings.flags.length - state.buildings.free.length).toBeGreaterThan(2);
  });

  it("files each building in the chunk its lot's centre is in", () => {
    const { state, ids } = built();
    const info = buildingInfo(state, ids[1] as number);
    if (!info?.corners) throw new Error("no corners");
    // The lot runs 4 places from x 4232, from the road's edge 6 cells back.
    const xs = [0, 2, 4, 6].map((i) => info.corners?.[i] ?? 0);
    const zs = [1, 3, 5, 7].map((i) => info.corners?.[i] ?? 0);
    expect(Math.min(...xs)).toBeCloseTo(4232, 6);
    expect(Math.max(...xs)).toBeCloseTo(4264, 6);
    expect(Math.max(...zs)).toBeCloseTo(4595, 6);
    expect(Math.min(...zs)).toBeCloseTo(4547, 6);
    expect(buildingsInChunk(state, info.chunk)).toEqual(ids);
    expect(buildingInfo(state, 7)).toBeNull();
  });
});

describe("building deltas", () => {
  it("hold one added building and nothing else", () => {
    const state = street();
    zoneNorth(state, "residential", 1, 0, 6, 6);
    recordRoadChanges(state.roads);
    recordCellChanges(state);
    recordBuildingChanges(state);
    const id = build(state, lotAt(state, north(0, 0)));
    const delta = drainBuildingDelta(state);
    expect(delta?.ids).toEqual(Int32Array.of(id));
    expect(delta?.limit).toBe(1);
    expect(delta?.free).toBeUndefined();
    expect(delta?.rows.type).toEqual(Uint16Array.of(state.buildings.type[id] ?? 0));
    expect(drainCellDelta(state)).toBeNull();
    expect(drainRoadChanges(state.roads)).toBeNull();
    expect(drainBuildingDelta(state)).toBeNull();
  });

  it("bring a copy of the city to the same buildings, and say which chunks changed", () => {
    const state = street();
    zoneNorth(state, "residential", 2, 0, 24, 6);
    const copy = cloneState(state);
    recordBuildingChanges(state);
    // A copy that has never been asked about buildings learns of no chunk.
    const a = build(state, lotAt(state, north(0, 0)));
    const b = build(state, lotAt(state, north(4, 0)));
    expect(applyBuildingDelta(copy, drainBuildingDelta(state) ?? fail())).toEqual([]);
    expect(copy.buildings).toEqual(state.buildings);
    // Once asked, it does.
    const chunk = buildingInfo(copy, a)?.chunk ?? -1;
    expect(buildingsInChunk(copy, chunk)).toEqual([a, b]);
    removeBuilding(state, a);
    const c = build(state, lotAt(state, north(12, 0)));
    expect(c).toBe(a);
    const delta = drainBuildingDelta(state) ?? fail();
    expect(Array.from(delta.ids)).toEqual([a]);
    expect(applyBuildingDelta(copy, delta)).toEqual([chunk]);
    expect(copy.buildings).toEqual(state.buildings);
    expect(hashState(copy)).toBe(hashState(state));
    const slot = (cellAt(copy, ...north(0, 0)) as { index: number }).index;
    expect(buildingOnSlot(copy, slot)).toBe(NO_BUILDING);
    expect(buildingOnSlot(copy, slot + localIndex(0, 12, 0))).toBe(buildingOnSlot(state, slot + localIndex(0, 12, 0)));
  });

  it("refuse rows that do not fit the copy", () => {
    const state = street();
    zoneNorth(state, "residential", 1, 0, 6, 6);
    const copy = cloneState(state);
    recordBuildingChanges(state);
    build(state, lotAt(state, north(0, 0)));
    const delta = drainBuildingDelta(state) ?? fail();
    expect(applyBuildingDelta(copy, { ...delta, ids: Int32Array.of() })).toMatch(/rows differ|no rows/);
    expect(applyBuildingDelta(copy, { ...delta, rows: { ...delta.rows, type: Uint16Array.of(9999) } })).toMatch(/unknown type/);
    expect(copy.buildings.flags).toHaveLength(0);
  });
});

/** The name of the cell at `slot` of `state.cells.zone`. */
function refOfSlot(state: SimState, slot: number): CellRef {
  const offset = state.cells.offset;
  let seg = 0;
  while (seg + 1 < offset.length && (offset[seg + 1] ?? 0) <= slot) seg++;
  return { segment: seg, ...fromLocal(slot - (offset[seg] ?? 0)) };
}

function fail(): never {
  throw new Error("expected a delta");
}

// The slot helper the tests above rely on agrees with the sim's.
it("names cells by slot as cellSlot does", () => {
  const state = street();
  const ref = refAt(state, north(3, 2));
  expect(cellSlot(state.roads, state.cells, ref)).toBe((cellAt(state, ...north(3, 2)) as { index: number }).index);
});

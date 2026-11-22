import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  TIME_BALANCE,
  ZONING_BALANCE,
  applyBuildingDelta,
  applyCellDelta,
  applyRoadDelta,
  buildingInfo,
  cellAt,
  createState,
  deserialize,
  drainBuildingDelta,
  drainCellDelta,
  drainRoadChanges,
  encodeRoadDelta,
  findLot,
  hashState,
  isBuilding,
  lotOptions,
  prepareDerived,
  previewBulldozeRoad,
  recordBuildingChanges,
  recordCellChanges,
  recordRoadChanges,
  replay,
  serialize,
  step,
  type Command,
  type Lot,
  type SimState,
} from "../src/index";
import { resolveBuildingsBalance } from "../src/buildings/balance";
import { addBuilding, checkBuildings } from "../src/buildings/buildings";
import { candidateSets } from "../src/buildings/candidates";
import { buildingIndexSets, lotStands, segmentBuildings } from "../src/buildings/where";
import { enqueue } from "../src/commands";
import { cellsSettled, syncCells } from "../src/zoning/cell-index";
import { localIndex } from "../src/zoning/cells";
import buildingsJson from "../balance/buildings.json";
import { FULL_DEMAND, holdDemand } from "./demand-helper";
import { holdEach } from "./hold-each";
import fixtureJson from "./fixtures/replay/through-lots.json";
import { expectReplay, replayFixture, type ReplayFixture } from "./replay-helper";
import { submit, withEnds } from "./seen-ends";

// M2-14: through-lots for large commercial and industrial buildings.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts). A street is 10 m wide.
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const DAY = TIME_BALANCE.ticksPerDay;
const HALF = 5;
const typeId = (index: number) => BUILDING_TYPES[index]?.id;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
function ok(state: SimState, c: Command): void {
  expect(submit(state, c), `${c.type} ${JSON.stringify(c.payload)}`).toEqual({ ok: true });
  step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}
const road = (from: [number, number], to: [number, number]) =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" });

const NORTH = 4600;
const WEST = 4200;
const EAST = 4400;

/**
 * A block between two streets running east from x 4200 to 4400, the second
 * `apart` metres south of the first between road edges, closed by a street
 * down each end. Returns the z of the south street.
 */
function block(state: SimState, apart: number): number {
  const south = NORTH + 2 * HALF + apart;
  ok(state, road([WEST, NORTH], [EAST, NORTH]));
  ok(state, road([WEST, south], [EAST, south]));
  ok(state, road([WEST, NORTH], [WEST, south]));
  ok(state, road([EAST, NORTH], [EAST, south]));
  return south;
}

/** Zones the strip along the north street's south side `zone` at `density`, and the south street's north side `back` (the same by default). */
function zoneBlock(state: SimState, south: number, zone: string, density = 3, back = zone): void {
  const strip = (edge: number, sign: number) => {
    const z = edge + (sign * CELL * DEPTH) / 2;
    return { from: { x: WEST + 2, z }, to: { x: EAST - 2, z }, width: CELL * DEPTH - 4 };
  };
  ok(state, command("ZoneCells", { zone, density, rects: [strip(NORTH + HALF, 1)] }));
  ok(state, command("ZoneCells", { zone: back, density, rects: [strip(south - HALF, -1)] }));
}

/** The front cell of the north street's south strip at x. */
function northCell(state: SimState, x: number) {
  const cell = cellAt(state, x, NORTH + HALF + CELL / 2);
  if (!cell) throw new Error(`no cell at x ${x}`);
  return { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 };
}

function live(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id)) out.push(id);
  return out;
}

const throughIds = (state: SimState) => live(state).filter((id) => (state.buildings.backDepth[id] ?? 0) > 0);

function build(state: SimState, lot: Lot): number {
  return addBuilding(state, { ...lot, residents: 0, variant: 0 });
}

/** Steps until a game day has passed `days` times. */
function grow(state: SimState, days: number): void {
  const until = state.tick + days * DAY;
  while (state.tick < until) step(state);
}

/** Every building stands, its row is well formed, and every derived index kept current matches one built afresh. */
function expectSound(state: SimState): void {
  expect(checkBuildings(state.buildings, state.roads, state.tick)).toBeNull();
  if (cellsSettled(state)) for (const id of live(state)) expect(lotStands(state, id), `building ${id} stands`).toBe(true);
  const { kept, fresh } = buildingIndexSets(state);
  expect(kept.chunks).toEqual(fresh.chunks);
  expect(Array.from(kept.cells)).toEqual(Array.from(fresh.cells));
  const candidates = candidateSets(state, syncCells(state), () => segmentBuildings(state));
  expect(candidates.kept).toEqual(candidates.fresh);
  expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
}

/** The building on the cell at (x, z), or -1. */
function buildingAt(state: SimState, x: number, z: number): number {
  const cell = cellAt(state, x, z);
  if (!cell) return -1;
  return segmentBuildings(state)[cell.segment]?.[localIndex(cell.side, cell.place, cell.depth)] ?? -1;
}

describe("the lot finder", () => {
  it("joins two C3 strips twelve cells apart into one lot holding both", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    const result = findLot(state, northCell(state, 4300));
    if (!result.ok) throw new Error(result.reason);
    const lot = result.lot;
    expect(typeId(lot.type)).toBe("regional-mall");
    expect(lot.width).toBe(12);
    expect(lot.depth).toBe(12);
    expect(lot.backDepth).toBe(DEPTH);
    const id = build(state, lot);
    // It holds the front cell of each strip and the back cell of each.
    for (const z of [NORTH + HALF + 4, NORTH + HALF + 44, south - HALF - 44, south - HALF - 4]) {
      expect(buildingAt(state, 4300, z), `cell at z ${z}`).toBe(id);
    }
    // Its corners run from the north street's edge to the south street's.
    const corners = buildingInfo(state, id)?.corners as number[];
    const zs = [corners[1], corners[3], corners[5], corners[7]] as number[];
    expect(Math.min(...zs)).toBeCloseTo(NORTH + HALF, 6);
    expect(Math.max(...zs)).toBeCloseTo(south - HALF, 6);
    expectSound(state);
  });

  it("gives no through-lot when the strips are C3 and I3", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial", 3, "industrial");
    const options = lotOptions(state, northCell(state, 4300));
    if (!options.ok) throw new Error(options.reason);
    expect(options.lots.every((lot) => lot.backDepth === 0)).toBe(true);
    expect(options.lots.length).toBeGreaterThan(0);
    // Nor from the industrial side.
    const back = cellAt(state, 4300, south - HALF - CELL / 2);
    const fromBack = back && lotOptions(state, { segment: back.segment, side: back.side, place: back.place, depth: 0 });
    expect(fromBack?.ok && fromBack.lots.every((lot) => lot.backDepth === 0)).toBe(true);
  });

  it("gives no through-lot at density 2, nor for housing or offices", () => {
    for (const [zone, density] of [["commercial", 2], ["industrial", 2], ["residential", 3], ["office", 3], ["mixed", 3]] as const) {
      const state = createState(SEED);
      const south = block(state, 12 * CELL);
      zoneBlock(state, south, zone, density);
      const options = lotOptions(state, northCell(state, 4300));
      expect(options.ok && options.lots.every((lot) => lot.backDepth === 0), `${zone} ${density}`).toBe(true);
    }
  });

  it("joins I3 strips into a heavy plant", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "industrial");
    const result = findLot(state, northCell(state, 4300));
    expect(result.ok && typeId(result.lot.type)).toBe("heavy-plant");
  });

  it("bridges a sliver up to the gap in zoning.json, and no wider", () => {
    expect(ZONING_BALANCE.throughLotMaxGap).toBeGreaterThanOrEqual(3);
    expect(ZONING_BALANCE.throughLotMaxGap).toBeLessThan(CELL);
    for (const [sliver, joined] of [
      [3, true],
      [CELL, false],
    ] as const) {
      const state = createState(SEED);
      const south = block(state, 12 * CELL + sliver);
      zoneBlock(state, south, "commercial");
      const result = findLot(state, northCell(state, 4300));
      expect(result.ok && result.lot.backDepth > 0, `a ${sliver} m sliver`).toBe(joined);
    }
  });

  it("joins strips closer than two zoning depths, the back one cut short by the front one's cells", () => {
    const state = createState(SEED);
    const south = block(state, 10 * CELL);
    zoneBlock(state, south, "commercial");
    const result = findLot(state, northCell(state, 4300));
    if (!result.ok) throw new Error(result.reason);
    expect(result.lot.depth).toBe(10);
    // The north street is older, so its strip keeps its six cells.
    expect(result.lot.depth - result.lot.backDepth).toBe(DEPTH);
  });

  it("needs a block: two parallel streets with open ends give no through-lot", () => {
    const state = createState(SEED);
    const south = NORTH + 2 * HALF + 12 * CELL;
    ok(state, road([WEST, NORTH], [EAST, NORTH]));
    ok(state, road([WEST, south], [EAST, south]));
    zoneBlock(state, south, "commercial");
    const options = lotOptions(state, northCell(state, 4300));
    expect(options.ok && options.lots.every((lot) => lot.backDepth === 0)).toBe(true);
  });

  it("joins only strips that are free to their backs", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    // A shop on the back strip's middle, two cells deep: the columns behind
    // it are not free to the back, so no through-lot spans them.
    const back = cellAt(state, 4300, south - HALF - CELL / 2);
    if (!back) throw new Error("no back cell");
    const shop = BUILDING_TYPES.findIndex((t) => t.id === "retail-podium");
    build(state, { type: shop, firstSeg: back.segment, firstSide: back.side, firstPlace: back.place, dir: 0, width: 3, depth: 3, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, backDepth: 0 });
    for (const x of [4300, 4310]) {
      const options = lotOptions(state, northCell(state, x));
      expect(options.ok && options.lots.every((lot) => lot.backDepth === 0), `at x ${x}`).toBe(true);
    }
    // Further west there is room for one.
    const west = findLot(state, northCell(state, 4220));
    expect(west.ok && west.lot.backDepth).toBe(DEPTH);
    expectSound(state);
  });
});

describe("the grower", () => {
  // Low enough that each zone builds one a day.
  holdEach({ commercial: 5, industrial: 5 });
  it("puts one building across both strips of a C3 block", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    grow(state, 1);
    const [id, ...rest] = throughIds(state);
    expect(id).toBeDefined();
    expect(rest).toEqual([]);
    expect(buildingAt(state, 4300, NORTH + HALF + 4) === id || buildingAt(state, 4220, NORTH + HALF + 4) === id || buildingAt(state, 4380, NORTH + HALF + 4) === id).toBe(true);
    const first = id as number;
    const b = state.buildings;
    // One lot on each street.
    expect(b.firstSeg[first]).not.toBe(b.backSeg[first]);
    expect(b.depth[first]).toBe(12);
    expectSound(state);
  });

  it("grows no through-lot on a C3 strip backing onto I3", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial", 3, "industrial");
    grow(state, 8);
    expect(live(state).length).toBeGreaterThan(0);
    expect(throughIds(state)).toEqual([]);
    expectSound(state);
  });
});

describe("a through-lot and its roads", () => {
  /** A block with a through-lot built on it from x 4300. */
  function withMall(): { state: SimState; south: number; id: number } {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    const result = findLot(state, northCell(state, 4300));
    if (!result.ok || result.lot.backDepth === 0) throw new Error("no through-lot");
    return { state, south, id: build(state, result.lot) };
  }

  it.each(["north", "south"] as const)("goes when the %s street is bulldozed", (which) => {
    const { state, south, id } = withMall();
    const z = which === "north" ? NORTH + HALF + 4 : south - HALF - 4;
    const seg = cellAt(state, 4300, z)?.segment as number;
    const payload = { segments: [seg] };
    const preview = previewBulldozeRoad(state, withEnds(state.roads, payload));
    expect(preview.ok && preview.clears.ids).toEqual([id]);
    ok(state, command("BulldozeRoad", payload));
    expect(isBuilding(state.buildings, id)).toBe(false);
    expectSound(state);
  });

  it("stands when a street off the far side splits the back road under it, and follows its back lot onto the piece", () => {
    const { state, south, id } = withMall();
    const before = buildingInfo(state, id)?.corners;
    // A street south from the south street, outside the block, splits it at x 4300.
    ok(state, road([4300, south], [4300, south + 100]));
    expect(isBuilding(state.buildings, id)).toBe(true);
    const after = buildingInfo(state, id)?.corners as number[];
    (before as number[]).forEach((v, i) => expect(after[i]).toBeCloseTo(v, 6));
    expectSound(state);
  });

  it("stands when the back road is upgraded to a narrower type and then reversed, its back lot following both", () => {
    const { state, south, id } = withMall();
    const seg = () => cellAt(state, 4300, south - HALF - 6)?.segment as number;
    const b = state.buildings;
    const before = { side: b.backSide[id], dir: b.backDir[id] };
    // A one-way is 8 m wide, so the south strip moves a metre south with
    // its road's edge and the strips no longer quite meet. The building
    // keeps its ground.
    ok(state, command("UpgradeRoad", withEnds(state.roads, { segments: [seg()], type: "oneWay" })));
    expect(isBuilding(b, id)).toBe(true);
    // Making it one-way again reverses it: its cells change side and the
    // back lot's row follows.
    ok(state, command("UpgradeRoad", withEnds(state.roads, { segments: [seg()], type: "oneWay" })));
    expect(isBuilding(b, id)).toBe(true);
    expect({ side: b.backSide[id], dir: b.backDir[id] }).not.toEqual(before);
    const zs = (buildingInfo(state, id)?.corners as number[]).filter((_, i) => i % 2 === 1);
    expect(Math.max(...zs)).toBeCloseTo(south - 4, 6);
    expectSound(state);
  });

  it("goes when a road is built across the block through it", () => {
    const { state, south, id } = withMall();
    const corners = buildingInfo(state, id)?.corners as number[];
    const x = Math.round(((corners[0] as number) + (corners[6] as number)) / 2);
    ok(state, road([x, NORTH], [x, south]));
    expect(isBuilding(state.buildings, id)).toBe(false);
    expectSound(state);
  });

  it("can be cleared with BulldozeBuilding, by its first cell", () => {
    const { state, id } = withMall();
    const b = state.buildings;
    ok(state, command("BulldozeBuilding", { buildings: [{ id, segment: b.firstSeg[id], side: b.firstSide[id], place: b.firstPlace[id], builtAt: b.builtAt[id] }] }));
    expect(isBuilding(state.buildings, id)).toBe(false);
    expectSound(state);
  });
});

describe("the grid tool's default block", () => {
  it("is two strips deep, and takes a through-lot with no gap between them", () => {
    const state = createState(SEED);
    // Two blocks of the default size, 12 cells deep and 24 wide between road edges.
    const depth = 2 * DEPTH * CELL;
    const width = 24 * CELL;
    const x0 = 4150;
    const z0 = 4500;
    ok(
      state,
      command("BuildRoadGrid", {
        origin: { x: x0, z: z0 },
        along: { x: x0 + width + 2 * HALF, z: z0 },
        across: { x: x0, z: z0 + 2 * (depth + 2 * HALF) },
        depth,
        width,
        type: "street",
      }),
    );
    while (!cellsSettled(state)) step(state);
    const front = z0 + HALF;
    const rect = { from: { x: x0 + 2 * HALF, z: front + depth / 2 }, to: { x: x0 + width, z: front + depth / 2 }, width: depth - 4 };
    ok(state, command("ZoneCells", { zone: "commercial", density: 3, rects: [rect] }));
    const cell = cellAt(state, x0 + HALF + width / 2, front + CELL / 2);
    if (!cell) throw new Error("no cell");
    const result = findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.lot.depth).toBe(2 * DEPTH);
    expect(result.lot.backDepth).toBe(DEPTH);
    // No gap: the two strips' backs are the same line, to within the 1 cm shapes go by.
    const id = build(state, result.lot);
    const corners = buildingInfo(state, id)?.corners as number[];
    const zs = [corners[1], corners[3], corners[5], corners[7]] as number[];
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(depth, 1);
    expectSound(state);
  });
});

describe("rows and balance", () => {
  it("refuses a building whose back fields do not fit its type", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    const result = findLot(state, northCell(state, 4300));
    if (!result.ok) throw new Error(result.reason);
    // A through-lot type with no back lot, and a shop with one.
    expect(() => build(state, { ...result.lot, backDepth: 0, backSeg: 0, backSide: 0, backPlace: 0, backDir: 0, depth: 6 })).toThrow();
    const id = build(state, result.lot);
    const b = state.buildings;
    const saved = b.backDepth[id] as number;
    b.backDepth[id] = 0;
    expect(checkBuildings(b, state.roads, state.tick)).toMatch(/through-lot/);
    b.backDepth[id] = saved;
    b.backSeg[id] = 9999;
    expect(checkBuildings(b, state.roads, state.tick)).toMatch(/back lot/);
  });

  it("keeps through-lot types deeper than a strip and the rest no deeper", () => {
    const deep = { ...buildingsJson, types: [...buildingsJson.types, { id: "deep", name: "Deep", zone: "office", density: 3, width: [1, 1], depth: [7, 7], residents: [0, 0] }] };
    expect(() => resolveBuildingsBalance(deep)).toThrow(/zoning depth/);
    const shallow = { ...buildingsJson, types: [...buildingsJson.types, { id: "shallow", name: "Shallow", zone: "office", density: 3, width: [1, 1], depth: [6, 6], residents: [0, 0], throughLot: true }] };
    expect(() => resolveBuildingsBalance(shallow)).toThrow(/more than the zoning depth/);
    const wide = { ...buildingsJson, types: [...buildingsJson.types, { id: "wide", name: "Wide", zone: "office", density: 3, width: [13, 13], depth: [8, 8], residents: [0, 0], throughLot: true }] };
    expect(() => resolveBuildingsBalance(wide)).toThrow(/maxThroughLotWidth/);
  });

  it("has through-lot types for C3 and I3 only, as proposals, up to 12 by 12", () => {
    const through = BUILDING_TYPES.filter((t) => t.throughLot);
    expect(new Set(through.map((t) => `${t.zone} ${t.density}`))).toEqual(new Set(["commercial 3", "industrial 3"]));
    for (const t of through) {
      expect(t.proposal).toBe(true);
      expect(t.width[1]).toBeLessThanOrEqual(12);
      expect(t.depth[1]).toBe(2 * DEPTH);
      expect(t.depth[0]).toBe(DEPTH + 1);
    }
  });
});

describe("a client's copy", () => {
  holdEach();
  it("files a through-lot on both strips from its row, and draws it with the same corners", () => {
    const state = createState(SEED);
    const south = block(state, 12 * CELL);
    zoneBlock(state, south, "commercial");
    const copy = deserialize(serialize(state)).state;
    prepareDerived(copy);
    recordRoadChanges(state.roads);
    recordCellChanges(state);
    recordBuildingChanges(state);
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
    grow(state, 2);
    sync();
    const [id] = throughIds(state);
    expect(id).toBeDefined();
    expect(buildingInfo(copy, id as number)).toEqual(buildingInfo(state, id as number));
    expect(Array.from(buildingIndexSets(copy).kept.cells)).toEqual(Array.from(buildingIndexSets(state).kept.cells));
    // The back road goes, and the copy follows.
    ok(state, command("BulldozeRoad", withEnds(state.roads, { segments: [cellAt(state, 4300, south - HALF - 4)?.segment as number] })));
    sync();
    expect(throughIds(copy)).toEqual([]);
    expect(Array.from(buildingIndexSets(copy).kept.cells)).toEqual(Array.from(buildingIndexSets(state).kept.cells));
  });
});

/**
 * The commands behind fixtures/replay/through-lots.json, stepped live. On
 * seed 2026: p1 builds a block between two streets twelve cells apart,
 * closed at both ends, and zones both strips C3. Growth puts a through-lot
 * across the block. On day 2 p2 runs a street south off the south street,
 * outside the block, which splits it under the back lots. p2 bulldozes the
 * piece of the south street under x 4300 on day 4, which takes the
 * through-lot on it, and undoes that on day 6, which brings the road back
 * with its zoning but not its buildings. Ten game days.
 */
function playSession(): SimState {
  const state = createState(SEED);
  let n = 0;
  const send = (type: string, payload: unknown, playerId = "p1") => {
    expect(submit(state, { seq: ++n, playerId, type, payload }), `${type} ${JSON.stringify(payload)}`).toEqual({ ok: true });
  };
  const until = (tick: number) => {
    while (state.tick < tick) step(state);
  };
  const south = NORTH + 2 * HALF + 12 * CELL;
  const street = (from: [number, number], to: [number, number]) => ({ from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" });
  send("BuildRoad", street([WEST, NORTH], [EAST, NORTH]));
  until(1);
  send("BuildRoad", street([WEST, south], [EAST, south]));
  until(2);
  send("BuildRoad", street([WEST, NORTH], [WEST, south]));
  send("BuildRoad", street([EAST, NORTH], [EAST, south]));
  until(3);
  const mid = (NORTH + south) / 2;
  send("ZoneCells", { zone: "commercial", density: 3, rects: [{ from: { x: WEST + 2 * HALF + 2, z: mid }, to: { x: EAST - 2 * HALF - 2, z: mid }, width: 12 * CELL - 4 }] });
  until(2 * DAY);
  send("BuildRoad", street([4300, south], [4300, south + 100]), "p2");
  until(4 * DAY);
  send("BulldozeRoad", withEnds(state.roads, { segments: [cellAt(state, 4300, south - HALF - 4)?.segment as number] }), "p2");
  until(6 * DAY);
  send("Undo", {}, "p2");
  until(10 * DAY);
  return state;
}

const fixture = fixtureJson as ReplayFixture;
/** The bars as the fixture holds them (M3-07): a city with no residents wants no shops. */
const HELD = FULL_DEMAND;

describe("replay fixture through-lots", () => {
  it("is recorded with every bar held at 100", () => {
    expect(fixture.heldDemand).toBe(100);
  });

  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    holdDemand(HELD, () => expectSound(state));
  });

  it("matches the same commands stepped live", () => {
    const state = holdDemand(HELD, playSession);
    expect(state.log).toEqual(fixture.log);
    expect(hashState(state)).toBe(fixture.hash);
  });

  it("builds a through-lot, loses it with its back road, and grows again after the undo", () => {
    const at = (tick: number) => replayFixture(fixture, tick);
    const grown = at(2 * DAY);
    expect(throughIds(grown).length).toBeGreaterThan(0);
    // The split outside the block leaves them standing.
    const split = at(2 * DAY + 1);
    expect(throughIds(split)).toEqual(throughIds(grown));
    // The bulldoze takes the one on the piece it removed.
    const beforeBulldoze = at(4 * DAY);
    const bulldozed = at(4 * DAY + 1);
    expect(throughIds(bulldozed).length).toBeLessThan(throughIds(beforeBulldoze).length);
    // The undo brings the road back with its zoning but not its buildings
    // (issue 111), and the block grows again.
    const undone = at(6 * DAY + 1);
    expect(undone.cells.zone.filter((z) => z !== 0).length).toBe(beforeBulldoze.cells.zone.filter((z) => z !== 0).length);
    expect(live(undone).length).toBeLessThanOrEqual(live(at(6 * DAY)).length);
    const end = at(fixture.untilTick);
    expect(live(end).length).toBeGreaterThan(live(undone).length);
    expect(live(end).filter((id) => (end.buildings.backDepth[id] ?? 0) === 0).length).toBeGreaterThan(0);
  });

  it("builds nothing without the bars held: an empty city wants no shops", () => {
    const state = replay(fixture.seed, fixture.log, fixture.untilTick);
    expect(live(state)).toEqual([]);
  });

  /** Replays the fixture with its bars held, saving and loading the city at `at` and stepping on from the copy. */
  function replaySavedAt(at: number): SimState {
    let state = createState(fixture.seed);
    let next = 0;
    holdDemand(HELD, () => {
      while (state.tick < fixture.untilTick) {
        if (state.tick === at && state.log.length === next) {
          state = deserialize(serialize(state)).state;
          at = -1;
        }
        for (let e = fixture.log[next]; e && e.tick <= state.tick; e = fixture.log[++next]) enqueue(state, e);
        step(state);
      }
    });
    return state;
  }

  it.each([150, 201, 401, 650, 777])("hashes the same saved and loaded at tick %d", (at) => {
    expect(hashState(replaySavedAt(at))).toBe(fixture.hash);
  });
});

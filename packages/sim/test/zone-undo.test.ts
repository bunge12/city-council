import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  DENSITY_NONE,
  TIME_BALANCE,
  UNDO_STEPS,
  ROAD_TYPES,
  ZONE_NONE,
  ZONING_BALANCE,
  cellAt,
  createGrowth,
  createState,
  deserialize,
  findLot,
  hashState,
  isBuilding,
  planUndo,
  serialize,
  step,
  type Command,
  type CommandResult,
  type Lot,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { addBuilding, checkBuildings } from "../src/buildings/buildings";
import { candidateSets } from "../src/buildings/candidates";
import { segmentBuildings } from "../src/buildings/where";
import { checkRoadNetwork, isSegment, segmentIdLimit } from "../src/roads/network";
import { checkUndoHistory, heldIds } from "../src/undo";
import { syncCells } from "../src/zoning/cell-index";
import { ZONE_UNTOUCHED, anchorHash, journalCells, journalLostZones, readJournals } from "../src/zoning/zone-undo";
import { Fnv64 } from "../src/hash";

// Issue 111: undo for zoning, and for roads that carried buildings.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const DAY = TIME_BALANCE.ticksPerDay;
const zoneNumber = (id: string) => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;
const R = zoneNumber("residential");
const C = zoneNumber("commercial");

const seqs = new Map<string, number>();
function command(type: string, payload: unknown, playerId = "p1"): Command {
  const seq = (seqs.get(playerId) ?? 0) + 1;
  seqs.set(playerId, seq);
  return { seq, playerId, type, payload };
}
const road = (from: [number, number], to: [number, number], type = "street", playerId = "p1") =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type }, playerId);
const undo = (playerId = "p1") => command("Undo", {}, playerId);

function run(state: SimState, c: Command): CommandResult {
  const result = submit(state, c);
  step(state);
  // An undo that puts roads back waits for the cells to settle (M2 review, #147).
  while (state.pending.length > 0) step(state);
  return result;
}

function ok(state: SimState, c: Command): void {
  expect(run(state, c), c.type).toEqual({ ok: true });
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function refusal(state: SimState, c: Command): string {
  const before = hashState({ ...state, tick: 0 });
  const result = submit(state, c);
  expect(result.ok, "the command should be refused").toBe(false);
  expect(hashState({ ...state, tick: 0 })).toBe(before);
  return result.ok ? "" : result.reason;
}

/** A street running east from (4200, 4600) for 24 cells, its north strip from z 4595 back, its south strip from z 4605 on. */
function street(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4600], [4392, 4600]));
  return state;
}

/** A ZoneCells `d` cells deep along the street from place `p0` for `w` places, on the north side, the south side or both. */
function paint(zoneId: string, density: number | undefined, p0: number, w: number, d: number, sides: "north" | "south" | "both" = "north", playerId = "p1"): Command {
  const x0 = 4200 + CELL * p0 + 2;
  const x1 = 4200 + CELL * (p0 + w) - 2;
  const rect = (edge: number, sign: number) => {
    const z = edge + (sign * CELL * d) / 2;
    return { from: { x: x0, z }, to: { x: x1, z }, width: CELL * d - 4 };
  };
  const rects = [];
  if (sides !== "south") rects.push(rect(4595, -1));
  if (sides !== "north") rects.push(rect(4605, 1));
  return command("ZoneCells", density === undefined ? { zone: zoneId, rects } : { zone: zoneId, density, rects }, playerId);
}

/** The zone and density of every cell, as "zone/density" by slot. */
function zones(state: SimState): string[] {
  syncCells(state);
  return Array.from(state.cells.zone, (z, slot) => `${z}/${state.cells.density[slot]}`);
}

/** How many cells hold a zone. */
function zonedCount(state: SimState): number {
  return state.cells.zone.reduce((n, z) => n + (z === ZONE_NONE ? 0 : 1), 0);
}

/** The state hash leaving out the log, the undo history, the tick and what goes with it. */
function cityHash(state: SimState): string {
  return hashState({ ...state, tick: 0, log: [], logOffset: 0, undo: [], cellsReadyAt: 0, growth: createGrowth() });
}

function liveBuildings(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id)) out.push(id);
  return out;
}

function build(state: SimState, lot: Lot): number {
  const type = BUILDING_TYPES[lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...lot, residents: type.residents[1], variant: 0 });
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

function liveSegments(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(state.roads); id++) if (isSegment(state.roads, id)) out.push(id);
  return out;
}

/** Roads, held ids, buildings and candidates all agree, and a save loads to the same city. */
function expectSound(state: SimState): void {
  expect(checkRoadNetwork(state.roads, heldIds(state.undo))).toBeNull();
  expect(checkUndoHistory(state.undo)).toBeNull();
  expect(checkBuildings(state.buildings, state.roads, state.tick)).toBeNull();
  const candidates = candidateSets(state, syncCells(state), () => segmentBuildings(state));
  expect(candidates.kept).toEqual(candidates.fresh);
  expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
}

describe("anchorHash", () => {
  // Undo records in saves hold these hashes, so the bytes must not change
  // (issue #204 took them from a buffer instead of a float at a time).
  it("hashes the eight numbers as Fnv64.f64 feeds them, a float at a time", () => {
    const slow = (a: number[]): number => {
      const h = new Fnv64();
      for (const v of a) h.f64(v);
      return h.lo | 0;
    };
    const anchors = [
      [0, 0, 0, 0, 0, 0, 0, 1],
      [4100.5, 4400.25, 4300, 4500, 4700, 5000, 0.125, 0.875],
      [-0, 1e-300, -1e300, 3.141592653589793, -2.5, 7, 0.3333333333333333, 1],
    ];
    for (const a of anchors) {
      const [ax = 0, az = 0, cx = 0, cz = 0, bx = 0, bz = 0, tA = 0, tB = 0] = a;
      expect(anchorHash({ ax, az, cx, cz, bx, bz, tA, tB })).toBe(slow(a));
    }
  });
});

describe("Undo of ZoneCells", () => {
  it("unzones the cells a paint zoned, leaving the city as before the paint", () => {
    const state = street();
    const before = cityHash(state);
    ok(state, paint("residential", 1, 0, 24, 4));
    expect(zonedCount(state)).toBe(24 * 4);
    const record = state.undo.at(-1);
    expect(record?.type).toBe("ZoneCells");
    expect(record?.ops).toEqual([]);
    expect(record?.painted).toEqual({ zone: R, density: 1 });
    ok(state, undo());
    expect(zonedCount(state)).toBe(0);
    expect(cityHash(state)).toBe(before);
    // The undo took the paint, not the street before it.
    expect(liveSegments(state).length).toBeGreaterThan(0);
    expect(state.undo.map((r) => r.type)).toEqual(["BuildRoad"]);
    expectSound(state);
  });

  it("puts back what a repaint painted over, cell by cell", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4));
    const zonedOnce = zones(state);
    ok(state, paint("commercial", 2, 8, 8, 6));
    expect(zones(state)).not.toEqual(zonedOnce);
    expect(state.cells.zone.includes(C)).toBe(true);
    ok(state, undo());
    expect(zones(state)).toEqual(zonedOnce);
    ok(state, undo());
    expect(zonedCount(state)).toBe(0);
    expectSound(state);
  });

  it("puts back the zones a clear took away", () => {
    const state = street();
    ok(state, paint("residential", 2, 0, 24, 3, "both"));
    ok(state, paint("office", 1, 4, 4, 6, "south"));
    const before = zones(state);
    ok(state, paint("none", undefined, 2, 18, 6, "both"));
    expect(zonedCount(state)).toBeLessThan(24 * 6);
    ok(state, undo());
    expect(zones(state)).toEqual(before);
    expectSound(state);
  });

  it("keeps the record small: a strip painted along a street is a few runs, not one per place", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 6));
    const zones = state.undo.at(-1)?.zones ?? new Int32Array(0);
    const journals = readJournals(zones);
    expect(journals.length).toBe(1);
    const [journal] = journals;
    if (!journal) throw new Error("no journal");
    expect(journalCells(zones, journal)).toBe(24 * 12);
    // Six depths on the north side painted from unzoned, then the south side untouched.
    expect(Array.from(zones.subarray(journal.from, journal.to))).toEqual([24 * 6, ZONE_NONE, DENSITY_NONE, 24 * 6, ZONE_UNTOUCHED, 0]);
    expect(zones.length).toBe(3 + 6);
  });

  it("leaves the houses standing, by the rezoning rule, and the grower builds no more there", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 6, "both"));
    const until = state.tick + 10 * DAY;
    while (state.tick < until) step(state);
    const houses = liveBuildings(state);
    expect(houses.length).toBeGreaterThan(3);
    ok(state, undo());
    expect(zonedCount(state)).toBe(0);
    expect(liveBuildings(state)).toEqual(houses);
    const later = state.tick + 10 * DAY;
    while (state.tick < later) step(state);
    expect(liveBuildings(state)).toEqual(houses);
    expectSound(state);
  });

  it("takes back each player's own paint only", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 12, 4, "north", "p1"));
    ok(state, paint("commercial", 1, 12, 12, 4, "north", "p2"));
    ok(state, undo("p1"));
    expect(state.cells.zone.includes(R)).toBe(false);
    expect(state.cells.zone.includes(C)).toBe(true);
  });

  it("is refused, and stays on top, when someone has rezoned the cells since", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "north", "p1"));
    ok(state, paint("commercial", 1, 10, 2, 2, "north", "p2"));
    expect(refusal(state, undo("p1"))).toBe("Cannot undo: someone has rezoned those cells since");
    expect(state.undo.filter((r) => r.playerId === "p1").map((r) => r.type)).toEqual(["BuildRoad", "ZoneCells"]);
    // Once the other player takes theirs back, it goes.
    ok(state, undo("p2"));
    ok(state, undo("p1"));
    expect(zonedCount(state)).toBe(0);
  });

  it("is refused when someone has cut or removed the road the cells are on", () => {
    const cut = street();
    ok(cut, paint("residential", 1, 0, 24, 4, "north", "p1"));
    ok(cut, road([4300, 4500], [4300, 4700], "street", "p2"));
    expect(refusal(cut, undo("p1"))).toBe("Cannot undo: someone has changed or removed a road those cells are on");
    // The cut kept the zones on their ground, and undoing it makes the paint undoable again.
    ok(cut, undo("p2"));
    ok(cut, undo("p1"));
    expect(zonedCount(cut)).toBe(0);
    expectSound(cut);

    const gone = street();
    ok(gone, paint("residential", 1, 0, 24, 4, "north", "p1"));
    ok(gone, command("BulldozeRoad", { segments: liveSegments(gone).filter((s) => gone.roads.segType[s] === 0) }, "p2"));
    expect(refusal(gone, undo("p1"))).toBe("Cannot undo: someone has changed or removed a road those cells are on");
  });

  it("undoes after the player's own road changes are undone first", () => {
    const state = street();
    const before = cityHash(state);
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    ok(state, road([4300, 4500], [4300, 4700]));
    ok(state, command("UpgradeRoad", { segments: liveSegments(state).filter((s) => state.roads.segType[s] === 0), type: "avenue" }));
    ok(state, undo());
    ok(state, undo());
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
    expectSound(state);
  });

  it("behaves the same across a save and load between the paint and its undo", () => {
    const straight = street();
    ok(straight, paint("residential", 1, 0, 24, 4));
    ok(straight, paint("commercial", 2, 6, 6, 6));
    const loaded = deserialize(serialize(straight)).state;
    expect(hashState(loaded)).toBe(hashState(straight));
    const undos = [undo(), undo()];
    for (const state of [straight, loaded]) for (const c of undos) ok(state, c);
    expect(hashState(loaded)).toBe(hashState(straight));
    expect(zonedCount(loaded)).toBe(0);
  });

  it("counts towards the player's undo steps with their road changes", () => {
    const state = street();
    for (let i = 0; i < UNDO_STEPS + 2; i++) ok(state, paint(i % 2 === 0 ? "residential" : "commercial", 1, 0, 24, 2));
    expect(state.undo.length).toBe(UNDO_STEPS);
    expect(state.undo.every((r) => r.type === "ZoneCells")).toBe(true);
  });
});

describe("Undo of a road change over zoned cells", () => {
  it("brings a bulldozed street back with its zoning and no buildings", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    ok(state, paint("commercial", 2, 10, 6, 6, "south"));
    const ids = fill(state);
    expect(ids.length).toBeGreaterThan(5);
    const zoned = zones(state);
    const streetSegs = liveSegments(state).filter((s) => state.roads.segType[s] === 0);
    ok(state, command("BulldozeRoad", { segments: streetSegs }));
    expect(liveBuildings(state)).toEqual([]);
    expect(readJournals(state.undo.at(-1)?.zones ?? new Int32Array(0)).length).toBe(streetSegs.length);
    ok(state, undo());
    expect(liveSegments(state).filter((s) => state.roads.segType[s] === 0)).toEqual(streetSegs);
    expect(zones(state)).toEqual(zoned);
    expect(liveBuildings(state)).toEqual([]);
    expectSound(state);
    // And the grower builds again.
    const until = state.tick + 10 * DAY;
    while (state.tick < until) step(state);
    expect(liveBuildings(state).length).toBeGreaterThan(3);
  });

  it("brings back the zoning of one piece of a cut road, bulldozed", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    ok(state, road([4300, 4500], [4300, 4700]));
    const zoned = zones(state);
    const pieces = liveSegments(state).filter((s) => state.roads.segType[s] === 0 && state.roads.nodeZ[state.roads.segA[s] ?? 0] === 4600);
    const west = pieces.find((s) => Math.min(state.roads.nodeX[state.roads.segA[s] ?? 0] ?? 0, state.roads.nodeX[state.roads.segB[s] ?? 0] ?? 0) === 4200);
    if (west === undefined) throw new Error("no west piece");
    ok(state, command("BulldozeRoad", { segments: [west] }));
    ok(state, undo());
    expect(zones(state)).toEqual(zoned);
    expectSound(state);
  });

  it("turns an avenue back into a street with every zone where it was", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    ok(state, paint("office", 2, 8, 4, 6, "south"));
    const zoned = zones(state);
    const segs = liveSegments(state).filter((s) => state.roads.segType[s] === 0);
    ok(state, command("UpgradeRoad", { segments: segs, type: "avenue" }));
    // The wider road moves the cells out, and they keep their zones.
    expect(zonedCount(state)).toBe(zoned.filter((z) => z !== "0/0").length);
    expect(state.undo.at(-1)?.zones.length).toBe(0);
    ok(state, undo());
    expect(zones(state)).toEqual(zoned);
    expectSound(state);
  });

  it("journals the zoning of a street upgraded to a type with no cells", () => {
    // No such upgrade can be built yet (highways wait for M5), so the journal is checked on its own.
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    const [seg] = liveSegments(state).filter((s) => state.roads.segType[s] === 0);
    if (seg === undefined) throw new Error("no street");
    const highway = ROAD_TYPES.findIndex((t) => !t.zonable);
    const restyle = { op: "restyle" as const, id: seg, from: 0, to: highway, reverse: false, a: state.roads.segA[seg] ?? 0, b: state.roads.segB[seg] ?? 0 };
    const zones = journalLostZones(state.roads, state.cells, [restyle]);
    const [journal] = readJournals(zones);
    expect(journal?.seg).toBe(seg);
    expect(journal && journalCells(zones, journal)).toBe(24 * 12);
    // An upgrade to another zonable type keeps its cells, so needs no journal.
    expect(journalLostZones(state.roads, state.cells, [{ ...restyle, to: 1 }]).length).toBe(0);
  });

  it("removes a road built across zoned cells and brings back the zoning it blocked", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 6, "both"));
    const houses = fill(state);
    const segs = liveSegments(state);
    const zoned = zones(state);
    ok(state, road([4300, 4500], [4300, 4700]));
    // The new road took the houses on its ground.
    expect(liveBuildings(state).length).toBeLessThan(houses.length);
    ok(state, undo());
    expect(liveSegments(state)).toEqual(segs);
    expect(zones(state)).toEqual(zoned);
    expectSound(state);
  });

  it("removes a grid laid over zoned streets and brings back their zoning", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 6, "both"));
    ok(state, paint("industrial", 3, 6, 6, 6, "south"));
    const zoned = zones(state);
    const grid = {
      origin: { x: 4250, z: 4500 },
      along: { x: 4442, z: 4500 },
      across: { x: 4250, z: 4692 },
      depth: 86,
      width: 86,
      type: "street",
    };
    ok(state, command("BuildRoadGrid", grid));
    ok(state, undo());
    expect(zones(state)).toEqual(zoned);
    expectSound(state);
  });

  it("is refused for a bulldoze, and stays on top, when a road built since is in the way", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4, "both"));
    const segs = liveSegments(state).filter((s) => state.roads.segType[s] === 0);
    ok(state, command("BulldozeRoad", { segments: segs }, "p1"));
    ok(state, road([4300, 4500], [4300, 4700], "street", "p2"));
    expect(planUndo(state, "p1").ok).toBe(false);
    expect(refusal(state, undo("p1"))).toBe("Cannot undo: a road built since is in the way");
    expect(state.undo.filter((r) => r.playerId === "p1").at(-1)?.type).toBe("BulldozeRoad");
    ok(state, undo("p2"));
    ok(state, undo("p1"));
    expect(zonedCount(state)).toBe(24 * 8);
  });

  it("behaves the same across a save and load between a bulldoze and its undo", () => {
    const straight = street();
    ok(straight, paint("residential", 1, 0, 24, 4, "both"));
    ok(straight, command("BulldozeRoad", { segments: liveSegments(straight).filter((s) => straight.roads.segType[s] === 0) }));
    const loaded = deserialize(serialize(straight)).state;
    const back = undo();
    for (const state of [straight, loaded]) ok(state, back);
    expect(hashState(loaded)).toBe(hashState(straight));
    expect(zonedCount(loaded)).toBe(24 * 8);
  });
});

describe("BulldozeBuilding", () => {
  it("leaves no undo record", () => {
    const state = street();
    ok(state, paint("residential", 1, 0, 24, 4));
    const [id] = fill(state);
    if (id === undefined) throw new Error("nothing built");
    const row = state.buildings;
    const before = state.undo;
    ok(state, command("BulldozeBuilding", { buildings: [{ id, segment: row.firstSeg[id], side: row.firstSide[id], place: row.firstPlace[id], builtAt: row.builtAt[id] }] }));
    expect(state.undo).toBe(before);
  });
});

describe("undo of a stroke split over several commands (M2 review, #147)", () => {
  /** `c` with `stroke` in its payload. */
  const part = (c: Command, stroke: number): Command => ({ ...c, payload: { ...(c.payload as object), stroke } });

  it("takes back every part of the stroke with one undo, and leaves the stroke before it", () => {
    const state = street();
    const before = zones(state);
    ok(state, paint("commercial", 1, 0, 24, 2));
    const afterFirst = zones(state);
    // Three parts of one residential stroke, and p2's command between two of them.
    ok(state, part(paint("residential", 1, 0, 8, 4, "south"), 70));
    ok(state, paint("industrial", 2, 0, 4, 6, "north", "p2"));
    ok(state, part(paint("residential", 1, 8, 8, 4, "south"), 70));
    ok(state, part(paint("residential", 1, 16, 8, 4, "south"), 70));
    expect(state.undo.filter((r) => r.stroke === 70)).toHaveLength(3);
    ok(state, undo());
    // The whole stroke went at once; p2's paint stays.
    expect(state.undo.filter((r) => r.stroke === 70)).toHaveLength(0);
    const twin = street();
    ok(twin, paint("commercial", 1, 0, 24, 2));
    ok(twin, paint("industrial", 2, 0, 4, 6, "north", "p2"));
    expect(zones(state)).toEqual(zones(twin));
    ok(state, undo("p2"));
    expect(zones(state)).toEqual(afterFirst);
    ok(state, undo());
    expect(zones(state)).toEqual(before);
  });

  it("refuses the whole stroke when one part of it can no longer be undone", () => {
    const state = street();
    ok(state, part(paint("residential", 1, 0, 12, 4), 9));
    ok(state, part(paint("residential", 1, 12, 12, 4), 9));
    // p2 rezones a corner of the first part.
    ok(state, paint("office", 1, 0, 2, 2, "north", "p2"));
    const held = zones(state);
    expect(refusal(state, undo())).toMatch(/rezoned/);
    expect(zones(state)).toEqual(held);
    expect(state.undo.filter((r) => r.stroke === 9)).toHaveLength(2);
  });

  it("keeps strokes with another id, or another zone, as steps of their own", () => {
    const state = street();
    ok(state, part(paint("residential", 1, 0, 12, 4), 5));
    ok(state, part(paint("residential", 1, 12, 12, 4), 6));
    ok(state, part(paint("commercial", 1, 0, 12, 4, "south"), 6));
    const strokes = () => state.undo.filter((r) => r.type === "ZoneCells").map((r) => r.stroke);
    ok(state, undo());
    expect(strokes()).toEqual([5, 6]);
    ok(state, undo());
    expect(strokes()).toEqual([5]);
  });

  it("counts a split stroke as one of the player's undo steps", () => {
    const state = street();
    // The street is a step of its own, so these fill the history but for one step.
    for (let i = 0; i < UNDO_STEPS - 2; i++) ok(state, paint(["residential", "commercial", "office"][Math.floor(i / 24)] ?? "mixed", 1, i % 24, 1, 1));
    ok(state, part(paint("office", 1, 0, 12, 3, "south"), 77));
    ok(state, part(paint("office", 1, 12, 12, 3, "south"), 77));
    // UNDO_STEPS steps in UNDO_STEPS + 1 records, all kept.
    expect(state.undo.filter((r) => r.playerId === "p1")).toHaveLength(UNDO_STEPS + 1);
    expect(state.undo[0]?.type).toBe("BuildRoad");
    // One more step pushes out the oldest step only, the street.
    ok(state, paint("mixed", 1, 0, 4, 6, "south"));
    expect(state.undo.filter((r) => r.playerId === "p1")).toHaveLength(UNDO_STEPS + 1);
    expect(state.undo[0]?.type).toBe("ZoneCells");
    expect(state.undo.filter((r) => r.stroke === 77)).toHaveLength(2);
  });

  it("refuses a stroke id that is not a whole number, 0 or more", () => {
    const state = street();
    for (const stroke of [-1, 0.5, "a"]) expect(refusal(state, part(paint("residential", 1, 0, 4, 2), stroke as number))).toMatch(/stroke/);
  });

  it("keeps the stroke id through a save, so the stroke still undoes whole", () => {
    let state = street();
    ok(state, part(paint("residential", 1, 0, 12, 4), 3));
    ok(state, part(paint("residential", 1, 12, 12, 4), 3));
    state = deserialize(serialize(state)).state;
    expect(checkUndoHistory(state.undo)).toBeNull();
    ok(state, undo());
    expect(zonedCount(state)).toBe(0);
  });
});

describe("undo of a stroke whose parts share a cell (M2 review, #147)", () => {
  it("is refused whole when another player's command between two parts made both paint one cell", () => {
    const state = street();
    const part = (c: Command, stroke: number): Command => ({ ...c, payload: { ...(c.payload as object), stroke } });
    ok(state, part(paint("residential", 1, 0, 8, 4), 12));
    // p2 clears a corner of the first part; the second part paints over it again.
    ok(state, paint("none", undefined, 0, 2, 2, "north", "p2"));
    ok(state, part(paint("residential", 1, 0, 16, 4), 12));
    const held = zones(state);
    expect(refusal(state, undo())).toMatch(/rezoned/);
    expect(zones(state)).toEqual(held);
  });
});

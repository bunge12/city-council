import { describe, expect, it } from "vitest";
import {
  CELL_BEND,
  CELL_LEFT,
  CELL_OPEN,
  CELL_RIGHT,
  CELL_ROAD,
  CELL_STEEP,
  CELL_TAKEN,
  CELL_WATER,
  CHUNKS_PER_SIDE,
  ZONING_BALANCE,
  cellAt,
  cellCorners,
  cellSlot,
  cellStatuses,
  cellsInBox,
  cellsInChunk,
  createState,
  deserialize,
  hashState,
  placesAlong,
  serialize,
  step,
  submit,
  syncCells,
  type Command,
  type SimState,
} from "../src/index";
import { cloneState } from "../src/state";
import { isSegment, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { checkCells, fromLocal, unzonedCells } from "../src/zoning/cells";
import { quadsOverlap } from "../src/zoning/shape";
import { churnNetwork, growNetwork } from "./road-network-helper";

// M2-03: zoning cells along roads.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts). A street from (3620, 7220) east has water on its
// north side, and one from (8360, 5400) east has steep ground to its south.
const SEED = 2026;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const SIZE = ZONING_BALANCE.cellSize;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
const road = (from: [number, number], to: [number, number], extra: Record<string, unknown> = {}, playerId = "p1") =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street", ...extra }, playerId);
const curve = (from: [number, number], to: [number, number], control: [number, number]) =>
  road(from, to, { control: { x: control[0], z: control[1] } });
const bulldoze = (segments: number[], playerId = "p1") => command("BulldozeRoad", { segments }, playerId);
const upgrade = (type: string, segments: number[]) => command("UpgradeRoad", { segments, type });
const undo = (playerId = "p1") => command("Undo", {}, playerId);

function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function live(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

/** The live segment with both ends at these points, either way round. */
function between(net: RoadNetwork, p: [number, number], q: [number, number]): number {
  const at = (node: number, [x, z]: [number, number]) => net.nodeX[node] === x && net.nodeZ[node] === z;
  const seg = live(net).find((s) => {
    const a = net.segA[s] ?? -1;
    const b = net.segB[s] ?? -1;
    return (at(a, p) && at(b, q)) || (at(a, q) && at(b, p));
  });
  if (seg === undefined) throw new Error(`no segment from ${p.join(",")} to ${q.join(",")}`);
  return seg;
}

/** Every cell of `seg`: name, status and slot in the zone arrays. */
function cellsOf(state: SimState, seg: number) {
  const statuses = cellStatuses(state);
  const start = state.cells.offset[seg] ?? 0;
  const count = (state.cells.offset[seg + 1] ?? 0) - start;
  return Array.from({ length: count }, (_, local) => ({ ...fromLocal(local), segment: seg, slot: start + local, status: statuses[start + local] }));
}

const statusesOf = (state: SimState, seg: number, side?: number) =>
  cellsOf(state, seg)
    .filter((c) => side === undefined || c.side === side)
    .map((c) => c.status);
const count = (list: (number | undefined)[], status: number) => list.filter((s) => s === status).length;

function centreOf(state: SimState, ref: { segment: number; side: number; place: number; depth: number }): [number, number] {
  const q = cellCorners(state, ref);
  if (!q) throw new Error("no such cell");
  return [((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4, ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4];
}

/** Every pair of open cells that overlap. There should be none. */
function overlappingOpenCells(state: SimState): number {
  const quads: { q: Float64Array; name: string }[] = [];
  for (const seg of live(state.roads)) {
    for (const c of cellsOf(state, seg)) {
      if (c.status !== CELL_OPEN) continue;
      quads.push({ q: Float64Array.from(cellCorners(state, c) ?? []), name: `${seg}/${c.side}/${c.place}/${c.depth}` });
    }
  }
  const pairs: string[] = [];
  for (let i = 0; i < quads.length; i++) {
    for (let j = i + 1; j < quads.length; j++) {
      const p = quads[i] as { q: Float64Array; name: string };
      const q = quads[j] as { q: Float64Array; name: string };
      if (quadsOverlap(p.q, q.q)) pairs.push(`${p.name} ${q.name} ${Array.from(p.q).join(",")} | ${Array.from(q.q).join(",")}`);
    }
  }
  expect(pairs.slice(0, 3)).toEqual([]);
  return pairs.length;
}

/** The cells of `state` walked again from scratch, on a copy whose index has never seen a change. */
function rebuilt(state: SimState): Uint8Array {
  return cellStatuses(cloneState(state));
}

describe("cells along a road", () => {
  it("lines a straight street on both sides, six deep, from its edge", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    const seg = between(state.roads, [4200, 4600], [4392, 4600]);
    expect(placesAlong(state.roads, seg)).toBe(24);
    const cells = cellsOf(state, seg);
    expect(cells).toHaveLength(24 * 2 * DEPTH);
    expect(cells.every((c) => c.status === CELL_OPEN)).toBe(true);
    // Running east, the left is north. A street is 10 m wide.
    expect(cellCorners(state, { segment: seg, side: CELL_LEFT, place: 0, depth: 0 })).toEqual([4200, 4595, 4208, 4595, 4208, 4587, 4200, 4587]);
    expect(cellCorners(state, { segment: seg, side: CELL_RIGHT, place: 23, depth: 5 })).toEqual([4384, 4645, 4392, 4645, 4392, 4653, 4384, 4653]);
    expect(cellCorners(state, { segment: seg, side: CELL_RIGHT, place: 24, depth: 0 })).toBeNull();
    // State holds an unzoned zone and density for each.
    expect(cells.every((c) => state.cells.zone[c.slot] === 0 && state.cells.density[c.slot] === 0)).toBe(true);
    expect(cellSlot(state.roads, state.cells, { segment: seg, side: CELL_RIGHT, place: 1, depth: 2 })).toBe(
      (state.cells.offset[seg] ?? 0) + (1 * 2 + 1) * DEPTH + 2,
    );
  });

  it("ends a dead end at its last whole cell", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4300, 4600]));
    const seg = between(state.roads, [4200, 4600], [4300, 4600]);
    // 100 m is twelve whole cells and 4 m over.
    expect(placesAlong(state.roads, seg)).toBe(12);
    expect(statusesOf(state, seg).every((s) => s === CELL_OPEN)).toBe(true);
    expect(cellCorners(state, { segment: seg, side: CELL_LEFT, place: 11, depth: 0 })?.[2]).toBe(4296);
  });

  it("follows a curve either way, and on the inside of a tight bend keeps the cell nearer the start", () => {
    const bends: [[number, number], number][] = [
      [[4300, 4600], CELL_RIGHT],
      [[4300, 4800], CELL_LEFT],
    ];
    for (const [control, inside] of bends) {
      const state = createState(SEED);
      // Radius 25 m at the apex, tighter than the 53 m the cells reach.
      ok(state, curve([4250, 4700], [4350, 4700], control));
      const seg = live(state.roads).find((s) => state.roads.segA[s] !== undefined && placesAlong(state.roads, s) > 0) as number;
      const outsideCells = statusesOf(state, seg, 1 - inside);
      const insideCells = statusesOf(state, seg, inside);
      expect(outsideCells.every((s) => s === CELL_OPEN)).toBe(true);
      expect(count(insideCells, CELL_BEND)).toBeGreaterThan(0);
      expect(count(insideCells, CELL_OPEN)).toBeGreaterThan(0);
      // The cells nearest the road follow it the whole way.
      const nearest = cellsOf(state, seg).filter((c) => c.side === inside && c.depth === 0);
      expect(nearest.every((c) => c.status === CELL_OPEN)).toBe(true);
      // Of each strip's cells that close up, the one nearer node A stays.
      const strip = (depth: number) => cellsOf(state, seg).filter((c) => c.side === inside && c.depth === depth);
      const deep = strip(DEPTH - 1);
      expect(deep[0]?.status).toBe(CELL_OPEN);
      expect(overlappingOpenCells(state)).toBe(0);
    }
  });

  it("is blocked under a crossing road, and the younger road gives up the ground the older one's cells hold", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4700], [4600, 4700]));
    ok(state, road([4400, 4500], [4400, 4900]));
    const net = state.roads;
    const west = between(net, [4200, 4700], [4400, 4700]);
    const north = between(net, [4400, 4500], [4400, 4700]);
    // The east-west road's last cells, 4392 to 4400, lie under the new street.
    for (const c of cellsOf(state, west)) {
      if (c.place === 24) expect(c.status).toBe(CELL_ROAD);
      else expect(c.status).toBe(CELL_OPEN);
    }
    // Near the junction the north-south road meets the older road's cells.
    const nearJunction = cellsOf(state, north).filter((c) => c.place >= 19);
    expect(nearJunction.every((c) => c.status === CELL_TAKEN || c.status === CELL_ROAD)).toBe(true);
    expect(count(statusesOf(state, north), CELL_TAKEN)).toBeGreaterThan(0);
    const farFromIt = cellsOf(state, north).filter((c) => c.place < 18);
    expect(farFromIt.every((c) => c.status === CELL_OPEN)).toBe(true);
    expect(overlappingOpenCells(state)).toBe(0);
    expect(rebuilt(state)).toEqual(cellStatuses(state));
  });

  it("gives a T-junction's side street only the ground past the main street's cells", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4600, 4600]));
    ok(state, road([4400, 4600], [4400, 4900]));
    const side = between(state.roads, [4400, 4600], [4400, 4900]);
    const reach = 5 + DEPTH * SIZE;
    for (const c of cellsOf(state, side)) {
      // The main street's cells reach 53 m south of its centre line.
      const from = c.place * SIZE;
      if (from + SIZE <= reach - 5) expect(c.status, `place ${c.place}`).not.toBe(CELL_OPEN);
      if (from >= reach) expect(c.status, `place ${c.place}`).toBe(CELL_OPEN);
    }
    expect(overlappingOpenCells(state)).toBe(0);
  });

  it("is blocked on water along a shore", () => {
    const state = createState(SEED);
    ok(state, road([3620, 7220], [3780, 7220]));
    const seg = between(state.roads, [3620, 7220], [3780, 7220]);
    // North is the left, running east, and is the water side.
    expect(count(statusesOf(state, seg, CELL_LEFT), CELL_WATER)).toBeGreaterThan(0);
    expect(count(statusesOf(state, seg, CELL_RIGHT), CELL_WATER)).toBe(0);
    expect(count(statusesOf(state, seg, CELL_RIGHT), CELL_OPEN)).toBe(statusesOf(state, seg, CELL_RIGHT).length);
  });

  it("is blocked where the ground is steeper than the limit in zoning.json", () => {
    const state = createState(SEED);
    ok(state, road([8360, 5400], [8520, 5400]));
    const seg = between(state.roads, [8360, 5400], [8520, 5400]);
    expect(count(statusesOf(state, seg, CELL_RIGHT), CELL_STEEP)).toBeGreaterThan(0);
    expect(count(statusesOf(state, seg), CELL_OPEN)).toBeGreaterThan(0);
  });

  it("gives bridges, tunnels, elevated roads and the outside connections' highways no cells", () => {
    const state = createState(SEED);
    expect(state.cells.zone).toHaveLength(0);
    ok(state, road([3400, 6600], [3700, 6600]));
    ok(state, road([4200, 4500], [4600, 4500], { level: "tunnel" }));
    ok(state, road([4200, 4800], [4600, 4800], { level: "elevated1" }));
    for (const seg of live(state.roads)) {
      const level = state.roads.segLevelA[seg] ?? 0;
      if (level !== 0) expect(placesAlong(state.roads, seg), `segment ${seg} at level ${level}`).toBe(0);
    }
    // Only the ground pieces of the bridge's road have cells.
    expect(live(state.roads).filter((s) => placesAlong(state.roads, s) > 0).every((s) => state.roads.segLevelA[s] === 0)).toBe(true);
    expect(state.cells.zone.length).toBeGreaterThan(0);
  });

  it("is not blocked by a tunnel or an elevated road over it", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    ok(state, road([4300, 4500], [4300, 4700], { level: "tunnel" }));
    ok(state, road([4250, 4500], [4250, 4700], { level: "elevated1" }));
    const seg = between(state.roads, [4200, 4600], [4392, 4600]);
    expect(statusesOf(state, seg).every((s) => s === CELL_OPEN)).toBe(true);
  });
});

describe("roads competing for ground", () => {
  /** Two parallel streets, edges 32 m (four cells) apart: the north one at z 4600, the south one at 4642. */
  const NORTH: [[number, number], [number, number]] = [
    [4200, 4600],
    [4392, 4600],
  ];
  const SOUTH: [[number, number], [number, number]] = [
    [4200, 4642],
    [4392, 4642],
  ];

  function check(state: SimState, older: number, younger: number, olderFacing: number, youngerFacing: number): void {
    const keep = statusesOf(state, older, olderFacing);
    const lose = statusesOf(state, younger, youngerFacing);
    // The older street keeps the four cells up to the younger road's edge;
    // its two deepest lie under that road.
    for (const c of cellsOf(state, older).filter((c) => c.side === olderFacing)) {
      expect(c.status).toBe(c.depth < 4 ? CELL_OPEN : CELL_ROAD);
    }
    expect(count(lose, CELL_OPEN)).toBe(0);
    expect(count(lose, CELL_TAKEN)).toBe(lose.length - count(lose, CELL_ROAD));
    expect(keep.length).toBe(lose.length);
    // Away from each other both keep their strips.
    expect(statusesOf(state, older, 1 - olderFacing).every((s) => s === CELL_OPEN)).toBe(true);
    expect(statusesOf(state, younger, 1 - youngerFacing).every((s) => s === CELL_OPEN)).toBe(true);
    expect(overlappingOpenCells(state)).toBe(0);
  }

  it("lets the older street keep its whole strip when it has the lower id", () => {
    const state = createState(SEED);
    ok(state, road(...NORTH));
    ok(state, road(...SOUTH));
    const north = between(state.roads, ...NORTH);
    const south = between(state.roads, ...SOUTH);
    expect(north).toBeLessThan(south);
    check(state, north, south, CELL_RIGHT, CELL_LEFT);
  });

  it("lets the older street keep its whole strip when it has the higher id", () => {
    const state = createState(SEED);
    // p2's street takes an id, p1's goes after it, and p2's undo frees the
    // lower id for the younger street.
    ok(state, road([4200, 4900], [4300, 4900], {}, "p2"));
    ok(state, road(...NORTH));
    ok(state, undo("p2"));
    ok(state, road(...SOUTH));
    const north = between(state.roads, ...NORTH);
    const south = between(state.roads, ...SOUTH);
    expect(south).toBeLessThan(north);
    expect(state.roads.segOrder[north]).toBeLessThan(state.roads.segOrder[south] ?? 0);
    check(state, north, south, CELL_RIGHT, CELL_LEFT);
  });

  it("fills out the younger street's strip when the older one is bulldozed, and takes it back on undo", () => {
    const state = createState(SEED);
    ok(state, road(...NORTH));
    ok(state, road(...SOUTH));
    const before = cellStatuses(state);
    const south = between(state.roads, ...SOUTH);
    ok(state, bulldoze([between(state.roads, ...NORTH)]));
    expect(statusesOf(state, south).every((s) => s === CELL_OPEN)).toBe(true);
    expect(rebuilt(state)).toEqual(cellStatuses(state));
    ok(state, undo());
    expect(cellStatuses(state)).toEqual(before);
  });

  it("lets the lower id win between streets of one grid, which share an age", () => {
    const state = createState(SEED);
    ok(
      state,
      command("BuildRoadGrid", {
        origin: { x: 4200, z: 4500 },
        along: { x: 4200 + 3 * 96, z: 4500 },
        across: { x: 4200, z: 4500 + 3 * 96 },
        depth: 86,
        width: 86,
        type: "street",
      }),
    );
    const net = state.roads;
    const streets = live(net).filter((s) => placesAlong(net, s) > 0);
    expect(new Set(streets.map((s) => net.segOrder[s])).size).toBeLessThan(streets.length);
    // Where two streets of the grid meet, the cells of the higher id give way.
    for (const seg of streets) {
      for (const c of cellsOf(state, seg)) {
        if (c.status !== CELL_TAKEN) continue;
        // Some open cell of a lower id overlaps it.
        const [x, z] = centreOf(state, c);
        const mine = Float64Array.from(cellCorners(state, c) ?? []);
        const winners = cellsInBox(state, x - 16, z - 16, x + 16, z + 16).filter(
          (o) => o.status === CELL_OPEN && quadsOverlap(mine, Float64Array.from(cellCorners(state, o) ?? [])),
        );
        expect(winners.length, `${seg}/${c.side}/${c.place}/${c.depth}`).toBeGreaterThan(0);
        for (const w of winners) {
          expect(net.segOrder[w.segment]).toBe(net.segOrder[seg]);
          expect(w.segment).toBeLessThan(seg);
        }
      }
    }
    expect(overlappingOpenCells(state)).toBe(0);
    expect(rebuilt(state)).toEqual(cellStatuses(state));
  });
});

/** Paints every cell of `seg` with a pattern by place and depth, straight into state. No command paints yet. */
function paint(state: SimState, seg: number): void {
  for (const c of cellsOf(state, seg)) {
    state.cells.zone[c.slot] = 1 + ((c.place + c.side) % 5);
    state.cells.density[c.slot] = 1 + (c.depth % 3);
  }
}

/** Zone and density of every zoned cell, by the rounded centre of its ground. */
function zonedGround(state: SimState): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of live(state.roads)) {
    for (const c of cellsOf(state, seg)) {
      const zone = state.cells.zone[c.slot] ?? 0;
      if (zone === 0) continue;
      const [x, z] = centreOf(state, c);
      out.set(`${x.toFixed(6)},${z.toFixed(6)}`, `${zone}/${state.cells.density[c.slot]}`);
    }
  }
  return out;
}

describe("keeping cells current", () => {
  it("carries every zoned cell of a split road onto the piece that holds its ground, and back on undo", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    paint(state, between(state.roads, [4200, 4600], [4392, 4600]));
    const before = zonedGround(state);
    const zonesBefore = Array.from(state.cells.zone);
    expect(before.size).toBe(24 * 2 * DEPTH);
    // A street across it 96 m along splits it into two pieces of twelve cells.
    ok(state, road([4296, 4500], [4296, 4700]));
    const after = zonedGround(state);
    expect(after).toEqual(before);
    // The cells under the new street keep their zone too, though blocked.
    const west = between(state.roads, [4200, 4600], [4296, 4600]);
    expect(cellsOf(state, west).filter((c) => c.place === 11).every((c) => c.status === CELL_ROAD)).toBe(true);
    ok(state, undo());
    expect(zonedGround(state)).toEqual(before);
    expect(Array.from(state.cells.zone)).toEqual(zonesBefore);
  });

  it("keeps a cell's name and zone through an upgrade, and moves it out with the wider road's edge", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    const seg = between(state.roads, [4200, 4600], [4392, 4600]);
    paint(state, seg);
    const zones = cellsOf(state, seg).map((c) => state.cells.zone[c.slot]);
    ok(state, upgrade("avenue", [seg]));
    expect(cellsOf(state, seg).map((c) => state.cells.zone[c.slot])).toEqual(zones);
    // An avenue is 18 m wide, so its edge is 4 m further out.
    expect(cellCorners(state, { segment: seg, side: CELL_LEFT, place: 0, depth: 0 })).toEqual([4200, 4591, 4208, 4591, 4208, 4583, 4200, 4583]);
    expect(rebuilt(state)).toEqual(cellStatuses(state));
  });

  it("keeps each zone on its ground when a one-way is reversed", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600], { type: "oneWay" }));
    const seg = between(state.roads, [4200, 4600], [4392, 4600]);
    paint(state, seg);
    const before = zonedGround(state);
    ok(state, upgrade("oneWay", [seg]));
    expect(state.roads.nodeX[state.roads.segA[seg] ?? 0]).toBe(4392);
    expect(zonedGround(state)).toEqual(before);
  });

  it("walks to the same cells kept current as rebuilt from scratch, after builds, a grid, bulldozes and undos", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4600, 4600]));
    ok(state, curve([4150, 4700], [4450, 4700], [4300, 4550]));
    ok(state, road([4400, 4450], [4400, 4950]));
    ok(
      state,
      command("BuildRoadGrid", {
        origin: { x: 4450, z: 4650 },
        along: { x: 4450 + 2 * 96, z: 4650 },
        across: { x: 4450, z: 4650 + 2 * 96 },
        depth: 86,
        width: 86,
        type: "street",
      }),
    );
    expect(rebuilt(state)).toEqual(cellStatuses(state));
    ok(state, bulldoze(live(state.roads).slice(-3)));
    expect(rebuilt(state)).toEqual(cellStatuses(state));
    ok(state, undo());
    expect(rebuilt(state)).toEqual(cellStatuses(state));
    ok(state, undo());
    expect(rebuilt(state)).toEqual(cellStatuses(state));
    expect(overlappingOpenCells(state)).toBe(0);
    expect(checkCells(state.cells, state.roads)).toBeNull();
  });

  it("walks to the same cells kept current as rebuilt from scratch through random changes to a random network", () => {
    const state = createState(SEED);
    // Roads, rail and paths of every kind, crossing without junctions, some off the map.
    growNetwork(state.roads, 5, 120);
    syncCells(state);
    for (let round = 0; round < 4; round++) {
      churnNetwork(state.roads, 30 + round, 25);
      syncCells(state);
      expect(rebuilt(state), `round ${round}`).toEqual(cellStatuses(state));
      expect(checkCells(state.cells, state.roads)).toBeNull();
    }
  }, 30_000);

  it("hashes the same saved and reloaded mid-run as a city that never stopped", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4600, 4600]));
    ok(state, road([4300, 4450], [4300, 4900]));
    paint(state, between(state.roads, [4200, 4600], [4300, 4600]));
    const loaded = deserialize(serialize(state)).state;
    // The same commands from here on, to the city that kept running and to the one loaded from its save.
    const rest = () => [road([4200, 4642], [4600, 4642]), bulldoze([between(state.roads, [4300, 4600], [4600, 4600])]), undo(), road([4500, 4450], [4500, 4900])];
    const commands = rest();
    for (const c of commands) {
      for (const s of [state, loaded]) {
        expect(submit(s, { ...c, payload: JSON.parse(JSON.stringify(c.payload)) as unknown })).toEqual({ ok: true });
        step(s);
      }
      expect(hashState(loaded)).toBe(hashState(state));
    }
    expect(cellStatuses(loaded)).toEqual(cellStatuses(state));
    expect(zonedGround(loaded).size).toBeGreaterThan(0);
  });
});

describe("cell queries", () => {
  it("finds the cell at a point, the cells in a box and the cells in each chunk", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    ok(state, road([4300, 4500], [4300, 4700]));
    const seg = between(state.roads, [4200, 4600], [4300, 4600]);
    const at = cellAt(state, 4203, 4590);
    expect(at).toMatchObject({ segment: seg, side: CELL_LEFT, place: 0, depth: 0, status: CELL_OPEN });
    expect(at?.index).toBe(cellSlot(state.roads, state.cells, { segment: seg, side: CELL_LEFT, place: 0, depth: 0 }));
    expect(cellAt(state, 4203, 4600)).toBeNull();
    // A cell the crossing street touches is blocked.
    expect(cellAt(state, 4290, 4590)?.status).toBe(CELL_ROAD);

    const box = cellsInBox(state, 4200, 4540, 4216, 4600);
    // Two places along, depths 0 to 6 on the north side: centres at 4204 and 4212.
    expect(box.map((c) => [c.segment, c.side, c.place, c.depth])).toEqual(
      [0, 1].flatMap((place) => [0, 1, 2, 3, 4, 5].filter((d) => 4600 - 9 - 8 * d >= 4540).map((d) => [seg, CELL_LEFT, place, d])),
    );

    // Every cell is in exactly one chunk.
    const all = state.cells.zone.length;
    const seen = new Set<number>();
    for (let chunk = 0; chunk < CHUNKS_PER_SIDE * CHUNKS_PER_SIDE; chunk++) {
      for (const c of cellsInChunk(state, chunk)) {
        expect(seen.has(c.index)).toBe(false);
        seen.add(c.index);
      }
    }
    expect(seen.size).toBe(all);
  });
});

describe("cells in state", () => {
  it("lays out one run per segment id, with nothing for a segment that has none", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    ok(state, road([3400, 6600], [3700, 6600]));
    const fresh = unzonedCells(state.roads);
    expect(state.cells).toEqual(fresh);
    expect(state.cells.offset).toHaveLength(segmentIdLimit(state.roads) + 1);
    expect(checkCells(state.cells, state.roads)).toBeNull();
  });

  it("refuses cells that do not fit the roads", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    expect(checkCells({ ...state.cells, zone: state.cells.zone.slice(1) }, state.roads)).toMatch(/one entry per cell/);
    const zone = state.cells.zone.slice();
    zone[0] = 1;
    expect(checkCells({ ...state.cells, zone }, state.roads)).toMatch(/zone without a density/);
    zone[0] = 9;
    expect(checkCells({ ...state.cells, zone, density: Uint8Array.from(zone, (z) => (z ? 1 : 0)) }, state.roads)).toMatch(/unknown zone/);
    expect(checkCells({ ...state.cells, offset: new Int32Array(1) }, state.roads)).toMatch(/one entry per segment id/);
  });

  it("lays out afresh, keeping zones where they fit, cells whose roads changed outside a step", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    const copy = cloneState(state);
    copy.cells = unzonedCells(createState(SEED).roads);
    syncCells(copy);
    expect(copy.cells).toEqual(state.cells);
  });
});

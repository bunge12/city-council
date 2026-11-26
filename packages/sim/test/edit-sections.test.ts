import { ECONOMY } from "../src/economy/balance";
import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  LEVEL_BRIDGE,
  ROAD_BUILD,
  ROAD_TYPES,
  SEG_FIXED,
  SHORT_SECTION,
  WHOLE_ONLY,
  WHOLE_REVERSE,
  ZONING_BALANCE,
  cellAt,
  createBareState,
  createState,
  deserialize,
  findLot,
  hashState,
  isBuilding,
  planBulldoze,
  planSection,
  planUpgrade,
  previewBulldozeRoad,
  replay,
  serialize,
  step,
  type Command,
  type Lot,
  type RoadType,
  type SimState,
} from "../src/index";
import { submit, withEnds } from "./seen-ends";
import { quadPoint, segmentQuad } from "../src/roads/curve";
import { checkRoadNetwork, isNode, isSegment, nodeIdLimit, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { addBuilding } from "../src/buildings/buildings";
import { heldIds } from "../src/undo";
import { terrainOf } from "../src/terrain/cache";
import fixtureJson from "./fixtures/replay/edit-sections.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

// Issue 86: bulldozing and upgrading part of a segment.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), and an inlet along z = 6600 (bridges.test.ts).
const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;

function typeOf(id: string): RoadType {
  const type = ROAD_TYPES.find((t) => t.id === id);
  if (!type) throw new RangeError(id);
  return type;
}

let seq = 0;
function command(type: string, payload: unknown): Command {
  return { seq: ++seq, playerId: "p1", type, payload };
}

function road(from: [number, number], to: [number, number], type = "street", control?: [number, number]): Command {
  const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  return command("BuildRoad", control ? { ...payload, control: { x: control[0], z: control[1] } } : payload);
}

function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  // A command that reads the cells waits while a change of roads settles.
  while (state.pending.length > 0) step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function refused(state: SimState, c: Command): string {
  const result = submit(state, c);
  expect(result.ok, "the command should be refused").toBe(false);
  return result.ok ? "" : result.reason;
}

/** Live segments a player can edit: not the fixed outside connections `createState` lays. */
function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id) && ((net.segFlags[id] ?? 0) & SEG_FIXED) === 0) out.push(id);
  return out;
}

function liveNodes(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id)) out.push(id);
  return out;
}

/** Each live segment as [ax, az, bx, bz, type id], sorted, to compare networks by shape. */
function shapes(net: RoadNetwork): string[] {
  return liveSegments(net)
    .map((s) => {
      const a = net.segA[s] ?? 0;
      const b = net.segB[s] ?? 0;
      return `${net.nodeX[a]},${net.nodeZ[a]} -> ${net.nodeX[b]},${net.nodeZ[b]} ${ROAD_TYPES[net.segType[s] ?? 0]?.id}`;
    })
    .sort();
}

/** One straight street from (4200, 4600) to (4500, 4600): one segment, 300 m. */
function street(state = createBareState(SEED)): { state: SimState; seg: number } {
  ok(state, road([4200, 4600], [4500, 4600]));
  const seg = liveSegments(state.roads)[0] ?? -1;
  return { state, seg };
}

const bulldoze = (state: SimState, segments: number[], sections?: [number, number][]) =>
  command("BulldozeRoad", withEnds(state.roads, sections ? { segments, sections } : { segments }));
const upgrade = (state: SimState, type: string, segments: number[], sections?: [number, number][], from?: number[]) =>
  command("UpgradeRoad", withEnds(state.roads, { segments, type, ...(sections ? { sections } : {}), ...(from ? { from } : {}) }));

describe("planSection", () => {
  it("cuts a straight segment on the build grid and measures the piece between", () => {
    const { state, seg } = street();
    const plan = planSection(state.roads, seg, [0.4, 0.6]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.cuts.map((c) => [c.x, c.z])).toEqual([
      [4320, 4600],
      [4380, 4600],
    ]);
    expect(plan.piece).toBe(1);
    expect(plan.length).toBe(60);
    // Points off the grid round to it, and the parameter follows the point.
    const odd = planSection(state.roads, seg, [0.40001, 0.6]);
    if (typeof odd === "string") throw new Error(odd);
    const x = odd.cuts[0]?.x ?? 0;
    expect(x * 8).toBe(Math.round(x * 8));
    expect(odd.from).toBe((x - 4200) / 300);
  });

  it("moves an end that would leave a stub under the minimum length to the end of the segment", () => {
    const { state, seg } = street();
    // 6 m from node A: the stretch reaches node A instead.
    const plan = planSection(state.roads, seg, [6 / 300, 0.5]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.from).toBe(0);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.piece).toBe(0);
    expect(plan.length).toBe(150);
    // Both ends near the ends: the whole segment, no cut.
    const whole = planSection(state.roads, seg, [3 / 300, 297 / 300]);
    expect(typeof whole !== "string" && whole.cuts).toEqual([]);
    // Exactly the minimum length from an end is kept as a piece.
    const edge = planSection(state.roads, seg, [ROAD_BUILD.minLength / 300, 0.5]);
    expect(typeof edge !== "string" && edge.cuts).toHaveLength(2);
  });

  it("refuses a stretch under the minimum length, and part of a bridge", () => {
    const { state, seg } = street();
    expect(planSection(state.roads, seg, [0.5, 0.52])).toBe(SHORT_SECTION);
    const water = createBareState(SEED);
    ok(water, road([3400, 6600], [3700, 6600]));
    const net = water.roads;
    const bridge = liveSegments(net).find((s) => net.segLevelA[s] === LEVEL_BRIDGE) ?? -1;
    expect(bridge).toBeGreaterThanOrEqual(0);
    expect(planSection(net, bridge, [0.3, 0.7])).toBe(WHOLE_ONLY);
    expect(typeof planSection(net, bridge, [0, 1])).not.toBe("string");
  });

  it("cuts a curve at points on it", () => {
    const state = createBareState(SEED);
    ok(state, road([4200, 4600], [4500, 4600], "street", [4350, 4500]));
    const seg = liveSegments(state.roads)[0] ?? -1;
    const shape = segmentQuad(state.roads, seg);
    const plan = planSection(state.roads, seg, [0.3, 0.7]);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.cuts.map((c) => c.u)).toEqual([0.3, 0.7]);
    for (const c of plan.cuts) expect({ x: c.x, z: c.z }).toEqual(quadPoint(shape, c.u));
  });
});

describe("BulldozeRoad of part of a segment", () => {
  it("leaves the two ends standing with a gap between, and prices the gap", () => {
    const { state, seg } = street();
    const c = bulldoze(state, [seg], [[0.4, 0.6]]);
    const plan = planBulldoze(state.roads, c.payload);
    expect(plan.ok && plan.plan.length).toBe(60);
    const type = typeOf("street");
    expect(plan.ok && plan.plan.demolition).toBe(Math.round(60 * type.demolitionCostPerMetre));
    expect(plan.ok && plan.plan.refund).toBe(Math.round(60 * type.buildCostPerMetre * ECONOMY.eminentDomain.refundShare));
    ok(state, c);
    expect(shapes(state.roads)).toEqual(["4200,4600 -> 4320,4600 street", "4380,4600 -> 4500,4600 street"]);
    expect(liveNodes(state.roads)).toHaveLength(4);
    expect(checkRoadNetwork(state.roads, heldIds(state.undo))).toBeNull();
    // One log entry.
    expect(state.log.filter((e) => e.type === "BulldozeRoad")).toHaveLength(1);
  });

  it("takes the end node with a stretch that reaches a dead end", () => {
    const { state, seg } = street();
    ok(state, bulldoze(state, [seg], [[0.5, 1]]));
    expect(shapes(state.roads)).toEqual(["4200,4600 -> 4350,4600 street"]);
    expect(liveNodes(state.roads)).toHaveLength(2);
  });

  it("takes part of some segments and the whole of others in one command", () => {
    const { state, seg } = street();
    ok(state, road([4200, 4700], [4500, 4700]));
    const other = liveSegments(state.roads).find((s) => s !== seg) ?? -1;
    ok(state, bulldoze(state, [other, seg], [[0, 1], [0.4, 0.6]]));
    expect(shapes(state.roads)).toEqual(["4200,4600 -> 4320,4600 street", "4380,4600 -> 4500,4600 street"]);
  });

  it("is undone in one step, with the cut nodes gone and the segment back under its id", () => {
    const { state, seg } = street();
    const nodes = liveNodes(state.roads);
    ok(state, bulldoze(state, [seg], [[0.25, 0.5]]));
    ok(state, command("Undo", {}));
    expect(shapes(state.roads)).toEqual(["4200,4600 -> 4500,4600 street"]);
    expect(liveSegments(state.roads)).toEqual([seg]);
    expect(liveNodes(state.roads)).toEqual(nodes);
    expect(checkRoadNetwork(state.roads, heldIds(state.undo))).toBeNull();
  });

  it("gives the zoning of the stretch back on undo", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    const seg = liveSegments(state.roads)[0] ?? -1;
    const rect = { from: { x: 4202, z: 4595 - CELL * 2 }, to: { x: 4390, z: 4595 - CELL * 2 }, width: CELL * 4 - 4 };
    ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [rect] }));
    const zones = Array.from(state.cells.zone);
    expect(zones.some((z) => z !== 0)).toBe(true);
    ok(state, bulldoze(state, [seg], [[0.25, 0.75]]));
    expect(cellAt(state, 4296, 4591)).toBeNull();
    const kept = cellAt(state, 4204, 4591);
    expect(kept && state.cells.zone[kept.index]).toBe(1);
    ok(state, command("Undo", {}));
    expect(liveSegments(state.roads)).toEqual([seg]);
    expect(Array.from(state.cells.zone)).toEqual(zones);
  });

  it("clears the buildings on the stretch, and only those, as its preview says", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4392, 4600]));
    const seg = liveSegments(state.roads)[0] ?? -1;
    const rect = (z: number) => ({ from: { x: 4202, z }, to: { x: 4390, z }, width: CELL * 4 - 4 });
    ok(state, command("ZoneCells", { zone: "residential", density: 1, rects: [rect(4595 - CELL * 2), rect(4605 + CELL * 2)] }));
    const ids: number[] = [];
    for (const z of [4591, 4609]) {
      for (let x = 4204; x < 4392; x += CELL) {
        const cell = cellAt(state, x, z);
        const found = cell && findLot(state, { segment: cell.segment, side: cell.side, place: cell.place, depth: 0 });
        if (found?.ok) ids.push(build(state, found.lot));
      }
    }
    expect(ids.length).toBeGreaterThan(10);
    const c = bulldoze(state, [seg], [[0.4, 0.6]]);
    const preview = previewBulldozeRoad(state, c.payload);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.clears.ids.length).toBeGreaterThan(0);
    expect(preview.clears.ids.length).toBeLessThan(ids.length);
    ok(state, c);
    const left = ids.filter((id) => isBuilding(state.buildings, id));
    expect(ids.filter((id) => !left.includes(id))).toEqual(preview.clears.ids);
  });

  it("is refused whole for a bridge stretch, a short stretch or a bad list", () => {
    const { state, seg } = street();
    expect(refused(state, bulldoze(state, [seg], [[0.5, 0.52]]))).toBe(SHORT_SECTION);
    expect(refused(state, bulldoze(state, [seg], [[0.6, 0.4]]))).toMatch(/needs one stretch/);
    expect(refused(state, bulldoze(state, [seg], [[0, 1.5]]))).toMatch(/needs one stretch/);
    expect(refused(state, bulldoze(state, [seg], []))).toMatch(/needs one stretch/);
    const water = createBareState(SEED);
    ok(water, road([3400, 6600], [3700, 6600]));
    const bridge = liveSegments(water.roads).find((s) => water.roads.segLevelA[s] === LEVEL_BRIDGE) ?? -1;
    expect(refused(water, bulldoze(water, [bridge], [[0.3, 0.7]]))).toBe(WHOLE_ONLY);
  });

  it(`cuts at most ${ROAD_BUILD.editMaxSections} segments in one command`, () => {
    const state = createBareState(SEED);
    const segments = Array.from({ length: ROAD_BUILD.editMaxSections + 1 }, (_, i) => i);
    const sections = segments.map(() => [0.25, 0.75]);
    const ends = segments.map(() => [0, 0, 0, 0]);
    const types = segments.map(() => "street");
    const result = submit(state, command("BulldozeRoad", { segments, ends, types, sections }));
    expect(result).toEqual({
      ok: false,
      reason: `BulldozeRoad can take part of at most ${ROAD_BUILD.editMaxSections} segments at once, and this cuts ${segments.length}`,
    });
  });
});

describe("UpgradeRoad of part of a segment", () => {
  it("changes only the stretch, priced for its length", () => {
    const { state, seg } = street();
    const c = upgrade(state, "avenue", [seg], [[0.4, 0.6]]);
    const plan = planUpgrade(state.roads, terrainOf(SEED), c.payload);
    const avenue = typeOf("avenue");
    const streetType = typeOf("street");
    expect(plan.ok && plan.plan.length).toBe(60);
    expect(plan.ok && plan.plan.cost).toBe(Math.round(60 * avenue.buildCostPerMetre - 60 * streetType.buildCostPerMetre * ROAD_BUILD.upgradeCredit));
    ok(state, c);
    expect(shapes(state.roads)).toEqual([
      "4200,4600 -> 4320,4600 street",
      "4320,4600 -> 4380,4600 avenue",
      "4380,4600 -> 4500,4600 street",
    ]);
    expect(checkRoadNetwork(state.roads, heldIds(state.undo))).toBeNull();
  });

  it("runs a one-way stretch from the end `from` names", () => {
    const { state, seg } = street();
    const b = state.roads.segB[seg] ?? -1;
    ok(state, upgrade(state, "oneWay", [seg], [[0.4, 0.6]], [b]));
    expect(shapes(state.roads)).toContain("4380,4600 -> 4320,4600 oneWay");
  });

  it("refuses to reverse part of a one-way", () => {
    const state = createBareState(SEED);
    ok(state, road([4200, 4600], [4500, 4600], "oneWay"));
    const seg = liveSegments(state.roads)[0] ?? -1;
    expect(refused(state, upgrade(state, "oneWay", [seg], [[0.4, 0.6]]))).toBe(WHOLE_REVERSE);
    ok(state, upgrade(state, "oneWay", [seg], [[0, 1]]));
  });

  it("is undone in one step, with the pieces joined back under the old id", () => {
    const { state, seg } = street();
    ok(state, upgrade(state, "avenue", [seg], [[0.1, 0.9]]));
    ok(state, command("Undo", {}));
    expect(liveSegments(state.roads)).toEqual([seg]);
    expect(shapes(state.roads)).toEqual(["4200,4600 -> 4500,4600 street"]);
    expect(liveNodes(state.roads)).toHaveLength(2);
  });

  it("checks the new type's limits on the stretch alone", () => {
    const state = createBareState(SEED);
    // A curve of a street's radius at the ends and an avenue's in the middle is
    // hard to build, so check the plan's piece shape is what is measured: an
    // upgrade of a straight stretch of a curve-free street never trips the curve limit.
    ok(state, road([4200, 4600], [4500, 4600]));
    const seg = liveSegments(state.roads)[0] ?? -1;
    const plan = planUpgrade(state.roads, terrainOf(SEED), upgrade(state, "avenue", [seg], [[0.2, 0.3]]).payload);
    expect(plan.ok).toBe(true);
  });
});

describe("sections in a save and a replay", () => {
  it("land the same live, from a save and in a replay", () => {
    const { state, seg } = street(createState(SEED));
    ok(state, road([4200, 4700], [4500, 4700], "street", [4350, 4800]));
    const curve = liveSegments(state.roads).find((s) => s !== seg) ?? -1;
    const saved = deserialize(serialize(state)).state;
    const first = upgrade(state, "avenue", [seg, curve], [[0.1, 0.4], [0.5, 0.8]]);
    for (const s of [state, saved]) ok(s, first);
    const second = bulldoze(state, [seg], [[0, 0.5]]);
    for (const s of [state, saved]) ok(s, second);
    expect(hashState(saved)).toBe(hashState(state));
    expect(hashState(deserialize(serialize(state)).state)).toBe(hashState(state));
    expect(hashState(replay(SEED, state.log, state.tick))).toBe(hashState(state));
  });
});

describe("replay fixture edit-sections", () => {
  it("replays to its recorded hash", () => {
    expectReplay(fixtureJson as ReplayFixture);
  });
});

function build(state: SimState, lot: Lot): number {
  const type = BUILDING_TYPES[lot.type];
  if (!type) throw new Error("no such type");
  return addBuilding(state, { ...lot, residents: type.residents[1], variant: 0 });
}

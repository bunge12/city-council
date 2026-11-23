// Free-flow travel times between zones (M3-23, issue #177).

import { describe, expect, it } from "vitest";
import {
  TRAVEL_ZONES,
  buildingTravelTime,
  buildingTravelZone,
  createBareState,
  createState,
  deserialize,
  hashState,
  prepareDerived,
  replay,
  serialize,
  step,
  travelTimesReady,
  validateCommand,
  zoneTravelTime,
  type SimState,
} from "../src/index";
import { buildingInfo } from "../src/buildings/where";
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "../src/chunks";
import { roadTypeIndex } from "../src/roads/balance";
import { NONE, addNode, addSegment, isNode, isSegment, nodeIdLimit, removeSegment, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { ROUTING_BALANCE, findRoute, findRouteBetween, routingGraphOf } from "../src/roads/routing";
import { nextFloat, seedRng } from "../src/rng";
import { cloneState } from "../src/state";
import { markRoadsChanged, prepareTravelTimes, travelRebuildSize, travelZoneSources } from "../src/travel-times";
import { chunkAt } from "../src/zoning/cell-index";
import { runFixture } from "./replay-helper";
import { submit } from "./seen-ends";
import growthFixture from "./fixtures/replay/growth.json";

const STREET = roadTypeIndex("street");
const AVENUE = roadTypeIndex("avenue");
const ONE_WAY = roadTypeIndex("oneWay");

/** Runs `body` with the rebuild given `settles` road nodes a tick, so a small town rebuilds over several ticks. */
function withSettlesPerTick<T>(settles: number, body: () => T): T {
  const was = ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick;
  ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick = settles;
  try {
    return body();
  } finally {
    ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick = was;
  }
}

/**
 * A street grid of `cols` by `rows` nodes `step` metres apart from (x0, z0),
 * every third row an avenue and one one-way across the middle. Returns the
 * node ids by (i, j).
 */
function grid(net: RoadNetwork, x0: number, z0: number, cols: number, rows: number, step: number): number[] {
  const ids: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) ids.push(addNode(net, x0 + i * step, z0 + j * step, 0));
  const at = (i: number, j: number) => ids[j * cols + i] ?? NONE;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i + 1 < cols) addSegment(net, at(i, j), at(i + 1, j), { type: j === Math.floor(rows / 2) ? ONE_WAY : j % 3 === 0 ? AVENUE : STREET });
      if (j + 1 < rows) addSegment(net, at(i, j), at(i, j + 1), { type: STREET });
    }
  }
  return ids;
}

/** Every answer the table gives, as a list, for comparing two tables. */
function allAnswers(state: SimState): (number | null)[] {
  const out: (number | null)[] = [];
  for (let a = 0; a < TRAVEL_ZONES; a++) for (let b = 0; b < TRAVEL_ZONES; b++) out.push(zoneTravelTime(state, a, b));
  return out;
}

/** The answers between the zones that have a road. */
function answersWithin(state: SimState, zones: readonly number[]): (number | null)[] {
  return zones.flatMap((a) => zones.map((b) => zoneTravelTime(state, a, b)));
}

function stepUntilReady(state: SimState): number {
  let steps = 0;
  while (!travelTimesReady(state)) {
    step(state);
    steps++;
    if (steps > 10_000) throw new Error("the travel times never settled");
  }
  return steps;
}

describe("travel zones", () => {
  it("measures each zone from the road node nearest its middle, and a zone with no road has no source", () => {
    const state = createBareState(1);
    grid(state.roads, 1010, 1010, 16, 11, 100);
    const net = state.roads;
    const sources = travelZoneSources(state);
    expect(sources.length).toBe(TRAVEL_ZONES);
    for (let zone = 0; zone < TRAVEL_ZONES; zone++) {
      const cx = ((zone % CHUNKS_PER_SIDE) + 0.5) * CHUNK_SIZE;
      const cz = (Math.floor(zone / CHUNKS_PER_SIDE) + 0.5) * CHUNK_SIZE;
      let best = NONE;
      let bestD = Infinity;
      for (let node = 0; node < nodeIdLimit(net); node++) {
        if (!isNode(net, node) || chunkAt(net.nodeX[node] ?? 0, net.nodeZ[node] ?? 0) !== zone) continue;
        const d = ((net.nodeX[node] ?? 0) - cx) ** 2 + ((net.nodeZ[node] ?? 0) - cz) ** 2;
        if (d < bestD) {
          best = node;
          bestD = d;
        }
      }
      expect(sources[zone], `zone ${zone}`).toBe(best);
    }
    // 1010 to 2510 by 1010 to 2010: zones 2 to 5 across and 2 to 4 down.
    expect(sources.filter((s) => s !== NONE).length).toBe(4 * 3);
    // A zone far from the grid answers "no route", to and from it and within it.
    const empty = 20 * CHUNKS_PER_SIDE + 20;
    const town = 3 * CHUNKS_PER_SIDE + 3;
    expect(sources[empty]).toBe(NONE);
    expect(zoneTravelTime(state, empty, town)).toBeNull();
    expect(zoneTravelTime(state, town, empty)).toBeNull();
    expect(zoneTravelTime(state, empty, empty)).toBeNull();
    expect(zoneTravelTime(state, town, town)).toBe(ROUTING_BALANCE.travelTimes.sameZoneSeconds);
  });

  it("refuses a zone off the map", () => {
    const state = createBareState(1);
    expect(() => zoneTravelTime(state, -1, 0)).toThrow(RangeError);
    expect(() => zoneTravelTime(state, 0, TRAVEL_ZONES)).toThrow(RangeError);
    expect(() => zoneTravelTime(state, 0.5, 0)).toThrow(RangeError);
  });
});

describe("the table against the pathfinder", () => {
  const state = createBareState(1);
  grid(state.roads, 1010, 1010, 16, 11, 100);
  const graph = routingGraphOf(state.roads);
  const sources = travelZoneSources(state);
  const zones = [...sources.keys()].filter((z) => sources[z] !== NONE);

  it("gives the time of the quickest route between two zones' sources, to the second", () => {
    let pairs = 0;
    for (const a of zones) {
      for (const b of zones) {
        if (a === b) continue;
        const route = findRoute(graph, sources[a] ?? NONE, sources[b] ?? NONE);
        if (!route.ok) throw new Error(`no route from zone ${a} to ${b}`);
        const time = zoneTravelTime(state, a, b);
        expect(time).not.toBeNull();
        expect(Math.abs((time ?? 0) - route.route.time), `zone ${a} to ${b}`).toBeLessThanOrEqual(0.5);
        pairs++;
      }
    }
    expect(pairs).toBe(12 * 11);
  });

  it("gives the time between two points in different zones within the time from each to its zone's source", () => {
    const net = state.roads;
    const rng = seedRng(177);
    // Two minutes covers driving from any point of a 500 m zone to its source on this grid.
    const TOLERANCE = 120;
    let checked = 0;
    for (let n = 0; n < 200; n++) {
      const px = 1010 + nextFloat(rng) * 1500;
      const pz = 1010 + nextFloat(rng) * 1000;
      const qx = 1010 + nextFloat(rng) * 1500;
      const qz = 1010 + nextFloat(rng) * 1000;
      const a = chunkAt(px, pz);
      const b = chunkAt(qx, qz);
      if (a === b) continue;
      const route = findRouteBetween(graph, px, pz, qx, qz);
      if (!route.ok) throw new Error("no route between two points on the grid");
      const time = zoneTravelTime(state, a, b) ?? NaN;
      const sa = sources[a] ?? NONE;
      const sb = sources[b] ?? NONE;
      // Both ways between a point and its source, for the bound either way round.
      const leg = (x: number, z: number, s: number) => {
        const sx = net.nodeX[s] ?? 0;
        const sz = net.nodeZ[s] ?? 0;
        const out = findRouteBetween(graph, x, z, sx, sz);
        const back = findRouteBetween(graph, sx, sz, x, z);
        if (!out.ok || !back.ok) throw new Error("no route to a source");
        return Math.max(out.route.time, back.route.time);
      };
      const bound = leg(px, pz, sa) + leg(qx, qz, sb) + 0.5;
      expect(Math.abs(time - route.route.time)).toBeLessThanOrEqual(bound);
      expect(Math.abs(time - route.route.time)).toBeLessThanOrEqual(TOLERANCE);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("follows a one-way: the table is not the same both ways", () => {
    const one = createBareState(1);
    const net = one.roads;
    // Two zones joined by a one-way east, and a long way back round to the west.
    const w = addNode(net, 1250, 1250, 0);
    const e = addNode(net, 1750, 1250, 0);
    const n1 = addNode(net, 1750, 2900, 0);
    const n2 = addNode(net, 1250, 2900, 0);
    addSegment(net, w, e, { type: ONE_WAY });
    addSegment(net, e, n1, { type: STREET });
    addSegment(net, n1, n2, { type: STREET });
    addSegment(net, n2, w, { type: STREET });
    const west = chunkAt(1250, 1250);
    const east = chunkAt(1750, 1250);
    const there = zoneTravelTime(one, west, east) ?? 0;
    const back = zoneTravelTime(one, east, west) ?? 0;
    expect(there).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(there * 3);
  });
});

describe("keeping the table current", () => {
  it("ends a session of road changes with the table a city built from scratch gets, rebuilding over several ticks", () => {
    withSettlesPerTick(2_000, () => {
      const state = createBareState(1);
      const net = state.roads;
      const ids = grid(net, 1010, 1010, 16, 11, 100);
      prepareTravelTimes(state);
      const rng = seedRng(23);
      let multiTick = 0;
      for (let round = 0; round < 12; round++) {
        // A change: take out a few streets, or add a diagonal avenue, or a piece on its own.
        const kind = round % 3;
        if (kind === 0) {
          for (let k = 0; k < 3; k++) {
            const live = [...Array(segmentIdLimit(net)).keys()].filter((s) => isSegment(net, s));
            const seg = live[Math.floor(nextFloat(rng) * live.length)];
            if (seg !== undefined) removeSegment(net, seg);
          }
        } else if (kind === 1) {
          const a = ids[Math.floor(nextFloat(rng) * ids.length)] ?? 0;
          const b = ids[Math.floor(nextFloat(rng) * ids.length)] ?? 0;
          if (a !== b) addSegment(net, a, b, { type: AVENUE });
        } else {
          const x = 3000 + round * 400;
          const p = addNode(net, x, 3000, 0);
          const q = addNode(net, x + 300, 3000, 0);
          addSegment(net, p, q, { type: STREET });
        }
        // Built outside a command, so the test says so, as no game needs to.
        markRoadsChanged(state);
        step(state);
        if (!travelTimesReady(state)) multiTick++;
        // Half the time the next change comes while this one is still rebuilding.
        if (round % 2 === 1) stepUntilReady(state);
      }
      stepUntilReady(state);
      expect(multiTick).toBeGreaterThan(3);
      const fresh = cloneState(state);
      // The size kept from the network's events, which sets the ready tick, is a fresh city's.
      expect(travelRebuildSize(state)).toEqual(travelRebuildSize(fresh));
      expect(travelRebuildSize(fresh).zones).toBeGreaterThan(10);
      expect(allAnswers(state)).toEqual(allAnswers(fresh));
      expect(travelZoneSources(state)).toEqual(travelZoneSources(fresh));
    });
  });

  it("gives the table a fresh city gets when each step's share is smaller than one row's search (#326)", () => {
    // 176 nodes and 40 settles a tick: every row's search stops part way
    // through at least four steps and carries on in the next.
    withSettlesPerTick(40, () => {
      const state = createBareState(1);
      const net = state.roads;
      const ids = grid(net, 1010, 1010, 16, 11, 100);
      prepareTravelTimes(state);
      addSegment(net, ids[0] ?? 0, ids[ids.length - 1] ?? 0, { type: AVENUE });
      markRoadsChanged(state);
      step(state);
      const { nodes, zones } = travelRebuildSize(state);
      expect(nodes).toBe(176);
      expect(state.travelReadyAt - state.tick).toBe(Math.ceil((zones * nodes) / 40) + 1);
      stepUntilReady(state);
      expect(allAnswers(state)).toEqual(allAnswers(cloneState(state)));
    });
  });

  it("refuses to answer while a change of roads is being rebuilt, and answers from the tick it is ready by", () => {
    withSettlesPerTick(2_000, () => {
      const state = createBareState(1);
      const ids = grid(state.roads, 1010, 1010, 16, 11, 100);
      prepareTravelTimes(state);
      addSegment(state.roads, ids[0] ?? 0, ids[17] ?? 0, { type: STREET });
      markRoadsChanged(state);
      step(state);
      // Zones with a road times road nodes over the nodes a tick: 12 * 176 / 2000,
      // 2 ticks of rows after the step of the change and the step that compacts the graph.
      expect(state.travelReadyAt).toBe(state.tick - 1 + 2 + 2);
      expect(() => zoneTravelTime(state, 0, 0)).toThrow(/still being rebuilt/);
      for (let i = 0; i < 3; i++) step(state);
      expect(travelTimesReady(state)).toBe(true);
      expect(zoneTravelTime(state, 2 * CHUNKS_PER_SIDE + 2, 4 * CHUNKS_PER_SIDE + 5)).toBeGreaterThan(0);
    });
  });

  it("rebuilds a small city in the step that changed it", () => {
    const state = createBareState(1);
    const ids = grid(state.roads, 1010, 1010, 4, 4, 100);
    prepareTravelTimes(state);
    const before = zoneTravelTime(state, chunkAt(1010, 1010), chunkAt(1010, 1010));
    addSegment(state.roads, ids[0] ?? 0, ids[5] ?? 0, { type: STREET });
    markRoadsChanged(state);
    step(state);
    expect(state.travelReadyAt).toBe(0);
    expect(state.tick).toBe(1);
    expect(travelTimesReady(state)).toBe(true);
    expect(zoneTravelTime(state, chunkAt(1010, 1010), chunkAt(1010, 1010))).toBe(before);
  });
});

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), across the line between zones at x = 4500.
const SEED = 2026;
const WEST = chunkAt(4300, 4600);
const EAST = chunkAt(4600, 4600);

/** Sends one command from p1 and steps once. */
function send(state: SimState, seq: number, type: string, payload: unknown): void {
  expect(submit(state, { seq, playerId: "p1", type, payload })).toEqual({ ok: true });
  step(state);
}

/** A town in two halves either side of x = 4500, joined by one street. Returns the joining street's segment. */
function twoHalves(state: SimState): number {
  send(state, 1, "BuildRoad", { from: { x: 4150, z: 4600 }, to: { x: 4450, z: 4600 }, type: "street" });
  send(state, 2, "BuildRoad", { from: { x: 4300, z: 4450 }, to: { x: 4300, z: 4750 }, type: "street" });
  send(state, 3, "BuildRoad", { from: { x: 4550, z: 4600 }, to: { x: 4690, z: 4600 }, type: "street" });
  send(state, 4, "BuildRoad", { from: { x: 4600, z: 4450 }, to: { x: 4600, z: 4750 }, type: "street" });
  send(state, 5, "BuildRoad", { from: { x: 4450, z: 4600 }, to: { x: 4550, z: 4600 }, type: "street" });
  const record = state.undo[state.undo.length - 1];
  const joins = record?.ops.filter((op) => op.op === "addSeg").map((op) => op.id) ?? [];
  expect(joins).toHaveLength(1);
  return joins[0] ?? NONE;
}

describe("a town in two halves", () => {
  it("finds no route between the halves once the only road between them is bulldozed", () => {
    const state = createState(SEED);
    prepareDerived(state);
    const join = twoHalves(state);
    stepUntilReady(state);
    expect(zoneTravelTime(state, WEST, EAST)).toBeGreaterThan(0);
    expect(zoneTravelTime(state, EAST, WEST)).toBeGreaterThan(0);
    send(state, 6, "BulldozeRoad", { segments: [join] });
    stepUntilReady(state);
    expect(zoneTravelTime(state, WEST, EAST)).toBeNull();
    expect(zoneTravelTime(state, EAST, WEST)).toBeNull();
    // Each half still reaches itself.
    expect(zoneTravelTime(state, WEST, WEST)).toBe(ROUTING_BALANCE.travelTimes.sameZoneSeconds);
    expect(zoneTravelTime(state, EAST, EAST)).toBe(ROUTING_BALANCE.travelTimes.sameZoneSeconds);
  });

  it("resumes a city saved while the table rebuilds to the same answers on the same ticks, and replays to the same state", () => {
    withSettlesPerTick(5, () => {
      const live = createState(SEED);
      prepareDerived(live);
      const join = twoHalves(live);
      stepUntilReady(live);
      send(live, 6, "BulldozeRoad", { segments: [join] });
      expect(live.travelReadyAt).toBeGreaterThan(live.tick + 1);
      step(live);
      expect(travelTimesReady(live)).toBe(false);
      const loaded = deserialize(serialize(live)).state;
      prepareDerived(loaded);
      expect(hashState(loaded)).toBe(hashState(live));
      let readyOn = -1;
      for (let i = 0; i < 40; i++) {
        // A street rejoins the halves while the bulldoze still rebuilds, in both cities.
        if (i === 3) for (const s of [live, loaded]) send(s, 7, "BuildRoad", { from: { x: 4300, z: 4700 }, to: { x: 4600, z: 4700 }, type: "street" });
        else for (const s of [live, loaded]) step(s);
        expect(hashState(loaded)).toBe(hashState(live));
        expect(travelTimesReady(loaded)).toBe(travelTimesReady(live));
        if (travelTimesReady(live)) {
          if (readyOn < 0) readyOn = live.tick;
          expect(answersWithin(loaded, [WEST, EAST])).toEqual(answersWithin(live, [WEST, EAST]));
        }
      }
      expect(readyOn).toBeGreaterThan(0);
      expect(zoneTravelTime(live, WEST, EAST)).toBeGreaterThan(0);
      const replayed = replay(live.seed, live.log, live.tick);
      expect(hashState(replayed)).toBe(hashState(live));
    });
  });
});

describe("what counts as a change of roads", () => {
  it("is only a command the step applies: a check that builds a grid and takes it back moves nothing", () => {
    withSettlesPerTick(5, () => {
      const state = createState(SEED);
      prepareDerived(state);
      twoHalves(state);
      stepUntilReady(state);
      const readyAt = state.travelReadyAt;
      // validateCommand rehearses a grid by building it and taking it back, as submit does.
      const grid = { origin: { x: 4150, z: 4800 }, along: { x: 4450, z: 4800 }, across: { x: 4150, z: 4950 }, depth: 86, width: 86, type: "street" };
      expect(validateCommand(state, { seq: 9, playerId: "p1", type: "BuildRoadGrid", payload: grid })).toEqual({ ok: true });
      step(state);
      expect(state.travelReadyAt).toBe(readyAt);
      expect(travelTimesReady(state)).toBe(true);
      expect(hashState(replay(state.seed, state.log, state.tick))).toBe(hashState(state));
      // The same grid sent as a command is a change.
      send(state, 9, "BuildRoadGrid", grid);
      expect(state.travelReadyAt).toBeGreaterThan(state.tick);
      expect(hashState(replay(state.seed, state.log, state.tick))).toBe(hashState(state));
    });
  });
});

describe("paused steps", () => {
  it("give the ready tick a replay gives, when a tick's commands applied over several paused steps", () => {
    withSettlesPerTick(1, () => {
      const live = createState(SEED);
      prepareDerived(live);
      twoHalves(live);
      stepUntilReady(live);
      // Exactly one tick's work, so the street pushes it over and its undo brings it back.
      const net = live.roads;
      let nodes = 0;
      for (let n = 0; n < nodeIdLimit(net); n++) if (isNode(net, n) && net.nodeFirstSeg[n] !== NONE) nodes++;
      const rows = travelZoneSources(live).filter((z) => z !== NONE).length;
      ROUTING_BALANCE.travelTimes.rebuildSettlesPerTick = rows * nodes;
      for (let i = 0; i < 5; i++) step(live);
      send(live, 20, "SetSpeed", { speed: 0 });
      const tick = live.tick;
      send(live, 21, "BuildRoad", { from: { x: 4300, z: 4700 }, to: { x: 4600, z: 4700 }, type: "street" });
      const pushed = live.travelReadyAt;
      for (let i = 0; i < 3; i++) step(live);
      send(live, 22, "Undo", {});
      expect(live.tick).toBe(tick);
      send(live, 23, "SetSpeed", { speed: 1 });
      for (let i = 0; i < 20; i++) step(live);
      expect(pushed).toBeGreaterThan(tick);
      // The undo was a small change again: readable at once, from the tick it applied on.
      expect(live.travelReadyAt).toBe(tick);
      expect(hashState(replay(live.seed, live.log, live.tick))).toBe(hashState(live));
    });
  });

  it("refuse a read between a command that changed the roads and the step's catch-up", () => {
    const state = createBareState(1);
    const ids = grid(state.roads, 1010, 1010, 4, 4, 100);
    prepareTravelTimes(state);
    addSegment(state.roads, ids[0] ?? 0, ids[5] ?? 0, { type: STREET });
    markRoadsChanged(state);
    expect(() => zoneTravelTime(state, 0, 0)).toThrow(/not caught up/);
    step(state);
    expect(zoneTravelTime(state, 0, 0)).toBeNull();
  });
});

describe("between buildings", () => {
  it("reads two buildings' time from their zones, and gives two in one zone the short fixed time", () => {
    const { state } = runFixture(growthFixture);
    const ids = [...state.buildings.flags.keys()].filter((id) => buildingInfo(state, id) !== null);
    expect(ids.length).toBeGreaterThan(1);
    const [a = 0, b = 0] = ids;
    expect(buildingTravelZone(state, a)).toBe(buildingInfo(state, a)?.chunk);
    expect(buildingTravelTime(state, a, b)).toBe(zoneTravelTime(state, buildingTravelZone(state, a), buildingTravelZone(state, b)));
    expect(buildingTravelTime(state, a, a)).toBe(ROUTING_BALANCE.travelTimes.sameZoneSeconds);
    expect(() => buildingTravelTime(state, a, 99_999)).toThrow(/does not exist/);
  });
});

import { describe, expect, it } from "vitest";
import {
  CONNECTION_BALANCE,
  NONE,
  ROAD_TYPES,
  connectionEnd,
  connectionStub,
  createState,
  findRoute,
  hashState,
  heightAt,
  mapEdge,
  nearestOutside,
  reachesOutside,
  routingGraphOf,
  slopeAt,
  step,
  submit,
  type Command,
  type SimState,
} from "../src/index";
import { checkConnectionBalance } from "../src/roads/connections";
import { NODE_FIXED, SEG_FIXED, nodeCount, segmentCount, segmentsAt } from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";
import fixture from "./fixtures/connections.json";

const HIGHWAY = ROAD_TYPES.findIndex((t) => t.id === "highway");

let seq = 0;
function command(state: SimState, type: string, payload: unknown, playerId = "p1"): { ok: true } | { ok: false; reason: string } {
  const c: Command = { seq: ++seq, playerId, type, payload };
  const result = submit(state, c);
  step(state);
  return result;
}

function build(state: SimState, from: { x: number; z: number }, to: { x: number; z: number }, type = "street") {
  return command(state, "BuildRoad", { from, to, type });
}

interface Placed {
  edge: number;
  inner: number;
  stub: number;
  x: number;
  z: number;
  innerX: number;
  innerZ: number;
}

function placed(state: SimState): Placed[] {
  const r = state.roads;
  return [...state.connections].map((edge) => {
    const inner = connectionEnd(r, edge);
    return {
      edge,
      inner,
      stub: connectionStub(r, edge),
      x: r.nodeX[edge] ?? NaN,
      z: r.nodeZ[edge] ?? NaN,
      innerX: r.nodeX[inner] ?? NaN,
      innerZ: r.nodeZ[inner] ?? NaN,
    };
  });
}

/** Which side an edge node is on: 0 north, 1 east, 2 south, 3 west. */
function sideOf(x: number, z: number, edge: number): number {
  if (z === 0) return 0;
  if (x === edge) return 1;
  if (z === edge) return 2;
  if (x === 0) return 3;
  return -1;
}

/** One step further into the map from a stub's inner end, as a point. */
function beyond(c: Placed, metres: number): { x: number; z: number } {
  const dx = (c.innerX - c.x) / CONNECTION_BALANCE.stubLength;
  const dz = (c.innerZ - c.z) / CONNECTION_BALANCE.stubLength;
  return { x: c.innerX + dx * metres, z: c.innerZ + dz * metres };
}

describe("outside connections on a new city", () => {
  it("are two or three on every one of 100 seeds, all on dry gentle land at the edge and spread apart", () => {
    const b = CONNECTION_BALANCE;
    const highway = ROAD_TYPES[HIGHWAY];
    if (!highway) throw new Error("no highway type");
    for (let seed = 1000; seed < 1100; seed++) {
      const state = createState(seed);
      const terrain = terrainOf(seed);
      const edge = mapEdge(terrain);
      const list = placed(state);
      expect(list.length, `seed ${seed}`).toBeGreaterThanOrEqual(b.count.min);
      expect(list.length, `seed ${seed}`).toBeLessThanOrEqual(b.count.max);
      // A new city has no other roads.
      expect(segmentCount(state.roads)).toBe(list.length);
      expect(nodeCount(state.roads)).toBe(2 * list.length);
      const sides = new Set<number>();
      for (const c of list) {
        const side = sideOf(c.x, c.z, edge);
        expect(side, `seed ${seed} edge node at ${c.x}, ${c.z}`).toBeGreaterThanOrEqual(0);
        sides.add(side);
        // Dry and no steeper than the highway allows, sampled along the stub.
        for (let i = 0; i <= 25; i++) {
          const x = c.x + ((c.innerX - c.x) * i) / 25;
          const z = c.z + ((c.innerZ - c.z) * i) / 25;
          expect(heightAt(terrain, x, z), `seed ${seed} at ${x}, ${z}`).toBeGreaterThan(terrain.waterLevel);
          expect(slopeAt(terrain, x, z), `seed ${seed} at ${x}, ${z}`).toBeLessThanOrEqual(highway.maxSlope);
        }
        expect(state.roads.segLength[c.stub]).toBe(b.stubLength);
        for (const d of list) {
          if (d === c) continue;
          expect(Math.hypot(c.x - d.x, c.z - d.z), `seed ${seed}`).toBeGreaterThanOrEqual(b.minSpacing);
        }
      }
      // Spread across sides: never all on one.
      expect(sides.size, `seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);

  it("are a fixed edge node and a fixed highway stub ending in a node the player can build from", () => {
    const state = createState(2026);
    const r = state.roads;
    for (const c of placed(state)) {
      expect((r.nodeFlags[c.edge] ?? 0) & NODE_FIXED).toBe(NODE_FIXED);
      expect((r.nodeFlags[c.inner] ?? 0) & NODE_FIXED).toBe(0);
      expect((r.segFlags[c.stub] ?? 0) & SEG_FIXED).toBe(SEG_FIXED);
      expect(r.segType[c.stub]).toBe(HIGHWAY);
      expect(segmentsAt(r, c.edge)).toEqual([c.stub]);
      expect(segmentsAt(r, c.inner)).toEqual([c.stub]);
    }
  });

  it("are the same on every new city of a seed, and differ between seeds", () => {
    expect(hashState(createState(77))).toBe(hashState(createState(77)));
    expect(placed(createState(77)).map((c) => [c.x, c.z])).not.toEqual(placed(createState(78)).map((c) => [c.x, c.z]));
  });

  it.each(fixture.seeds)("match the committed places for seed $seed", ({ seed, connections }) => {
    const got = placed(createState(seed)).map(({ x, z, innerX, innerZ }) => ({ x, z, innerX, innerZ }));
    expect(got).toEqual(connections);
  });

  it("have balance data that checks out", () => {
    expect(checkConnectionBalance(CONNECTION_BALANCE)).toEqual([]);
    expect(checkConnectionBalance({ ...CONNECTION_BALANCE, type: "monorail" })).toEqual(['there is no road type "monorail"']);
    expect(checkConnectionBalance({ ...CONNECTION_BALANCE, count: { min: 3, max: 2 } })).toHaveLength(1);
    expect(checkConnectionBalance({ ...CONNECTION_BALANCE, stubLength: 0 })).toEqual(["stubLength must be a positive number"]);
  });
});

describe("the player and the stubs", () => {
  it("refuses to bulldoze a stub, with a reason", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    const result = command(state, "BulldozeRoad", { segments: [c.stub] });
    expect(result).toEqual({ ok: false, reason: `Segment ${c.stub} is fixed and cannot be bulldozed` });
    expect(connectionStub(state.roads, c.edge)).toBe(c.stub);
  });

  it("refuses to upgrade a stub, with a reason", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    expect(command(state, "UpgradeRoad", { segments: [c.stub], type: "avenue" })).toEqual({
      ok: false,
      reason: `Segment ${c.stub} is fixed and cannot be changed`,
    });
  });

  it("refuses a road that joins the edge node or crosses the stub", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    const reason = "The highway at an outside connection cannot be joined or crossed: build from the end of it";
    // From the edge node itself, along the edge.
    const along = { x: c.x + (c.innerZ - c.z) / 2, z: c.z + (c.innerX - c.x) / 2 };
    expect(build(state, { x: c.x, z: c.z }, along)).toEqual({ ok: false, reason });
    // Across the middle of the stub.
    const mx = (c.x + c.innerX) / 2;
    const mz = (c.z + c.innerZ) / 2;
    const px = (c.innerZ - c.z) / 4;
    const pz = (c.innerX - c.x) / 4;
    expect(build(state, { x: mx - px, z: mz - pz }, { x: mx + px, z: mz + pz })).toEqual({ ok: false, reason });
    // Ending on the stub's body makes a T-junction, which splits it.
    expect(build(state, { x: mx + px, z: mz + pz }, { x: mx, z: mz })).toEqual({ ok: false, reason });
    expect(segmentCount(state.roads)).toBe(state.connections.length);
  });

  it("routes a street built from a stub end to the connection", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    expect(build(state, { x: c.innerX, z: c.innerZ }, beyond(c, 300))).toEqual({ ok: true });
    const street = state.roads.segFlags.length - 1;
    const far = state.roads.segB[street] ?? NONE;
    expect(far).not.toBe(c.inner);
    const route = findRoute(routingGraphOf(state.roads), far, c.edge);
    expect(route.ok && route.route.segments).toEqual([street, c.stub]);
    expect(reachesOutside(state.roads, state.connections, far)).toBe(true);
    expect(nearestOutside(state.roads, state.connections, far)).toBe(c.edge);
  });

  it("says a road not joined to any stub reaches no connection, and a one-way only one way", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    expect(build(state, { x: 4200, z: 4500 }, { x: 4500, z: 4500 })).toEqual({ ok: true });
    const loose = state.roads.segA[state.roads.segFlags.length - 1] ?? NONE;
    expect(reachesOutside(state.roads, state.connections, loose)).toBe(false);
    expect(nearestOutside(state.roads, state.connections, loose)).toBe(NONE);
    // Every edge node reaches itself.
    for (const edge of state.connections) expect(reachesOutside(state.roads, state.connections, edge)).toBe(true);

    // A one-way out of the stub end: its far end cannot drive back in.
    expect(build(state, { x: c.innerX, z: c.innerZ }, beyond(c, 300), "oneWay")).toEqual({ ok: true });
    const oneWay = state.roads.segFlags.length - 1;
    const far = state.roads.segB[oneWay] === c.inner ? state.roads.segA[oneWay] ?? NONE : state.roads.segB[oneWay] ?? NONE;
    const leavesStub = state.roads.segA[oneWay] === c.inner;
    expect(reachesOutside(state.roads, state.connections, far)).toBe(!leavesStub);
  });

  it("are not taken back by undo, and a road built from one is", () => {
    const state = createState(2026);
    const [c] = placed(state);
    if (!c) throw new Error("no connection");
    const before = hashState({ ...state, log: [], tick: 0 });
    expect(build(state, { x: c.innerX, z: c.innerZ }, beyond(c, 300))).toEqual({ ok: true });
    expect(command(state, "Undo", {})).toEqual({ ok: true });
    expect(command(state, "Undo", {}).ok).toBe(false);
    expect(hashState({ ...state, log: [], tick: 0 })).toBe(before);
  });
});

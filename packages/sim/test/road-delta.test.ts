import { describe, expect, it } from "vitest";
import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  applyRoadDelta,
  buildRoadIndex,
  createBareState,
  drainRoadChanges,
  encodeRoadDelta,
  hashState,
  mergeRoadChanges,
  recordRoadChanges,
  roadIndexOf,
  step,
  submit,
  type RoadChanges,
  type RoadNetwork,
} from "../src/index";
import { cloneState } from "../src/state";
import { addNode, addSegment, createRoadNetwork, removeSegment } from "../src/roads/network";
import { churnNetwork, growNetwork } from "./road-network-helper";

/** A deep copy of a network. */
function cloneNetwork(net: RoadNetwork): RoadNetwork {
  return cloneState({ ...createBareState(0), roads: net }).roads;
}

/** Changes drained from `net`, which the test knows has some. */
function drained(net: RoadNetwork): RoadChanges {
  const changes = drainRoadChanges(net);
  if (!changes) throw new Error("expected road changes");
  return changes;
}

/** Each array of `net` as a plain array, for comparing two copies field by field. */
function arrays(net: RoadNetwork): Record<string, number[]> {
  return Object.fromEntries(Object.entries(net).map(([key, array]) => [key, Array.from(array as ArrayLike<number>)]));
}

/** Drains `net`'s changes into `copy` and returns the chunks reported. */
function sync(net: RoadNetwork, copy: RoadNetwork): number[] {
  const changes = drainRoadChanges(net);
  if (!changes) return [];
  const applied = applyRoadDelta(copy, encodeRoadDelta(net, changes));
  if (typeof applied === "string") throw new Error(applied);
  return applied;
}

describe("road change recording", () => {
  it("records nothing until asked, and nothing when nothing changed", () => {
    const net = createRoadNetwork();
    growNetwork(net, 1, 20);
    expect(drainRoadChanges(net)).toBeNull();
    recordRoadChanges(net);
    expect(drainRoadChanges(net)).toBeNull();
  });

  it("keeps a copy equal to the network, array for array, through random adds and removals", () => {
    const net = createRoadNetwork();
    growNetwork(net, 2, 200);
    const copy = cloneNetwork(net);
    recordRoadChanges(net);
    for (let round = 0; round < 200; round++) {
      churnNetwork(net, 100 + round, 1 + (round % 7));
      sync(net, copy);
      expect(arrays(copy)).toEqual(arrays(net));
    }
  });

  it("keeps a spatial index the copy already has equal to one built from scratch", () => {
    const net = createRoadNetwork();
    growNetwork(net, 3, 200);
    const copy = cloneNetwork(net);
    // The client asks its copy a spatial query before any delta lands.
    const index = roadIndexOf(copy);
    recordRoadChanges(net);
    for (let round = 0; round < 100; round++) {
      churnNetwork(net, 300 + round, 1 + (round % 5));
      sync(net, copy);
      const fresh = buildRoadIndex(copy);
      expect(roadIndexOf(copy)).toBe(index);
      expect(index.nodeCells).toEqual(fresh.nodeCells);
      expect(index.segCells).toEqual(fresh.segCells);
    }
  });

  it("sends a removed id handed out again before the drain as the new row", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 100, 100, 0);
    const b = addNode(net, 200, 100, 0);
    const c = addNode(net, 7000, 7000, 0);
    const d = addNode(net, 7100, 7000, 0);
    const old = addSegment(net, a, b, { type: 0 });
    const copy = cloneNetwork(net);
    recordRoadChanges(net);
    removeSegment(net, old);
    const reused = addSegment(net, c, d, { type: 1 });
    expect(reused).toBe(old);
    const changes = drained(net);
    expect(changes.segs).toEqual([old]);
    const delta = encodeRoadDelta(net, changes);
    expect(Array.from(delta.segs.segA)).toEqual([c]);
    expect(Array.from(delta.segs.segType)).toEqual([1]);
    const chunks = applyRoadDelta(copy, delta);
    expect(arrays(copy)).toEqual(arrays(net));
    // The old segment's chunk and the new one's both changed.
    const chunk = (x: number, z: number) => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);
    expect(chunks).toEqual([chunk(100, 100), chunk(7000, 7000)].sort((x, y) => x - y));
  });

  it("merges drains into one list without repeats", () => {
    const net = createRoadNetwork();
    recordRoadChanges(net);
    const a = addNode(net, 0, 0, 0);
    const first = drainRoadChanges(net);
    const b = addNode(net, 50, 0, 0);
    addSegment(net, a, b, { type: 0 });
    const merged = mergeRoadChanges(first, drainRoadChanges(net));
    expect(merged).toEqual({ nodes: [a, b], segs: [0], nodeFree: false, segFree: false });
  });

  it("refuses a delta that does not belong to the copy and leaves it alone", () => {
    const net = createRoadNetwork();
    recordRoadChanges(net);
    growNetwork(net, 3, 10);
    const delta = encodeRoadDelta(net, drained(net));
    growNetwork(net, 4, 10);
    const later = encodeRoadDelta(net, drained(net));
    const copy = createRoadNetwork();
    // Missed the first delta: the new ids below the limit have no rows.
    expect(typeof applyRoadDelta(copy, later)).toBe("string");
    expect(arrays(copy)).toEqual(arrays(createRoadNetwork()));
    expect(applyRoadDelta(copy, delta)).not.toBeTypeOf("string");
  });

  it("is not state: a city hashes and plays the same whether or not changes are read", () => {
    const run = (record: boolean) => {
      const state = createBareState(2026);
      if (record) recordRoadChanges(state.roads);
      let seq = 0;
      for (let i = 0; i < 6; i++) {
        submit(state, {
          seq: ++seq,
          playerId: "p1",
          type: "BuildRoad",
          payload: { from: { x: 4150 + i * 80, z: 4450 }, to: { x: 4150 + i * 80, z: 4950 }, type: "street" },
        });
        submit(state, {
          seq: ++seq,
          playerId: "p1",
          type: "BuildRoad",
          payload: { from: { x: 4120, z: 4500 + i * 70 }, to: { x: 4680, z: 4500 + i * 70 }, type: "avenue" },
        });
        step(state);
        if (record) drainRoadChanges(state.roads);
      }
      return hashState(state);
    };
    expect(run(true)).toBe(run(false));
  });
});

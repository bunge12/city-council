import { describe, expect, it } from "vitest";
import { syncCells } from "../src/zoning/cell-index";
import * as entry from "../src/index";
import { applyRoadDelta, drainRoadChanges, encodeRoadDelta, recordRoadChanges } from "../src/roads/delta";
import { roadTypeIndex } from "../src/roads/balance";
import { hashState } from "../src/hash";
import { nextFloat, nextInt, seedRng } from "../src/rng";
import {
  NETWORK_RAIL,
  NETWORK_ROAD,
  NONE,
  addNode,
  addSegment,
  createRoadNetwork,
  isNode,
  isSegment,
  nodeIdLimit,
  removeSegment,
  restyleSegment,
  segmentIdLimit,
  type RoadNetwork,
} from "../src/roads/network";
import {
  NO_EDGE,
  NO_ROUTE,
  buildRoutingGraph,
  checkRoutingBalance,
  existingRoutingGraph,
  findRoute,
  findRouteBetween,
  freeFlowTime,
  routingGraphOf,
  sameRoutingGraph,
  type Route,
  type RouteResult,
  type RoutingGraph,
} from "../src/roads/routing";
import { NETWORKS_ALL, NETWORKS_RAIL, NETWORKS_ROAD } from "../src/roads/spatial";
import { deserialize, serialize } from "../src/snapshot";
import { cloneState, createBareState } from "../src/state";
import { churnNetwork, growNetwork } from "./road-network-helper";

// Issue M1-15: the routing graph and the pathfinder.

const STREET = roadTypeIndex("street");
const AVENUE = roadTypeIndex("avenue");
const ONE_WAY = roadTypeIndex("oneWay");

/** Builds a network from named points and segments between them. */
function network(
  points: Record<string, [number, number]>,
  segs: [string, string, number?, number?][],
): { net: RoadNetwork; node: Record<string, number>; seg: number[] } {
  const net = createRoadNetwork();
  const node: Record<string, number> = {};
  for (const [name, [x, z]] of Object.entries(points)) node[name] = addNode(net, x, z, 0);
  const seg = segs.map(([a, b, type = STREET, net_ = NETWORK_ROAD]) =>
    addSegment(net, node[a] ?? NONE, node[b] ?? NONE, { type, network: net_ }),
  );
  return { net, node, seg };
}

function routeOf<R extends Route>(result: RouteResult<R>): R {
  if (!result.ok) throw new Error(`expected a route, got "${result.reason}"`);
  return result.route;
}

/** Seconds to drive `metres` at `kmh`. */
const secs = (metres: number, kmh: number) => (metres * 3.6) / kmh;

describe("edge costs", () => {
  it("gives a two-way road an edge each way and a one-way only A to B", () => {
    const { net, seg } = network({ a: [0, 0], b: [100, 0], c: [200, 0] }, [
      ["a", "b", STREET],
      ["b", "c", ONE_WAY],
    ]);
    const graph = buildRoutingGraph(net);
    expect(graph.edgeTime[2 * (seg[0] ?? 0)]).toBeCloseTo(secs(100, 50), 12);
    expect(graph.edgeTime[2 * (seg[0] ?? 0) + 1]).toBeCloseTo(secs(100, 50), 12);
    expect(graph.edgeTime[2 * (seg[1] ?? 0)]).toBeGreaterThan(0);
    expect(graph.edgeTime[2 * (seg[1] ?? 0) + 1]).toBe(NO_EDGE);
  });

  it("is free-flow time, length over the type's speed, kept apart from the search", () => {
    const { net, seg } = network({ a: [0, 0], b: [600, 800] }, [["a", "b", AVENUE]]);
    expect(freeFlowTime(net, seg[0] ?? 0, true)).toBe((1000 * 3.6) / 60);
    // A different cost function changes the answer without touching the search.
    const flat = buildRoutingGraph(net, () => 7);
    expect(routeOf(findRoute(flat, 0, 1)).time).toBe(7);
  });

  it("checks the routing balance file", () => {
    expect(checkRoutingBalance(entry.ROUTING_BALANCE)).toEqual([]);
    expect(checkRoutingBalance({})).toEqual(["networkSpeedKmh is missing"]);
    expect(checkRoutingBalance({ networkSpeedKmh: { rail: { speedKmh: 0, source: "x" }, path: { speedKmh: 5 } } })).toEqual([
      "networkSpeedKmh.rail.speedKmh must be a positive number",
      "networkSpeedKmh.path.source is missing",
    ]);
  });
});

describe("findRoute between nodes", () => {
  it("takes the quickest route even when it is not the fewest segments", () => {
    // A 1,000 m street straight across, or 1,100 m of avenue round by c.
    const { net, node, seg } = network({ a: [0, 0], b: [1000, 0], c: [500, Math.sqrt(52_500)] }, [
      ["a", "b", STREET],
      ["a", "c", AVENUE],
      ["c", "b", AVENUE],
    ]);
    const route = routeOf(findRoute(buildRoutingGraph(net), node["a"] ?? 0, node["b"] ?? 0));
    expect(route.segments).toEqual([seg[1], seg[2]]);
    expect(route.nodes).toEqual([node["a"], node["c"], node["b"]]);
    expect(route.forward).toEqual([true, true]);
    expect(route.distance).toBeCloseTo(1100, 6);
    expect(route.time).toBeCloseTo(secs(1100, 60), 6);
    expect(route.time).toBeLessThan(secs(1000, 50));
  });

  it("goes the long way round when a one-way points the other way", () => {
    // b to a directly is a one-way from a to b, so the route goes round by c.
    const { net, node, seg } = network({ a: [0, 0], b: [100, 0], c: [50, 300] }, [
      ["a", "b", ONE_WAY],
      ["a", "c", STREET],
      ["c", "b", STREET],
    ]);
    const graph = buildRoutingGraph(net);
    expect(routeOf(findRoute(graph, node["a"] ?? 0, node["b"] ?? 0)).segments).toEqual([seg[0]]);
    const back = routeOf(findRoute(graph, node["b"] ?? 0, node["a"] ?? 0));
    expect(back.segments).toEqual([seg[2], seg[1]]);
    expect(back.forward).toEqual([false, false]);
    expect(back.nodes).toEqual([node["b"], node["c"], node["a"]]);
  });

  it("says there is no route between two networks that do not join", () => {
    const { net, node } = network({ a: [0, 0], b: [100, 0], c: [5000, 0], d: [5100, 0] }, [
      ["a", "b"],
      ["c", "d"],
    ]);
    const graph = buildRoutingGraph(net);
    expect(findRoute(graph, node["a"] ?? 0, node["d"] ?? 0)).toEqual({ ok: false, reason: NO_ROUTE });
    expect(routeOf(findRoute(graph, node["c"] ?? 0, node["d"] ?? 0)).segments).toHaveLength(1);
  });

  it("routes a node to itself with no segments", () => {
    const { net, node } = network({ a: [0, 0], b: [100, 0] }, [["a", "b"]]);
    expect(routeOf(findRoute(buildRoutingGraph(net), node["a"] ?? 0, node["a"] ?? 0))).toEqual({
      segments: [],
      forward: [],
      nodes: [node["a"]],
      distance: 0,
      time: 0,
    });
  });

  it("keeps to the networks in the filter", () => {
    // Rail runs straight from a to b; the road goes round by c.
    const { net, node, seg } = network({ a: [0, 0], b: [2000, 0], c: [1000, 300], d: [3000, 0] }, [
      ["a", "b", 0, NETWORK_RAIL],
      ["a", "c", STREET],
      ["c", "b", STREET],
      ["b", "d", STREET],
    ]);
    const graph = buildRoutingGraph(net);
    const a = node["a"] ?? 0;
    const b = node["b"] ?? 0;
    expect(routeOf(findRoute(graph, a, b)).segments).toEqual([seg[1], seg[2]]);
    expect(routeOf(findRoute(graph, a, b, NETWORKS_RAIL)).segments).toEqual([seg[0]]);
    // The rail route never leaves the track.
    expect(findRoute(graph, a, node["d"] ?? 0, NETWORKS_RAIL)).toEqual({ ok: false, reason: NO_ROUTE });
  });

  it("breaks a tie between equal routes by id, whatever order a node's list is in", () => {
    // Two equal ways from a to b, over c above and d below.
    const points: Record<string, [number, number]> = { a: [0, 0], b: [200, 0], c: [100, 100], d: [100, -100] };
    const { net, node } = network(points, [
      ["a", "c"],
      ["c", "b"],
      ["a", "d"],
      ["d", "b"],
    ]);
    const route = routeOf(findRoute(buildRoutingGraph(net), node["a"] ?? 0, node["b"] ?? 0));
    // At b both ways arrive at the same time, and segment 1 is lower than 3.
    expect(route.segments).toEqual([0, 1]);

    // The same ids, but every node's list in another order: take each
    // segment out and put it back, so it comes back under its own id at the
    // head of its nodes' lists.
    for (const seg of [3, 2, 1, 0]) {
      const a = net.segA[seg] ?? 0;
      const b = net.segB[seg] ?? 0;
      removeSegment(net, seg);
      expect(addSegment(net, a, b, { type: STREET })).toBe(seg);
    }
    expect(routeOf(findRoute(buildRoutingGraph(net), node["a"] ?? 0, node["b"] ?? 0))).toEqual(route);
  });

  it("refuses nodes that do not exist and bad filters", () => {
    const { net } = network({ a: [0, 0], b: [100, 0] }, [["a", "b"]]);
    const graph = buildRoutingGraph(net);
    expect(() => findRoute(graph, 0, 9)).toThrow(RangeError);
    expect(() => findRoute(graph, 0, 1, 99)).toThrow(RangeError);
  });
});

describe("findRouteBetween points", () => {
  it("joins each point to the nearest segment and travels only part of it", () => {
    const { net, seg } = network({ a: [0, 0], b: [100, 0], c: [200, 0] }, [
      ["a", "b"],
      ["b", "c"],
    ]);
    const route = routeOf(findRouteBetween(buildRoutingGraph(net), 30, 5, 170, -5));
    expect(route.segments).toEqual([seg[0], seg[1]]);
    expect(route.forward).toEqual([true, true]);
    expect(route.nodes).toEqual([1]);
    expect(route.distance).toBeCloseTo(140, 9);
    expect(route.time).toBeCloseTo(secs(140, 50), 9);
    expect(route.start).toMatchObject({ segment: seg[0], x: 30, z: 0, offset: 5 });
    expect(route.end).toMatchObject({ segment: seg[1], x: 170, z: 0, offset: 5 });
  });

  it("goes straight along a segment both ends share", () => {
    const { net, seg } = network({ a: [0, 0], b: [100, 0] }, [["a", "b"]]);
    const graph = buildRoutingGraph(net);
    const route = routeOf(findRouteBetween(graph, 80, 0, 20, 0));
    expect(route.segments).toEqual([seg[0]]);
    expect(route.forward).toEqual([false]);
    expect(route.nodes).toEqual([]);
    expect(route.distance).toBeCloseTo(60, 9);
  });

  it("goes round a loop when both ends are on a one-way pointing the other way", () => {
    // A one-way from a to b, and a street back from b to a by c.
    const { net, node, seg } = network({ a: [0, 0], b: [100, 0], c: [50, 100] }, [
      ["a", "b", ONE_WAY],
      ["b", "c"],
      ["c", "a"],
    ]);
    const graph = buildRoutingGraph(net);
    // Forward along the one-way: straight there.
    expect(routeOf(findRouteBetween(graph, 20, 0, 80, 0)).segments).toEqual([seg[0]]);
    // Backward: on to b, round by c to a, and along the one-way again.
    const round = routeOf(findRouteBetween(graph, 80, 0, 20, 0));
    expect(round.segments).toEqual([seg[0], seg[1], seg[2], seg[0]]);
    expect(round.forward).toEqual([true, true, true, true]);
    expect(round.nodes).toEqual([node["b"], node["c"], node["a"]]);
    expect(round.distance).toBeCloseTo(20 + 2 * Math.sqrt(50 * 50 + 100 * 100) + 20, 9);
  });

  it("measures a part of a curved segment along the curve", () => {
    const net = createRoadNetwork();
    const a = addNode(net, 0, 0, 0);
    const b = addNode(net, 200, 0, 0);
    addSegment(net, a, b, { type: STREET, cx: 100, cz: 100 });
    const graph = buildRoutingGraph(net);
    const whole = routeOf(findRouteBetween(graph, 0, 0, 200, 0));
    expect(whole.distance).toBeCloseTo(net.segLength[0] ?? 0, 9);
    // By symmetry, the apex is half way along.
    const half = routeOf(findRouteBetween(graph, 0, 0, 100, 50));
    expect(half.distance).toBeCloseTo((net.segLength[0] ?? 0) / 2, 1);
  });

  it("says when a point is too far from any road, or the two do not join", () => {
    const { net } = network({ a: [0, 0], b: [100, 0], c: [5000, 0], d: [5100, 0] }, [
      ["a", "b"],
      ["c", "d"],
    ]);
    const graph = buildRoutingGraph(net);
    expect(findRouteBetween(graph, 50, 500, 60, 0, { radius: 100 })).toEqual({ ok: false, reason: "no road near the start" });
    expect(findRouteBetween(graph, 50, 0, 60, 500, { radius: 100 })).toEqual({ ok: false, reason: "no road near the end" });
    expect(findRouteBetween(graph, 50, 0, 5050, 0)).toEqual({ ok: false, reason: NO_ROUTE });
  });
});

// ---- A plain Dijkstra, for checking the real one ----

/**
 * The quickest route by a textbook Dijkstra: scan the unsettled nodes for
 * the nearest one, and read edges from a scan of every segment rather than
 * the node lists. The same tie rules: the lower node id settles first,
 * and of two equal ways into a node the lower segment id.
 */
function plainDijkstra(graph: RoutingGraph, from: number, to: number, networks: number): RouteResult {
  const { net } = graph;
  const n = nodeIdLimit(net);
  const time = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(NONE);
  const done = new Uint8Array(n);
  const out: [number, number, number][][] = Array.from({ length: n }, () => []);
  for (let seg = 0; seg < segmentIdLimit(net); seg++) {
    if (!isSegment(net, seg) || ((1 << (net.segNetwork[seg] ?? 0)) & networks) === 0) continue;
    const a = net.segA[seg] ?? 0;
    const b = net.segB[seg] ?? 0;
    const fwd = graph.edgeTime[2 * seg] ?? NO_EDGE;
    const back = graph.edgeTime[2 * seg + 1] ?? NO_EDGE;
    if (fwd !== NO_EDGE) out[a]?.push([b, fwd, seg]);
    if (back !== NO_EDGE) out[b]?.push([a, back, seg]);
  }
  time[from] = 0;
  // Nodes reached but not settled. Picking from it by a linear scan, not a
  // heap, keeps this the textbook search.
  const open = [from];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < open.length; i++) {
      const v = open[i] ?? 0;
      const u = open[pick] ?? 0;
      if (pick < 0 || (time[v] ?? 0) < (time[u] ?? 0) || (time[v] === time[u] && v < u)) pick = i;
    }
    if (pick < 0) return { ok: false, reason: NO_ROUTE };
    const u = open[pick] ?? 0;
    open[pick] = open[open.length - 1] ?? 0;
    open.pop();
    done[u] = 1;
    if (u === to) break;
    for (const [v, cost, seg] of out[u] ?? []) {
      if (done[v]) continue;
      const t = (time[u] ?? 0) + cost;
      if (t < (time[v] ?? Infinity) || (t === time[v] && seg < (via[v] ?? NONE))) {
        if (time[v] === Infinity) open.push(v);
        time[v] = t;
        via[v] = seg;
      }
    }
  }
  const segments: number[] = [];
  const nodes = [to];
  for (let at = to; at !== from; ) {
    const seg = via[at] ?? NONE;
    segments.push(seg);
    at = (net.segB[seg] === at ? net.segA[seg] : net.segB[seg]) ?? NONE;
    nodes.push(at);
  }
  segments.reverse();
  nodes.reverse();
  const forward = segments.map((seg, i) => net.segA[seg] === nodes[i]);
  let distance = 0;
  for (const seg of segments) distance += net.segLength[seg] ?? 0;
  return { ok: true, route: { segments, forward, nodes, distance, time: time[to] ?? 0 } };
}

function liveNodes(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id)) out.push(id);
  return out;
}

/** `count` random node pairs, seeded. */
function pairs(net: RoadNetwork, seed: number, count: number): [number, number][] {
  const rng = seedRng(seed);
  const nodes = liveNodes(net);
  return Array.from({ length: count }, () => [nodes[nextInt(rng, nodes.length)] ?? 0, nodes[nextInt(rng, nodes.length)] ?? 0]);
}

/** Turns about a tenth of the road segments into one-ways, some reversed, so the graph has one-way edges. */
function sprinkleOneWays(net: RoadNetwork, seed: number): void {
  const rng = seedRng(seed);
  for (let seg = 0; seg < segmentIdLimit(net); seg++) {
    if (!isSegment(net, seg) || net.segNetwork[seg] !== NETWORK_ROAD || nextFloat(rng) > 0.1) continue;
    restyleSegment(net, seg, ONE_WAY, nextFloat(rng) < 0.5);
  }
}

describe("findRoute on a random network", () => {
  const net = createRoadNetwork();
  growNetwork(net, 15, 3000);
  sprinkleOneWays(net, 16);
  const graph = routingGraphOf(net);

  it("matches a plain Dijkstra on 200 random pairs", () => {
    let found = 0;
    for (const [from, to] of pairs(net, 17, 200)) {
      const want = plainDijkstra(graph, from, to, NETWORKS_ROAD);
      expect(findRoute(graph, from, to)).toEqual(want);
      if (want.ok) found++;
    }
    // A fifth of the random network is rail or path, and much of it is in
    // fragments, so only some pairs join. Enough do for the check to mean
    // something.
    expect(found).toBeGreaterThan(40);
  });

  it("matches a plain Dijkstra with every network allowed", () => {
    for (const [from, to] of pairs(net, 18, 50)) {
      expect(findRoute(graph, from, to, NETWORKS_ALL)).toEqual(plainDijkstra(graph, from, to, NETWORKS_ALL));
    }
  });

  it("finds point routes no slower than the node routes between the same segments' ends", () => {
    const rng = seedRng(19);
    let found = 0;
    for (let i = 0; i < 100; i++) {
      const fx = nextFloat(rng) * 12_000;
      const fz = nextFloat(rng) * 12_000;
      const tx = nextFloat(rng) * 12_000;
      const tz = nextFloat(rng) * 12_000;
      const result = findRouteBetween(graph, fx, fz, tx, tz);
      if (!result.ok) continue;
      found++;
      const r = result.route;
      // The route's own pieces add up.
      expect(r.segments).toHaveLength(r.forward.length);
      expect(r.distance).toBeGreaterThanOrEqual(0);
      if (r.nodes.length > 0) {
        const middle = routeOf(findRoute(graph, r.nodes[0] ?? 0, r.nodes[r.nodes.length - 1] ?? 0));
        expect(middle.segments).toEqual(r.segments.slice(1, -1));
        expect(r.time).toBeGreaterThanOrEqual(middle.time - 1e-9);
      }
    }
    expect(found).toBeGreaterThan(15);
  });
});

describe("routing graph kept current", () => {
  it("equals one rebuilt from scratch after a long run of builds, bulldozes and upgrades", () => {
    const net = createRoadNetwork();
    growNetwork(net, 30, 1500);
    const graph = routingGraphOf(net);
    const rng = seedRng(31);
    for (let round = 0; round < 10; round++) {
      churnNetwork(net, 32 + round, 200);
      // Upgrades and reversals too, which change an edge in place.
      for (let i = 0; i < 20; i++) {
        const seg = nextInt(rng, segmentIdLimit(net));
        if (!isSegment(net, seg) || net.segNetwork[seg] !== NETWORK_ROAD) continue;
        restyleSegment(net, seg, nextInt(rng, 3), nextFloat(rng) < 0.3);
      }
    }
    expect(routingGraphOf(net)).toBe(graph);
    const fresh = buildRoutingGraph(net);
    expect(sameRoutingGraph(graph, fresh)).toBe(true);
    for (const [from, to] of pairs(net, 40, 200)) {
      expect(findRoute(graph, from, to)).toEqual(findRoute(fresh, from, to));
    }
  });

  it("is not part of state: saving, hashing and cloning ignore it", () => {
    const state = createBareState(5);
    growNetwork(state.roads, 3, 300);
    const before = hashState(state);
    const bytes = serialize(state);
    routingGraphOf(state.roads);
    expect(hashState(state)).toBe(before);
    expect(serialize(state)).toEqual(bytes);
    expect(existingRoutingGraph(cloneState(state).roads)).toBeNull();
  });

  it("gives a city saved and loaded mid-run the same routes as one that never stopped", () => {
    const state = createBareState(9);
    growNetwork(state.roads, 21, 1500);
    // prepareDerived also walks the 1.5 million zoning cells this random network has.
    entry.prepareDerived(state);
    expect(existingRoutingGraph(state.roads)).not.toBeNull();
    churnNetwork(state.roads, 22, 300);
    // The roads were changed by hand, not by a step, so lay their cells out first.
    syncCells(state);
    const loaded = deserialize(serialize(state)).state;
    churnNetwork(state.roads, 23, 500);
    churnNetwork(loaded.roads, 23, 500);
    expect(hashState(loaded)).toBe(hashState(state));
    const p = routingGraphOf(state.roads);
    const q = routingGraphOf(loaded.roads);
    expect(sameRoutingGraph(p, q)).toBe(true);
    for (const [from, to] of pairs(state.roads, 24, 100)) expect(findRoute(q, from, to)).toEqual(findRoute(p, from, to));
  }, 30_000);

  it("follows road deltas on a client's copy", () => {
    const net = createRoadNetwork();
    growNetwork(net, 50, 400);
    const copy = cloneState({ ...createBareState(0), roads: net }).roads;
    const graph = routingGraphOf(copy);
    recordRoadChanges(net);
    for (let round = 0; round < 5; round++) {
      churnNetwork(net, 51 + round, 100);
      const changes = drainRoadChanges(net);
      if (!changes) continue;
      const applied = applyRoadDelta(copy, encodeRoadDelta(net, changes));
      if (typeof applied === "string") throw new Error(applied);
      expect(sameRoutingGraph(graph, buildRoutingGraph(copy))).toBe(true);
    }
  });
});

describe("routing exports", () => {
  it("are on the sim entry file", () => {
    expect(entry.findRoute).toBe(findRoute);
    expect(entry.findRouteBetween).toBe(findRouteBetween);
    expect(entry.routingGraphOf).toBe(routingGraphOf);
    expect(entry.NO_ROUTE).toBe(NO_ROUTE);
  });
});

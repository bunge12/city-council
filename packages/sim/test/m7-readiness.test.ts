// The three things M7 needs from M1 (PRD, "M7 Rail transport"), checked at
// M1's close (issue M1-17): every segment carries a network type and a
// vertical level, and the curve and slope limits come from the segment's
// type, not from code. Rail and path have no buildable types yet, so their
// segments are made through the internal functions, as M7's first commands
// will make them.

import { describe, expect, it } from "vitest";
import { syncCells } from "../src/zoning/cell-index";
import {
  NETWORKS_ALL,
  NETWORKS_PATH,
  NETWORKS_RAIL,
  NETWORKS_ROAD,
  ROAD_TYPES,
  createBareState,
  deserialize,
  findRoute,
  findRouteBetween,
  hashState,
  planRoad,
  routingGraphOf,
  serialize,
} from "../src/index";
import { roadTypeIndex } from "../src/roads/balance";
import {
  LEVEL_BRIDGE,
  LEVEL_ELEVATED_1,
  LEVEL_ELEVATED_2,
  LEVEL_GROUND,
  LEVEL_TUNNEL,
  NETWORK_PATH,
  NETWORK_RAIL,
  NETWORK_ROAD,
  addNode,
  addSegment,
} from "../src/roads/network";
import { terrainOf } from "../src/terrain/cache";

const SEED = 2026;

describe("M7 readiness", () => {
  it("builds a segment of each network type and routes each with its filter", () => {
    const state = createBareState(SEED);
    const net = state.roads;
    // A road, a rail line and a path, side by side from x = 0 to x = 2000,
    // each its own pair of nodes, and a road crossing to the rail's far end
    // that only the all-networks filter may use.
    const node = (x: number, z: number) => addNode(net, x, z, 10);
    const road = [node(0, 0), node(2000, 0)] as const;
    const rail = [node(0, 100), node(2000, 100)] as const;
    const path = [node(0, 200), node(2000, 200)] as const;
    const street = roadTypeIndex("street");
    const segRoad = addSegment(net, road[0], road[1], { type: street, network: NETWORK_ROAD });
    const segRail = addSegment(net, rail[0], rail[1], { type: 0, network: NETWORK_RAIL, level: LEVEL_ELEVATED_1 });
    const segPath = addSegment(net, path[0], path[1], { type: 0, network: NETWORK_PATH, level: LEVEL_TUNNEL });
    const link = addSegment(net, road[1], rail[1], { type: street, network: NETWORK_ROAD });

    // Each segment keeps its network and its level at both ends.
    expect([net.segNetwork[segRoad], net.segNetwork[segRail], net.segNetwork[segPath]]).toEqual([NETWORK_ROAD, NETWORK_RAIL, NETWORK_PATH]);
    expect([net.segLevelA[segRoad], net.segLevelB[segRoad]]).toEqual([LEVEL_GROUND, LEVEL_GROUND]);
    expect([net.segLevelA[segRail], net.segLevelB[segRail]]).toEqual([LEVEL_ELEVATED_1, LEVEL_ELEVATED_1]);
    expect([net.segLevelA[segPath], net.segLevelB[segPath]]).toEqual([LEVEL_TUNNEL, LEVEL_TUNNEL]);

    const graph = routingGraphOf(net);
    const only = (from: number, to: number, networks: number) => {
      const r = findRoute(graph, from, to, networks);
      return r.ok ? r.route.segments : null;
    };
    expect(only(road[0], road[1], NETWORKS_ROAD)).toEqual([segRoad]);
    expect(only(rail[0], rail[1], NETWORKS_RAIL)).toEqual([segRail]);
    expect(only(path[0], path[1], NETWORKS_PATH)).toEqual([segPath]);
    // A filter keeps a route on its own network.
    expect(only(rail[0], rail[1], NETWORKS_ROAD)).toBeNull();
    expect(only(road[0], road[1], NETWORKS_RAIL)).toBeNull();
    expect(only(rail[0], path[1], NETWORKS_ALL)).toBeNull();
    expect(only(road[0], rail[0], NETWORKS_ALL)).toEqual([segRoad, link, segRail]);
    expect(only(road[0], rail[0], NETWORKS_ROAD)).toBeNull();
    // Between points, too: a point by the rail joins the rail only when rail is in the filter.
    const between = findRouteBetween(graph, 10, 100, 1990, 100, { networks: NETWORKS_RAIL });
    expect(between.ok && between.route.segments).toEqual([segRail]);
    const byRoad = findRouteBetween(graph, 10, 100, 1990, 100, { networks: NETWORKS_ROAD });
    expect(byRoad.ok && byRoad.route.segments).not.toContain(segRail);

    // All of it survives a save.
    // The roads were changed by hand, not by a step, so lay their cells out first.
    syncCells(state);
    const loaded = deserialize(serialize(state)).state;
    expect(hashState(loaded)).toBe(hashState(state));
    expect(loaded.roads.segNetwork[segPath]).toBe(NETWORK_PATH);
    expect(loaded.roads.segLevelB[segRail]).toBe(LEVEL_ELEVATED_1);
  });

  it("stores every level value M5 and M7 need", () => {
    // Ground, bridge, tunnel and the two elevated levels, as the PRD lists them.
    expect([LEVEL_GROUND, LEVEL_BRIDGE, LEVEL_TUNNEL, LEVEL_ELEVATED_1, LEVEL_ELEVATED_2]).toEqual([0, 1, 2, 3, 4]);
  });

  // Street and avenue have different limits in roads.json, so the same road
  // passes as one and is refused as the other, with the type's own limit in
  // the reason. Nothing in code holds a limit.
  const street = ROAD_TYPES.find((t) => t.id === "street");
  const avenue = ROAD_TYPES.find((t) => t.id === "avenue");

  it("takes the curve limit from the road type", () => {
    if (!street || !avenue) throw new Error("types missing");
    expect(avenue.minCurveRadius).toBeGreaterThan(street.minCurveRadius);
    const state = createBareState(SEED);
    const terrain = terrainOf(SEED);
    // On the flat dry square, bend a 100 m road ever tighter until the
    // avenue refuses it.
    let found = false;
    for (let bow = 10; bow <= 200 && !found; bow += 2) {
      const payload = { from: { x: 4300, z: 4700 }, to: { x: 4400, z: 4700 }, control: { x: 4350, z: 4700 + bow } };
      const asStreet = planRoad(state.roads, terrain, { ...payload, type: "street" });
      const asAvenue = planRoad(state.roads, terrain, { ...payload, type: "avenue" });
      if (asStreet.ok && !asAvenue.ok) {
        expect(asAvenue.reason).toMatch(new RegExp(`avenue limit is ${avenue.minCurveRadius} m`));
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("takes the slope limit from the road type", () => {
    if (!street || !avenue) throw new Error("types missing");
    expect(avenue.maxSlope).toBeLessThan(street.maxSlope);
    const state = createBareState(SEED);
    const terrain = terrainOf(SEED);
    // Short roads across the map until one is steep enough for the avenue's
    // limit but not the street's.
    let found = false;
    for (let z = 500; z < 12_000 && !found; z += 250) {
      for (let x = 500; x < 11_500 && !found; x += 250) {
        const payload = { from: { x, z }, to: { x: x + 64, z } };
        const asStreet = planRoad(state.roads, terrain, { ...payload, type: "street" });
        if (!asStreet.ok) continue;
        const asAvenue = planRoad(state.roads, terrain, { ...payload, type: "avenue" });
        if (!asAvenue.ok && asAvenue.reason.startsWith("Too steep")) {
          expect(asAvenue.reason).toMatch(`avenue limit is ${Math.round(avenue.maxSlope * 100)}%`);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });
});

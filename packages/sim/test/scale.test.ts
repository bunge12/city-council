// The M1 scale network (issue M1-17): the generated city itself and the
// crossing rule on it. The city is built once per run by scale-setup.ts and
// loaded here; the second test builds it again from its commands and holds
// it to that snapshot. The save and resume sessions, the fill with
// buildings and the lot marks on it are in scale-*.test.ts, a file each so
// that Vitest runs them side by side (issue #230). Timings are in
// scale.bench.ts and town.bench.ts.

import { beforeAll, describe, expect, it } from "vitest";
import {
  NETWORKS_ROAD,
  SCALE_SEGMENTS,
  buildScaleCity,
  deserialize,
  hashState,
  planRoad,
  createScaleState,
  replayFrom,
  serialize,
  step,
  type ScaleCity,
} from "../src/index";
import { submit } from "./seen-ends";
import { LEVEL_ELEVATED_1, isSegment, segmentCount, segmentIdLimit } from "../src/roads/network";
import { findRouteBetween, routingGraphOf } from "../src/roads/routing";
import { terrainOf } from "../src/terrain/cache";
import { loadScaleCity, scaleCityMeta } from "./scale-fixture";

let city: ScaleCity;
beforeAll(() => {
  city = loadScaleCity();
});

describe("the scale city", () => {
  it("has 30,000 segments built through commands, with grids, curves and bridges", () => {
    const { counts, state } = city;
    expect(counts.segments).toBeGreaterThanOrEqual(SCALE_SEGMENTS);
    expect(segmentCount(state.roads)).toBe(counts.segments);
    expect(counts.grids).toBeGreaterThan(150);
    expect(counts.curved).toBeGreaterThan(500);
    expect(counts.bridges).toBeGreaterThan(5);
    // Every segment came from a logged command but the outside connections'.
    const types = new Set(state.log.map((e) => e.type));
    expect([...types].sort()).toEqual(["BuildRoad", "BuildRoadGrid"]);
    expect(state.logOffset).toBe(0);
  });

  it("is the same city every time, and replays from its log to the same hash", () => {
    // Every scale test and bench loads the city from the snapshot
    // scale-setup.ts saved. Built again from its commands here, it must
    // match that snapshot, or the shortcut has drifted.
    const again = buildScaleCity();
    const hash = scaleCityMeta().hash;
    expect(hashState(city.state)).toBe(hash);
    expect(hashState(again.state)).toBe(hash);
    expect(again.counts).toEqual(city.counts);
    expect(again.grids).toEqual(city.grids);
    expect(hashState(replayFrom(createScaleState(), city.state.log, city.state.tick))).toBe(hash);
    // Builds the city twice more, keeping its 2.9 million zoning cells current through every command.
  }, 120_000);

  it("routes across the map, from the north-west grid to the south-east one", () => {
    const first = city.grids[0];
    const last = city.grids.at(-1);
    if (!first || !last) throw new Error("no grids");
    const route = findRouteBetween(routingGraphOf(city.state.roads), first.x, first.z, last.x, last.z, { networks: NETWORKS_ROAD });
    if (!route.ok) throw new Error(route.reason);
    expect(route.route.distance).toBeGreaterThan(9000);
  });

  it("an elevated road laid across it forms no intersection (issue 22)", () => {
    const state = deserialize(serialize(city.state)).state;
    const g = city.grids[Math.floor(city.grids.length / 2)];
    if (!g) throw new Error("no grids");
    // A quarter of the way into a row of blocks, clear of the generator's
    // avenues along the middles, over all seven streets of a grid and the
    // avenues between them.
    const z = g.z + 96 * 2 + 24;
    const payload = { from: { x: g.x - 24, z }, to: { x: g.x + 6 * 96 + 24, z }, type: "street", level: "elevated1" };
    const ground = planRoad(state.roads, terrainOf(state.seed), { ...payload, level: undefined });
    if (!ground.ok) throw new Error(ground.reason);
    // On the ground the same road would split every street it crosses.
    expect(ground.plan.stops.filter((s) => s.splits.length > 0).length).toBeGreaterThanOrEqual(7);
    const before = segmentCount(state.roads);
    const limit = segmentIdLimit(state.roads);
    expect(submit(state, { seq: 1, playerId: "p1", type: "BuildRoad", payload }).ok).toBe(true);
    step(state);
    expect(segmentCount(state.roads)).toBe(before + 1);
    // Only the new segment changed, and it is raised at both ends.
    const added: number[] = [];
    for (let id = 0; id < segmentIdLimit(state.roads); id++) {
      if (!isSegment(state.roads, id)) continue;
      if (id >= limit || !isSegment(city.state.roads, id)) added.push(id);
    }
    expect(added).toHaveLength(1);
    const seg = added[0] ?? -1;
    expect(state.roads.segLevelA[seg]).toBe(LEVEL_ELEVATED_1);
    expect(state.roads.segLevelB[seg]).toBe(LEVEL_ELEVATED_1);
    for (let id = 0; id < limit; id++) {
      if (!isSegment(city.state.roads, id)) continue;
      expect(state.roads.segA[id]).toBe(city.state.roads.segA[id]);
      expect(state.roads.segB[id]).toBe(city.state.roads.segB[id]);
    }
    // The copy loaded from a save builds its 2.9 million zoning cells on its first step, a few seconds.
  }, 60_000);
});


// The M1 scale network (issue M1-17): the generated city itself, the
// crossing rule on it, and a save and resume half way through a scripted
// session on it. Timings are in scale.bench.ts.

import { beforeAll, describe, expect, it } from "vitest";
import {
  NETWORKS_ROAD,
  SCALE_SEED,
  SCALE_SEGMENTS,
  buildScaleCity,
  deserialize,
  hashState,
  planRoad,
  replay,
  serialize,
  step,
  submit,
  type ScaleCity,
  type SimState,
} from "../src/index";
import { LEVEL_ELEVATED_1, SEG_FIXED, isSegment, segmentCount, segmentIdLimit } from "../src/roads/network";
import { findRouteBetween, routingGraphOf } from "../src/roads/routing";
import { terrainOf } from "../src/terrain/cache";

let city: ScaleCity;
beforeAll(() => {
  city = buildScaleCity();
}, 60_000);

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
    const again = buildScaleCity();
    const hash = hashState(city.state);
    expect(hashState(again.state)).toBe(hash);
    expect(hashState(replay(SCALE_SEED, city.state.log, city.state.tick))).toBe(hash);
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

/**
 * One tick of a scripted session on the scale city: every 20 ticks a road
 * command picked from the state as it stands, so two runs that reach a tick
 * with the same state send the same command. Builds, grids, upgrades,
 * bulldozes and undos, all of which read the spatial index, the routing
 * graph or the blocks that a load has to rebuild.
 */
function scriptedTick(state: SimState, grids: readonly { x: number; z: number }[], seq: { n: number }): void {
  const t = state.tick;
  const send = (type: string, payload: unknown) => submit(state, { seq: ++seq.n, playerId: t % 200 < 100 ? "p1" : "p2", type, payload });
  /** The first live segment at or after `from` that a player may change. */
  const liveFrom = (from: number): number => {
    const limit = segmentIdLimit(state.roads);
    for (let k = 0; k < limit; k++) {
      const id = (from + k) % limit;
      if (isSegment(state.roads, id) && ((state.roads.segFlags[id] ?? 0) & SEG_FIXED) === 0) return id;
    }
    return 0;
  };
  if (t % 20 === 0) {
    const g = grids[(t * 7) % grids.length] ?? { x: 0, z: 0 };
    const k = (t / 20) % 5;
    switch (k) {
      case 0: {
        // A quarter of the way into a row of blocks, clear of the avenues
        // the generator laid along their middles.
        const z = g.z + 96 * ((t / 100) % 6) + 24;
        send("BuildRoad", { from: { x: g.x - 24, z }, to: { x: g.x + 3 * 96 + 24, z }, type: "street" });
        break;
      }
      case 1:
        send("BulldozeRoad", { segments: [liveFrom((t * 7919) % segmentIdLimit(state.roads))] });
        break;
      case 2:
        send("UpgradeRoad", { segments: [liveFrom((t * 104_729) % segmentIdLimit(state.roads))], type: "avenue" });
        break;
      case 3:
        send("Undo", {});
        break;
      default:
        // A quarter of a block in from the grid's corner, so its lines run
        // between the city's own and clear of the curved one-ways, which bow
        // east from the middle of their blocks.
        send("BuildRoadGrid", {
          origin: { x: g.x + 24, z: g.z + 24 },
          along: { x: g.x + 24 + 3 * 96, z: g.z + 24 },
          across: { x: g.x + 24, z: g.z + 24 + 3 * 96 },
          depth: 86,
          width: 86,
          type: "street",
        });
    }
  }
  step(state);
}

describe("save and resume on the scale city", () => {
  const TICKS = 1000;

  it("a session saved and reloaded half way ends on the same hash as one that ran straight through", () => {
    // Straight through, on the city as the generator left it, with every
    // piece of derived data kept current since the first road.
    const straight = buildScaleCity().state;
    const start = straight.tick;
    const seqA = { n: 100_000 };
    while (straight.tick < start + TICKS) scriptedTick(straight, city.grids, seqA);

    // Half way, then a save, a load into a new state with no derived data,
    // and the rest.
    let resumed = buildScaleCity().state;
    const seqB = { n: 100_000 };
    while (resumed.tick < start + TICKS / 2) scriptedTick(resumed, city.grids, seqB);
    const bytes = serialize(resumed);
    resumed = deserialize(bytes).state;
    while (resumed.tick < start + TICKS) scriptedTick(resumed, city.grids, seqB);

    const sessionEntries = straight.log.filter((e) => e.tick >= start);
    // Enough of each command applied for the check to mean something.
    for (const type of ["BuildRoad", "BulldozeRoad", "UpgradeRoad", "Undo", "BuildRoadGrid"]) {
      expect(sessionEntries.filter((e) => e.type === type).length, type).toBeGreaterThan(2);
    }
    expect(resumed.tick).toBe(straight.tick);
    expect(hashState(resumed)).toBe(hashState(straight));
    expect(resumed.log).toEqual(straight.log);
    // And a replay of the whole log agrees with both.
    expect(hashState(replay(SCALE_SEED, [...straight.log], straight.tick))).toBe(hashState(straight));
  }, 120_000);
});

// A save and resume half way through a scripted session of zoning, clearing
// and growth on the scale city (issue M2-17). Split from scale.test.ts
// (issue #230).

import { describe, expect, it } from "vitest";
import {
  SCALE_SEED,
  buildingCount,
  cellsSettled,
  deserialize,
  hashState,
  replay,
  seeBuilding,
  serialize,
  step,
  type BuildingSeen,
  type SimState,
} from "../src/index";
import { submit } from "./seen-ends";
import { SEG_FIXED, isSegment, segmentIdLimit } from "../src/roads/network";
import { loadScaleCity, scaleCityMeta } from "./scale-fixture";

/**
 * One tick of a scripted session with zoning and growth on the scale city
 * (issue M2-17): every 10 ticks a command picked from the state as it
 * stands, so two runs that reach a tick with the same state send the same
 * command. It zones a grid's blocks, rezones some of them, clears
 * buildings the grower put up, runs a street through them, bulldozes a
 * built street and undoes, while the grower builds on every tick.
 */
function zoningTick(state: SimState, grids: readonly { x: number; z: number }[], seq: { n: number }): void {
  const t = state.tick;
  const send = (type: string, payload: unknown) => submit(state, { seq: ++seq.n, playerId: t % 200 < 100 ? "p1" : "p2", type, payload });
  if (t % 10 === 0) {
    const slot = t / 10;
    const g = grids[(Math.floor(slot / 6) * 11) % grids.length] ?? { x: 0, z: 0 };
    const zones = ["residential", "commercial", "industrial", "office", "mixed"];
    // Sixteen 256 m squares over the grid and the ground around it, each at the largest a rectangle may be.
    const square = (zone: string, density: number) => ({
      zone,
      density,
      rects: Array.from({ length: 16 }, (_, k) => {
        const x = g.x - 256 + (k % 4) * 256;
        const z = g.z - 128 + Math.floor(k / 4) * 256;
        return { from: { x, z }, to: { x: x + 256, z }, width: 256 };
      }),
    });
    switch (slot % 6) {
      case 0:
        send("ZoneCells", square(zones[slot % zones.length] ?? "residential", 1 + (slot % 3)));
        break;
      case 1:
        // A rezone of the middle of the same ground, which leaves what stands there standing.
        send("ZoneCells", { zone: "commercial", density: 2, rects: [{ from: { x: g.x + 96, z: g.z + 128 }, to: { x: g.x + 288, z: g.z + 128 }, width: 96 }] });
        break;
      case 2: {
        // Clears up to five of the buildings standing, from an id that moves with the tick.
        const seen: BuildingSeen[] = [];
        const b = state.buildings;
        for (let id = (t * 31) % Math.max(1, b.flags.length); id < b.flags.length && seen.length < 5; id++) {
          {
          const one = seeBuilding(b, id);
          if (one) seen.push(one);
        }
        }
        if (seen.length > 0) send("BulldozeBuilding", { buildings: seen });
        break;
      }
      case 3: {
        // Through the zoned rows of the grid the previous round zoned, 60 ticks back, where houses stand.
        const round = Math.floor(slot / 6);
        const old = grids[(Math.max(0, round - 1) * 11) % grids.length] ?? g;
        const z = old.z + 96 * (round % 6) + 24;
        send("BuildRoad", { from: { x: old.x - 24, z }, to: { x: old.x + 3 * 96 + 24, z }, type: "street" });
        break;
      }
      case 4: {
        // A built street, if any: the first segment from a point in the id range with a building on it.
        const limit = segmentIdLimit(state.roads);
        const b = state.buildings;
        let seg = -1;
        for (let id = 0; id < b.flags.length && seg < 0; id++) {
          const s = b.firstSeg[(id + t) % b.flags.length] ?? -1;
          if (b.flags[(id + t) % b.flags.length] && s >= 0 && s < limit && isSegment(state.roads, s) && ((state.roads.segFlags[s] ?? 0) & SEG_FIXED) === 0) seg = s;
        }
        if (seg >= 0) send("BulldozeRoad", { segments: [seg] });
        break;
      }
      default:
        send("Undo", {});
    }
  }
  step(state);
}

describe("save and resume with zoning and growth on the scale city (issue M2-17)", () => {
  const { grids } = scaleCityMeta();
  const TICKS = 1000;

  /** The scale city with its cells settled: its last grids leave a walk of a few thousand ticks, and the grower waits for it. */
  const settledCity = (): SimState => {
    const state = loadScaleCity().state;
    while (!cellsSettled(state)) step(state);
    return state;
  };

  it("a session saved and reloaded half way ends on the same hash as one that ran straight through", () => {
    const straight = settledCity();
    const start = straight.tick;
    const seqA = { n: 100_000 };
    let mostBuildings = 0;
    while (straight.tick < start + TICKS) {
      zoningTick(straight, grids, seqA);
      mostBuildings = Math.max(mostBuildings, buildingCount(straight.buildings));
    }

    let resumed = settledCity();
    const seqB = { n: 100_000 };
    while (resumed.tick < start + TICKS / 2) zoningTick(resumed, grids, seqB);
    // Half way the grower has buildings up and lots half built: the save must carry all of it.
    expect(buildingCount(resumed.buildings)).toBeGreaterThan(100);
    resumed = deserialize(serialize(resumed)).state;
    while (resumed.tick < start + TICKS) zoningTick(resumed, grids, seqB);

    const sessionEntries = straight.log.filter((e) => e.tick >= start);
    for (const type of ["ZoneCells", "BulldozeBuilding", "BuildRoad", "BulldozeRoad", "Undo"]) {
      expect(sessionEntries.filter((e) => e.type === type).length, type).toBeGreaterThan(5);
    }
    expect(mostBuildings).toBeGreaterThan(500);
    expect(resumed.tick).toBe(straight.tick);
    expect(buildingCount(resumed.buildings)).toBe(buildingCount(straight.buildings));
    expect(hashState(resumed)).toBe(hashState(straight));
    expect(resumed.log).toEqual(straight.log);
    // A replay of the whole log grows the same buildings.
    // Both runs above start from the saved snapshot, so this replay is the one run here built from
    // the first road with every piece of derived data kept current. Keep it.
    expect(hashState(replay(SCALE_SEED, [...straight.log], straight.tick))).toBe(hashState(straight));
  }, 300_000);
});

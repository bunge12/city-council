// A save and resume half way through a scripted session of road commands on
// the M1 scale network (issue M1-17). Split from scale.test.ts (issue #230).

import { describe, expect, it } from "vitest";
import { SCALE_SEED, cellsSettled, deserialize, hashState, replay, serialize, step, type SimState } from "../src/index";
import { submit } from "./seen-ends";
import { SEG_FIXED, isSegment, segmentIdLimit } from "../src/roads/network";
import { loadScaleCity, scaleCityMeta } from "./scale-fixture";

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
  const { grids } = scaleCityMeta();
  const TICKS = 1000;

  it("a session saved and reloaded half way ends on the same hash as one that ran straight through", () => {
    // Straight through, on the city as the generator left it. Its cells
    // are settled first: an undo that puts roads back waits for them, and
    // the generator's last grids leave a walk of thousands of ticks (M2
    // review, #147). The replay at the end runs the same session with every
    // piece of derived data kept current since the first road.
    const fresh = (): SimState => {
      const state = loadScaleCity().state;
      while (!cellsSettled(state)) step(state);
      return state;
    };
    const straight = fresh();
    const start = straight.tick;
    const seqA = { n: 100_000 };
    while (straight.tick < start + TICKS) scriptedTick(straight, grids, seqA);

    // Half way, then a save, a load into a new state with no derived data,
    // and the rest.
    let resumed = fresh();
    const seqB = { n: 100_000 };
    while (resumed.tick < start + TICKS / 2) scriptedTick(resumed, grids, seqB);
    const bytes = serialize(resumed);
    resumed = deserialize(bytes).state;
    while (resumed.tick < start + TICKS) scriptedTick(resumed, grids, seqB);

    const sessionEntries = straight.log.filter((e) => e.tick >= start);
    // Enough of each command applied for the check to mean something.
    for (const type of ["BuildRoad", "BulldozeRoad", "UpgradeRoad", "Undo", "BuildRoadGrid"]) {
      expect(sessionEntries.filter((e) => e.type === type).length, type).toBeGreaterThan(2);
    }
    expect(resumed.tick).toBe(straight.tick);
    expect(hashState(resumed)).toBe(hashState(straight));
    expect(resumed.log).toEqual(straight.log);
    // And a replay of the whole log agrees with both.
    // Both runs above start from the saved snapshot, so this replay is the one run here built from
    // the first road with every piece of derived data kept current. Keep it.
    expect(hashState(replay(SCALE_SEED, [...straight.log], straight.tick))).toBe(hashState(straight));
  }, 120_000);
});


import { describe, expect, it } from "vitest";
import {
  ZONE_NONE,
  applyCellDelta,
  applyRoadDelta,
  cellStatuses,
  createBareState,
  drainCellDelta,
  drainRoadChanges,
  encodeRoadDelta,
  hashState,
  mergeRoadChanges,
  recordCellChanges,
  recordRoadChanges,
  step,
  submit,
  type Command,
  type RoadChanges,
  type SimState,
} from "../src/index";
import { cloneState } from "../src/state";

// M2-05: cell deltas, without a host. A copy takes the road rows and the
// cells of several steps at once and must end where the sim is.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;

let seq = 0;
const command = (type: string, payload: unknown = {}): Command => ({ seq: ++seq, playerId: "p1", type, payload });
const road = (from: [number, number], to: [number, number], type = "street") =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });
const zone = (zoneId: string, from: [number, number], to: [number, number], width: number) =>
  command("ZoneCells", { zone: zoneId, density: 2, rects: [{ from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, width }] });

/** A sim that records, and a copy of it as a client would hold after a snapshot. */
function pair() {
  const sim = createBareState(SEED);
  recordRoadChanges(sim.roads);
  recordCellChanges(sim);
  const copy = cloneState(sim);
  let roads: RoadChanges | null = null;
  /** Applies commands in one step, as a host does between two deltas. */
  const run = (...commands: Command[]) => {
    for (const c of commands) expect(submit(sim, c), c.type).toEqual({ ok: true });
    step(sim);
    roads = mergeRoadChanges(roads, drainRoadChanges(sim.roads));
  };
  /** Sends everything since the last delta to the copy. */
  const send = () => {
    const roadDelta = roads ? encodeRoadDelta(sim.roads, roads) : null;
    roads = null;
    const cells = drainCellDelta(sim);
    if (roadDelta) expect(typeof applyRoadDelta(copy.roads, roadDelta)).not.toBe("string");
    expect(typeof applyCellDelta(copy, cells, roadDelta ? roadDelta.segIds : [])).not.toBe("string");
    copy.tick = sim.tick;
    copy.log = sim.log.slice();
    copy.undo = sim.undo;
    return cells;
  };
  return { sim, copy, run, send };
}

const zoned = (state: SimState) => state.cells.zone.reduce((n, z) => n + (z === ZONE_NONE ? 0 : 1), 0);

describe("cell deltas", () => {
  it("records nothing until asked, and nothing when no cell changed", () => {
    const quiet = createBareState(SEED);
    expect(submit(quiet, road([4150, 4500], [4650, 4500]))).toEqual({ ok: true });
    step(quiet);
    expect(drainCellDelta(quiet)).toBeNull();
    const { run, send } = pair();
    run(command("NoOp"));
    expect(send()).toBeNull();
  });

  it("brings a copy level after several steps of roads, zoning, an edit and an undo in one delta", () => {
    const { sim, copy, run, send } = pair();
    run(road([4150, 4500], [4650, 4500]));
    run(zone("residential", [4200, 4470], [4400, 4470], 60), zone("commercial", [4400, 4530], [4600, 4530], 60));
    // Cuts the street, so painted cells move to new segments before any delta goes out.
    run(road([4400, 4400], [4400, 4600]));
    run(zone("industrial", [4410, 4420], [4410, 4480], 30));
    run(command("BulldozeRoad", { segments: [0] }));
    run(command("Undo"));
    const cells = send();
    expect(cells?.relaid.length).toBeGreaterThan(2);
    expect(zoned(sim)).toBeGreaterThan(100);
    // Only zoned cells travel for a segment laid out again.
    expect(cells?.local.length).toBe(zoned(sim));
    expect(hashState(copy)).toBe(hashState(sim));
    expect([...cellStatuses(copy)]).toEqual([...cellStatuses(sim)]);
  });

  it("sends a cell painted and then cleared between two deltas once, as unzoned", () => {
    const { sim, copy, run, send } = pair();
    run(road([4150, 4500], [4650, 4500]));
    send();
    run(zone("residential", [4200, 4470], [4300, 4470], 60));
    run(zone("none", [4200, 4470], [4250, 4470], 60));
    const cells = send();
    expect(cells?.relaid.length).toBe(0);
    expect(cells && [...cells.zone].filter((z) => z === ZONE_NONE).length).toBeGreaterThan(0);
    expect(cells && [...cells.zone].filter((z) => z !== ZONE_NONE).length).toBe(zoned(sim));
    expect(hashState(copy)).toBe(hashState(sim));
  });

  it("drops the cells of a segment an undo took back", () => {
    const { sim, copy, run, send } = pair();
    run(road([4150, 4500], [4650, 4500]));
    run(zone("residential", [4200, 4470], [4300, 4470], 60));
    send();
    expect(zoned(copy)).toBeGreaterThan(0);
    run(command("Undo"));
    const cells = send();
    expect(cells?.local.length).toBe(0);
    expect(copy.cells.zone.length).toBe(0);
    expect(hashState(copy)).toBe(hashState(sim));
  });
});

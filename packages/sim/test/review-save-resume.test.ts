// M2 review (#147): save and resume against an uninterrupted run, saving at
// many points, including while cells are still being walked after a road
// and while the grower is mid-day, and through the autosave path (capture
// into kept buffers, written a part at a time into a kept output buffer).
import { describe, expect, it } from "vitest";
import {
  ZONING_BALANCE,
  buildingCount,
  captureState,
  createCaptureBuffers,
  createState,
  deserialize,
  hashState,
  replay,
  serialize,
  serializeDetachedSteps,
  step,
  type SimState,
  type SnapshotBuffer,
} from "../src/index";
import { submit } from "./seen-ends";
import { SEG_FIXED, isSegment, segmentIdLimit } from "../src/roads/network";

const SEED = 2026;
const CELL = ZONING_BALANCE.cellSize;
const STEPS = 1000;

/** One host step `i`: a command picked from `i` and the state as it stands, then a step. */
function drive(state: SimState, i: number): void {
  const player = i % 300 < 150 ? "p1" : "p2";
  const send = (type: string, payload: unknown) => submit(state, { seq: i, playerId: player, type, payload });
  // Streets in the dry, flat square from (4100, 4400) to (4700, 5000).
  const streetsEW = [4480, 4600, 4720, 4840];
  const streetsNS = [4200, 4392, 4584];
  if (i < 7 && i < streetsEW.length) send("BuildRoad", { from: { x: 4150, z: streetsEW[i] }, to: { x: 4650, z: streetsEW[i] }, type: "street" });
  else if (i >= 4 && i < 7) {
    const x = streetsNS[i - 4] ?? 4200;
    send("BuildRoad", { from: { x, z: 4430 }, to: { x, z: 4880 }, type: "street" });
  }
  if (i >= 10 && i % 40 === 10) {
    const zones = ["residential", "commercial", "industrial", "office", "mixed"];
    const k = (i - 10) / 40;
    const z0 = 4440 + (k % 4) * 110;
    send("ZoneCells", {
      zone: zones[k % zones.length],
      density: 1 + (k % 3),
      rects: [
        { from: { x: 4160, z: z0 + 50 }, to: { x: 4400, z: z0 + 50 }, width: 100 },
        { from: { x: 4400, z: z0 + 50 }, to: { x: 4640, z: z0 + 50 }, width: 100 },
      ],
    });
  }
  if (i % 70 === 33) {
    // Clears up to three standing buildings from an id that moves with the step.
    const b = state.buildings;
    const seen: { id: number; segment: number; side: number; place: number }[] = [];
    for (let k = 0; k < b.flags.length && seen.length < 3; k++) {
      const id = (k + i * 7) % b.flags.length;
      if (b.flags[id]) seen.push({ id, segment: b.firstSeg[id] ?? 0, side: b.firstSide[id] ?? 0, place: b.firstPlace[id] ?? 0 });
    }
    if (seen.length > 0) send("BulldozeBuilding", { buildings: seen });
  }
  if (i % 190 === 120) {
    // A street through built ground.
    const z = 4540 + ((i / 190) % 3) * 120;
    send("BuildRoad", { from: { x: 4150, z }, to: { x: 4650, z: z + 8 * CELL }, type: "street" });
  }
  if (i % 230 === 200) {
    const limit = segmentIdLimit(state.roads);
    for (let k = 0; k < limit; k++) {
      const s = (k + i) % limit;
      if (isSegment(state.roads, s) && ((state.roads.segFlags[s] ?? 0) & SEG_FIXED) === 0) {
        send("BulldozeRoad", { segments: [s] });
        break;
      }
    }
  }
  if (i % 230 === 215) send("UpgradeRoad", { segments: [(i * 13) % Math.max(1, segmentIdLimit(state.roads))], type: "avenue" });
  if (i % 160 === 150) send("Undo", {});
  if (i % 97 === 0) send("SetSpeed", { speed: [1, 2, 4, 0][(i / 97) % 4] });
  if (i % 97 === 3) send("SetSpeed", { speed: 4 });
  step(state);
}

function run(state: SimState, from: number, to: number): SimState {
  for (let i = from; i < to; i++) drive(state, i);
  return state;
}

function finish(steps: Generator<undefined, Uint8Array, undefined>): Uint8Array {
  for (;;) {
    const part = steps.next();
    if (part.done) return part.value;
  }
}

describe("M2 review: save and resume", () => {
  const straight = run(createState(SEED), 0, STEPS);
  const want = hashState(straight);

  it("the straight run zones, grows, clears and edits", () => {
    const types = new Set(straight.log.map((e) => e.type));
    for (const t of ["BuildRoad", "ZoneCells", "BulldozeBuilding", "BulldozeRoad", "Undo"]) expect(types.has(t), t).toBe(true);
    expect(buildingCount(straight.buildings)).toBeGreaterThan(20);
    expect(straight.tick).toBeGreaterThan(900);
    console.log(buildingCount(straight.buildings), JSON.stringify(Object.fromEntries([...types].map((t) => [t, straight.log.filter((e) => e.type === t).length]))));
  });

  it("500 steps, save, load, 500 more ends on the straight hash", () => {
    let s = run(createState(SEED), 0, 500);
    s = deserialize(serialize(s)).state;
    run(s, 500, STEPS);
    expect(hashState(s)).toBe(want);
  });

  for (const at of [1, 3, 7, 11, 52, 135, 251, 333, 421, 610, 777, 905]) {
    it(`a save after step ${at} ends on the straight hash`, () => {
      let s = run(createState(SEED), 0, at);
      s = deserialize(serialize(s)).state;
      run(s, at, STEPS);
      expect(hashState(s)).toBe(want);
    });
  }

  it("a reload every 25 steps through the autosave path, with kept buffers, ends on the straight hash", () => {
    const capture = createCaptureBuffers();
    const out: SnapshotBuffer = { buffer: null };
    let s = createState(SEED);
    for (let at = 0; at < STEPS; at += 25) {
      run(s, at, at + 25);
      const bytes = finish(serializeDetachedSteps(captureState(s, capture), out)).slice();
      s = deserialize(bytes).state;
    }
    expect(hashState(s)).toBe(want);
  });

  it("the log replays to the straight hash", () => {
    expect(hashState(replay(SEED, straight.log, straight.tick))).toBe(want);
  });
});

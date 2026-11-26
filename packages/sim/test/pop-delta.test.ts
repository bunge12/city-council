import { describe, expect, it } from "vitest";
import {
  NO_WORK,
  PROTOCOL_VERSION,
  applyPopDelta,
  buildingIdLimit,
  buildingJobs,
  buildingPeople,
  countOccupancy,
  createState,
  drainPopDelta,
  hashMirrored,
  hashState,
  isBuilding,
  isPop,
  jobsFilled,
  parseToSimMessage,
  popIdLimit,
  popSizeCap,
  recordPopChanges,
  step,
  submit,
  type Occupancy,
  type SimState,
} from "../src/index";
import { FULL_DEMAND, holdDemand } from "./demand-helper";
import { removeBuilding } from "../src/buildings/buildings";
import { addPop, removePop, setPopProfile, setPopSize, setPopWork } from "../src/pops/pops";
import { nextInt, seedRng } from "../src/rng";
import { cloneState } from "../src/state";

// M3-05: each building's people and jobs filled in a delta, and the copy a
// client keeps of them.

let seq = 0;
function ok(state: SimState, type: string, payload: unknown): void {
  expect(submit(state, { seq: ++seq, playerId: "p1", type, payload }), type).toEqual({ ok: true });
  step(state);
}

const live = (state: SimState) => Array.from({ length: buildingIdLimit(state.buildings) }, (_, id) => id).filter((id) => isBuilding(state.buildings, id));
const homes = (state: SimState) => live(state).filter((id) => (state.buildings.residents[id] ?? 0) > 0);
const workplaces = (state: SimState) => live(state).filter((id) => buildingJobs(state.buildings, id) > 0);
const pops = (state: SimState) => Array.from({ length: popIdLimit(state.pops) }, (_, id) => id).filter((id) => isPop(state.pops, id));

/** A street zoned R1 north and C1 south, grown until homes and shops stand (seed 2026, build-road.test.ts). */
function city(): SimState {
  const state = createState(2026);
  ok(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" });
  ok(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] });
  ok(state, "ZoneCells", { zone: "commercial", density: 1, rects: [{ from: { x: 4202, z: 4629 }, to: { x: 4390, z: 4629 }, width: 44 }] });
  // Shops need commercial demand, which a city with no residents lacks (M3-07).
  holdDemand(FULL_DEMAND, () => {
    for (let t = 0; t < 6000 && (homes(state).length < 4 || workplaces(state).length < 2); t++) step(state);
  });
  expect(homes(state).length).toBeGreaterThanOrEqual(4);
  return state;
}

function change(state: SimState, rng: Uint32Array): void {
  const all = pops(state);
  const roll = nextInt(rng, 10);
  try {
    if (roll < 4 || all.length === 0) {
      const home = homes(state)[nextInt(rng, homes(state).length)] ?? 0;
      const room = Math.min(popSizeCap(1), (state.buildings.residents[home] ?? 0) - buildingPeople(state, home));
      if (room > 0) addPop(state, { home, size: 1 + nextInt(rng, room), education: nextInt(rng, 3), wealth: nextInt(rng, 3), children: nextInt(rng, 2), satisfaction: 50 });
      return;
    }
    const pop = all[nextInt(rng, all.length)] ?? 0;
    if (roll < 7) setPopWork(state, pop, nextInt(rng, 3) === 0 ? NO_WORK : (workplaces(state)[nextInt(rng, workplaces(state).length)] ?? NO_WORK));
    else if (roll < 8) setPopSize(state, pop, 1 + nextInt(rng, 3));
    else if (roll < 9) setPopProfile(state, pop, { education: 0, wealth: 1, children: nextInt(rng, 2) });
    else removePop(state, pop);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
}

function expectOccupancy(copy: Occupancy, state: SimState, label: string): void {
  for (let id = 0; id < Math.max(buildingIdLimit(state.buildings), copy.people.length); id++) {
    expect(copy.people[id] ?? 0, `${label}: people in ${id}`).toBe(buildingPeople(state, id));
    expect(copy.filled[id] ?? 0, `${label}: filled at ${id}`).toBe(jobsFilled(state, id));
  }
}

describe("people deltas", () => {
  it("bring a copy's people and jobs filled level with the sim, buildings removed with their pops included", () => {
    const state = city();
    recordPopChanges(state);
    let copy = countOccupancy(state);
    const rng = seedRng(9);
    let sent = 0;
    for (let round = 0; round < 300; round++) {
      for (let c = nextInt(rng, 5); c > 0; c--) change(state, rng);
      // Now and then a building goes, and its pops or its workers' jobs with it.
      if (round === 100) removeBuilding(state, homes(state).find((id) => buildingPeople(state, id) > 0) ?? -1);
      if (round === 200) removeBuilding(state, workplaces(state).find((id) => jobsFilled(state, id) > 0) ?? -1);
      const delta = drainPopDelta(state);
      if (delta) {
        sent += delta.ids.length;
        const applied = applyPopDelta(copy, delta, buildingIdLimit(state.buildings));
        if (typeof applied === "string") throw new Error(applied);
        copy = applied;
      }
      expectOccupancy(copy, state, `round ${round}`);
    }
    expect(sent).toBeGreaterThan(100);
    expect(pops(state).length).toBeGreaterThan(0);
  });

  it("give only the buildings whose numbers differ from the last drain", () => {
    const state = city();
    recordPopChanges(state);
    const [home] = homes(state);
    if (home === undefined) throw new Error("no home");
    // Nothing touched yet.
    expect(drainPopDelta(state)).toBeNull();
    const pop = addPop(state, { home, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 50 });
    expect(drainPopDelta(state)).toEqual({ ids: Int32Array.of(home), people: Int32Array.of(1), filled: Int32Array.of(0) });
    // Out and back in again before the next drain: nothing to say.
    removePop(state, pop);
    addPop(state, { home, size: 1, education: 2, wealth: 2, children: 1, satisfaction: 0 });
    expect(drainPopDelta(state)).toBeNull();
  });

  it("are not state: recording leaves the hash, the save and a replay alone", () => {
    const state = city();
    const before = hashState(state);
    recordPopChanges(state);
    addPop(state, { home: homes(state)[0] ?? 0, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 50 });
    const copy = cloneState(state);
    drainPopDelta(state);
    expect(hashState(state)).toBe(hashState(copy));
    expect(hashState(state)).not.toBe(before);
  });

  it("refuse a malformed delta, changing nothing", () => {
    const copy: Occupancy = { people: Int32Array.of(1, 2), filled: Int32Array.of(0, 0) };
    expect(applyPopDelta(copy, { ids: Int32Array.of(1, 0), people: Int32Array.of(1, 1), filled: Int32Array.of(0, 0) })).toMatch(/order/);
    expect(applyPopDelta(copy, { ids: Int32Array.of(-1), people: Int32Array.of(1), filled: Int32Array.of(0) })).toMatch(/range/);
    expect(applyPopDelta(copy, { ids: Int32Array.of(0), people: Int32Array.of(1, 2), filled: Int32Array.of(0) })).toMatch(/length/);
    expect(applyPopDelta(copy, { ids: Int32Array.of(0), people: Int32Array.of(-1), filled: Int32Array.of(0) })).toMatch(/fewer than no/);
    expect([...copy.people]).toEqual([1, 2]);
    // And grow the copy for a building past its end.
    const grown = applyPopDelta(copy, { ids: Int32Array.of(4), people: Int32Array.of(7), filled: Int32Array.of(3) });
    expect(typeof grown !== "string" && [...grown.people]).toEqual([1, 2, 0, 0, 7]);
  });

  it("a hash for a copy leaves out the pops and nothing else", () => {
    const state = city();
    const copy = cloneState(state);
    addPop(state, { home: homes(state)[0] ?? 0, size: 1, education: 0, wealth: 0, children: 0, satisfaction: 50 });
    state.pops.sweep = 1;
    copy.stats = cloneState(state).stats;
    expect(hashMirrored(copy)).toBe(hashMirrored(state));
    expect(hashState(copy)).not.toBe(hashState(state));
    copy.tick += 1;
    expect(hashMirrored(copy)).not.toBe(hashMirrored(state));
  });
});

describe("protocol version 17", () => {
  it("refuses a client on version 17, before the grower's plan left the deltas, with the usual message", () => {
    expect(PROTOCOL_VERSION).toBe(26);
    expect(parseToSimMessage({ v: 17, type: "requestSnapshot" })).toBe("protocol version 17 is not supported, expected 26");
    expect(parseToSimMessage({ v: 17, type: "command", command: { seq: 1, playerId: "p", type: "NoOp", payload: {} } })).toBe(
      "protocol version 17 is not supported, expected 26",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  LEVEL_BRIDGE,
  ROAD_TYPES,
  UNDO_STEPS,
  createState,
  deserialize,
  hashState,
  planUndo,
  serialize,
  step,
  submit,
  type Command,
  type CommandResult,
  type SimState,
} from "../src/index";
import { cloneState } from "../src/state";
import { applyRoadDelta, drainRoadChanges, encodeRoadDelta, recordRoadChanges } from "../src/roads/delta";
import {
  checkRoadNetwork,
  isNode,
  isSegment,
  nodeCount,
  nodeIdLimit,
  segmentCount,
  segmentIdLimit,
  segmentsAt,
  type RoadNetwork,
} from "../src/roads/network";
import { buildRoadIndex, roadIndexOf } from "../src/roads/spatial";
import { heldIds } from "../src/undo";
import fixtureJson from "./fixtures/replay/undo.json";
import { expectReplay, type ReplayFixture } from "./replay-helper";

const fixture = fixtureJson as ReplayFixture;

// Issue M1-14: Undo.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts), and an inlet along z = 6600 from x = 3488 to 3600
// (bridges.test.ts).
const SEED = 2026;

const seqs = new Map<string, number>();
function command(type: string, payload: unknown, playerId = "p1"): Command {
  const seq = (seqs.get(playerId) ?? 0) + 1;
  seqs.set(playerId, seq);
  return { seq, playerId, type, payload };
}

function road(from: [number, number], to: [number, number], type = "street", playerId = "p1", control?: [number, number]): Command {
  const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type };
  return command("BuildRoad", control ? { ...payload, control: { x: control[0], z: control[1] } } : payload, playerId);
}

const bulldoze = (segments: number[], playerId = "p1") => command("BulldozeRoad", { segments }, playerId);
const upgrade = (type: string, segments: number[], playerId = "p1", from?: number[]) =>
  command("UpgradeRoad", from ? { segments, type, from } : { segments, type }, playerId);
const undo = (playerId = "p1") => command("Undo", {}, playerId);

function run(state: SimState, c: Command): CommandResult {
  const result = submit(state, c);
  step(state);
  return result;
}

function ok(state: SimState, c: Command): void {
  expect(run(state, c)).toEqual({ ok: true });
}

function refusal(state: SimState, c: Command): string {
  const result = run(state, c);
  expect(result.ok, "the command should be refused").toBe(false);
  return result.ok ? "" : result.reason;
}

/** The state hash leaving out the log and the undo history, and the tick, which every step moves. */
function cityHash(state: SimState): string {
  return hashState({ ...state, tick: 0, log: [], logOffset: 0, undo: [] });
}

function findNode(net: RoadNetwork, x: number, z: number): number {
  for (let id = 0; id < nodeIdLimit(net); id++) if (isNode(net, id) && net.nodeX[id] === x && net.nodeZ[id] === z) return id;
  throw new Error(`no node at (${x}, ${z})`);
}

function liveSegments(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

/** The segment between the nodes at two points. */
function segmentBetween(net: RoadNetwork, p: [number, number], q: [number, number]): number {
  const a = findNode(net, p[0], p[1]);
  const b = findNode(net, q[0], q[1]);
  const seg = segmentsAt(net, a).find((s) => net.segA[s] === b || net.segB[s] === b);
  if (seg === undefined) throw new Error("no segment there");
  return seg;
}

function sound(state: SimState): void {
  expect(checkRoadNetwork(state.roads, heldIds(state.undo))).toBeNull();
  const fresh = buildRoadIndex(state.roads);
  expect(roadIndexOf(state.roads).segCells).toEqual(fresh.segCells);
  expect(roadIndexOf(state.roads).nodeCells).toEqual(fresh.nodeCells);
}

/** Two parallel east-west streets, at z = 4450 and z = 4550. */
function parallels(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4450], [4500, 4450]));
  ok(state, road([4200, 4550], [4500, 4550]));
  return state;
}

describe("Undo of BuildRoad", () => {
  it("takes back a road on open ground, leaving the network byte for byte as before", () => {
    const state = createState(SEED);
    const before = cityHash(state);
    ok(state, road([4200, 4500], [4500, 4500]));
    expect(segmentCount(state.roads)).toBe(1);
    ok(state, undo());
    expect(segmentCount(state.roads)).toBe(0);
    expect(nodeIdLimit(state.roads)).toBe(0);
    expect(cityHash(state)).toBe(before);
    expect(state.undo).toEqual([]);
    sound(state);
  });

  it("rejoins two segments a build split, and the hash matches the one before the build", () => {
    const state = parallels();
    const before = cityHash(state);
    const roads = cloneState(state).roads;
    ok(state, road([4300, 4400], [4300, 4600]));
    // The new road crosses both streets in their bodies, so each splits in two.
    expect(segmentCount(state.roads)).toBe(7);
    expect(segmentsAt(state.roads, findNode(state.roads, 4300, 4450))).toHaveLength(4);
    expect(segmentsAt(state.roads, findNode(state.roads, 4300, 4550))).toHaveLength(4);
    ok(state, undo());
    expect(state.roads).toEqual(roads);
    expect(cityHash(state)).toBe(before);
    sound(state);
  });

  it("rejoins a curve it split into two curves, exactly", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4500, 4600], "street", "p1", [4350, 4450]));
    const before = cityHash(state);
    ok(state, road([4350, 4400], [4350, 4700]));
    expect(segmentCount(state.roads)).toBe(4);
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
    sound(state);
  });

  it("takes back a T-junction on a road's body and a road that joined an existing node", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    const start = cityHash(state);
    ok(state, road([4300, 4500], [4300, 4700]));
    const afterT = cityHash(state);
    ok(state, road([4300, 4700], [4500, 4500]));
    ok(state, undo());
    expect(cityHash(state)).toBe(afterT);
    ok(state, undo());
    expect(cityHash(state)).toBe(start);
    sound(state);
  });

  it("takes back a bridge", () => {
    const state = createState(SEED);
    const before = cityHash(state);
    ok(state, road([3400, 6600], [3700, 6600]));
    expect([...state.roads.segLevel]).toContain(LEVEL_BRIDGE);
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
    sound(state);
  });
});

describe("Undo of BulldozeRoad", () => {
  it("puts the segments and the nodes they left back under the same ids", () => {
    const state = parallels();
    ok(state, road([4300, 4400], [4300, 4600]));
    const before = cityHash(state);
    const net = state.roads;
    const middle = segmentBetween(net, [4300, 4450], [4300, 4550]);
    const top = segmentBetween(net, [4300, 4400], [4300, 4450]);
    ok(state, bulldoze([middle, top]));
    expect(isSegment(net, middle)).toBe(false);
    expect(() => findNode(net, 4300, 4400)).toThrow();
    // Held for the undo: not free, so nothing else takes them meanwhile.
    expect([...net.segFree]).not.toContain(middle);
    expect(heldIds(state.undo).segs).toEqual([middle, top].sort((a, b) => a - b));
    sound(state);
    ok(state, road([4600, 4500], [4600, 4700]));
    expect(isSegment(net, middle)).toBe(false);
    ok(state, undo());
    ok(state, undo());
    expect(isSegment(net, middle)).toBe(true);
    expect(isSegment(net, top)).toBe(true);
    expect(cityHash(state)).toBe(before);
    sound(state);
  });

  it("puts back a whole network bulldozed at once", () => {
    const state = parallels();
    ok(state, road([4300, 4400], [4300, 4600], "avenue"));
    ok(state, road([4250, 4600], [4450, 4800], "oneWay", "p1", [4400, 4650]));
    const before = cityHash(state);
    ok(state, bulldoze(liveSegments(state.roads)));
    expect(segmentCount(state.roads)).toBe(0);
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
    sound(state);
  });
});

describe("Undo of UpgradeRoad", () => {
  it("restores the old type", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    const before = cityHash(state);
    ok(state, upgrade("avenue", [0]));
    expect(state.roads.segType[0]).toBe(ROAD_TYPES.findIndex((t) => t.id === "avenue"));
    ok(state, undo());
    expect(cityHash(state)).toBe(before);
  });

  it("turns a one-way back round, and back into a street", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    const start = cityHash(state);
    const b = state.roads.segB[0] ?? -1;
    ok(state, upgrade("oneWay", [0], "p1", [b]));
    const oneWay = cityHash(state);
    expect(state.roads.segA[0]).toBe(b);
    ok(state, upgrade("oneWay", [0]));
    expect(state.roads.segB[0]).toBe(b);
    ok(state, undo());
    expect(cityHash(state)).toBe(oneWay);
    ok(state, undo());
    expect(cityHash(state)).toBe(start);
    sound(state);
  });
});

describe("Undo across players", () => {
  it("takes back only the sender's own commands, newest first", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4450], [4500, 4450], "street", "p1"));
    ok(state, road([4200, 4550], [4500, 4550], "street", "p2"));
    ok(state, road([4200, 4650], [4500, 4650], "street", "p1"));
    const net = state.roads;
    ok(state, undo("p2"));
    expect(() => findNode(net, 4200, 4550)).toThrow();
    expect(findNode(net, 4200, 4450)).toBeGreaterThanOrEqual(0);
    expect(findNode(net, 4200, 4650)).toBeGreaterThanOrEqual(0);
    expect(refusal(state, undo("p2"))).toBe("Nothing to undo");
    ok(state, undo("p1"));
    expect(() => findNode(net, 4200, 4650)).toThrow();
    expect(findNode(net, 4200, 4450)).toBeGreaterThanOrEqual(0);
    ok(state, undo("p1"));
    expect(segmentCount(net)).toBe(0);
    sound(state);
  });

  it("is recorded in the activity log with the sender", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    ok(state, undo());
    expect(state.log.map((e) => [e.type, e.playerId])).toEqual([
      ["BuildRoad", "p1"],
      ["Undo", "p1"],
    ]);
  });

  it("ties each record to its command's log entry", () => {
    const state = createState(SEED);
    ok(state, command("SetSpeed", { speed: 2 }));
    ok(state, road([4200, 4500], [4500, 4500]));
    expect(state.undo.map((r) => [r.entry, r.type, r.playerId])).toEqual([[1, "BuildRoad", "p1"]]);
    expect(state.log[1]?.type).toBe("BuildRoad");
  });
});

describe("An undo that is no longer valid", () => {
  function refusedAndUnchanged(state: SimState, playerId: string, reason: RegExp): void {
    const hash = hashState(state);
    const history = state.undo;
    const result = submit(state, undo(playerId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
    expect(state.pending).toEqual([]);
    expect(hashState(state)).toBe(hash);
    expect(state.undo).toBe(history);
  }

  it("is refused when another road now joins a junction it would remove", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "street", "p1"));
    ok(state, road([4500, 4500], [4500, 4700], "street", "p2"));
    refusedAndUnchanged(state, "p1", /another road now joins/);
    // It stays at the top of p1's history, so trying again gives the same answer.
    refusedAndUnchanged(state, "p1", /another road now joins/);
    // Once the other road goes, the undo works again.
    ok(state, undo("p2"));
    ok(state, undo("p1"));
    expect(segmentCount(state.roads)).toBe(0);
    sound(state);
  });

  it("is refused when a split node it would remove now has another road", () => {
    const state = parallels();
    ok(state, road([4300, 4400], [4300, 4600], "street", "p1"));
    ok(state, road([4300, 4450], [4100, 4450 - 100], "street", "p2"));
    refusedAndUnchanged(state, "p1", /another road now joins/);
  });

  it("is refused when someone else changed or removed the road", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "street", "p1"));
    ok(state, upgrade("avenue", [0], "p2"));
    refusedAndUnchanged(state, "p1", /changed or removed/);
    ok(state, bulldoze([0], "p2"));
    refusedAndUnchanged(state, "p1", /changed or removed/);
  });

  it("is refused when a road built since is in the way of what it would put back", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "street", "p1"));
    ok(state, bulldoze([0], "p1"));
    ok(state, road([4300, 4400], [4300, 4600], "street", "p2"));
    refusedAndUnchanged(state, "p1", /in the way/);
    // A road that ends where a removed node stood is in the way too.
    ok(state, undo("p2"));
    ok(state, road([4200, 4500], [4200, 4700], "street", "p2"));
    refusedAndUnchanged(state, "p1", /in the way/);
    ok(state, undo("p2"));
    ok(state, undo("p1"));
    expect(segmentCount(state.roads)).toBe(1);
    sound(state);
  });

  it("is refused with nothing to undo, and SetSpeed leaves nothing to undo", () => {
    const state = createState(SEED);
    expect(planUndo(state, "p1")).toEqual({ ok: false, reason: "Nothing to undo" });
    ok(state, command("SetSpeed", { speed: 4 }));
    expect(refusal(state, undo())).toBe("Nothing to undo");
    expect(state.speed).toBe(4);
  });

  it("is dropped at apply time when an earlier command in the same tick made it invalid", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "street", "p1"));
    expect(submit(state, road([4500, 4500], [4500, 4700], "street", "p2"))).toEqual({ ok: true });
    expect(submit(state, undo("p1"))).toEqual({ ok: true });
    step(state);
    expect(state.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoad"]);
    expect(segmentCount(state.roads)).toBe(2);
  });
});

describe("Undo history", () => {
  it(`keeps at most ${UNDO_STEPS} steps per player and frees what the forgotten ones held`, () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500], "street", "p2"));
    for (let i = 0; i <= UNDO_STEPS; i++) {
      // Bulldoze and rebuild, so each record holds ids.
      ok(state, road([4200, 4600], [4500, 4600]));
      const seg = segmentBetween(state.roads, [4200, 4600], [4500, 4600]);
      ok(state, bulldoze([seg]));
    }
    expect(state.undo.filter((r) => r.playerId === "p1")).toHaveLength(UNDO_STEPS);
    expect(state.undo.filter((r) => r.playerId === "p2")).toHaveLength(1);
    sound(state);
    for (let i = 0; i < UNDO_STEPS; i++) ok(state, undo("p1"));
    expect(refusal(state, undo("p1"))).toBe("Nothing to undo");
    ok(state, undo("p2"));
    sound(state);
  });

  it("survives a save and load, and undoes the same afterwards", () => {
    const state = parallels();
    ok(state, road([4300, 4400], [4300, 4600]));
    ok(state, bulldoze([segmentBetween(state.roads, [4300, 4450], [4300, 4550])]));
    const { state: loaded } = deserialize(serialize(state));
    expect(hashState(loaded)).toBe(hashState(state));
    const undos = [undo(), undo()];
    for (const s of [state, loaded]) for (const u of undos) ok(s, u);
    expect(hashState(loaded)).toBe(hashState(state));
    sound(loaded);
  });

  it("refuses a save whose undo record holds a live id", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4500], [4500, 4500]));
    ok(state, bulldoze([0]));
    ok(state, road([4200, 4600], [4500, 4600]));
    expect(isSegment(state.roads, 1)).toBe(true);
    // Pretend the bulldoze record holds the new road's segment instead.
    const broken = cloneState(state);
    broken.undo = broken.undo.map((r) => ({ ...r, ops: r.ops.map((op) => (op.op === "removeSeg" ? { ...op, id: 1 } : op)) }));
    expect(() => deserialize(serialize(broken))).toThrow(/road network is malformed: held id 1/);
    const malformed = cloneState(state);
    malformed.undo = [{ playerId: "p1", entry: 0, type: "BuildRoad", ops: [{ op: "explode" }] }] as unknown as SimState["undo"];
    expect(() => deserialize(serialize(malformed))).toThrow(/undo history is malformed/);
  });
});

describe("Undo and the client's copy", () => {
  it("brings a copy kept by deltas to the same network, shrinking it when the newest ids go", () => {
    const state = parallels();
    recordRoadChanges(state.roads);
    const copy = cloneState(state).roads;
    const sync = () => {
      const changes = drainRoadChanges(state.roads);
      if (changes) expect(applyRoadDelta(copy, encodeRoadDelta(state.roads, changes))).not.toBeTypeOf("string");
      expect(copy).toEqual(state.roads);
    };
    ok(state, road([4300, 4400], [4300, 4600]));
    sync();
    ok(state, bulldoze([segmentBetween(state.roads, [4300, 4450], [4300, 4550])]));
    sync();
    ok(state, undo());
    sync();
    ok(state, undo());
    sync();
    expect(segmentIdLimit(copy)).toBe(2);
    // Several steps in one delta, as a host merges them.
    ok(state, road([4250, 4400], [4250, 4600]));
    ok(state, undo());
    sync();
    expect(nodeCount(copy)).toBe(4);
  });
});

/**
 * The commands behind fixtures/replay/undo.json, stepped live. Two players
 * build, split, upgrade and bulldoze, and undo out of order with each
 * other. One undo is refused and so not logged.
 */
function playUndoFixture(): SimState {
  const state = createState(SEED);
  let n = 0;
  const c = (playerId: string, type: string, payload: unknown): Command => ({ seq: ++n, playerId, type, payload });
  const build = (playerId: string, from: [number, number], to: [number, number], type = "street") =>
    c(playerId, "BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type });
  const send = (command: Command, accepted = true) => {
    const result = submit(state, command);
    expect(result.ok, `${command.playerId} ${command.type}: ${result.ok ? "accepted" : result.reason}`).toBe(accepted);
  };
  const tick = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) step(state);
  };
  send(build("p1", [4200, 4450], [4500, 4450]));
  send(build("p1", [4200, 4550], [4500, 4550]));
  tick(2);
  send(build("p2", [4300, 4400], [4300, 4600], "avenue"));
  tick();
  const net = state.roads;
  send(c("p1", "UpgradeRoad", { segments: [segmentBetween(net, [4200, 4450], [4300, 4450])], type: "oneWay" }));
  send(c("p2", "BulldozeRoad", { segments: [segmentBetween(net, [4300, 4450], [4300, 4550])] }));
  tick(3);
  // p1's newest is the upgrade, which nothing has touched.
  send(c("p1", "Undo", {}));
  tick();
  // p2's build split p1's streets; p2 bulldozed part of it, so undo that first.
  send(c("p2", "Undo", {}));
  tick();
  send(build("p1", [4400, 4400], [4400, 4600]));
  tick();
  // p1's new road split the street pieces p2's build made, so p2 cannot
  // take its build back until p1 takes that road back.
  send(c("p2", "Undo", {}), false);
  tick(2);
  send(c("p1", "Undo", {}));
  tick();
  send(c("p2", "Undo", {}));
  tick(4);
  return state;
}

describe("replay fixture undo", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log.filter((e) => e.type === "Undo")).toHaveLength(4);
    expect(state.undo.map((r) => [r.playerId, r.type])).toEqual([
      ["p1", "BuildRoad"],
      ["p1", "BuildRoad"],
    ]);
  });

  it("matches the same commands stepped live", () => {
    const live = playUndoFixture();
    expect(live.log).toEqual(fixture.log);
    expect(live.tick).toBe(fixture.untilTick);
    expect(hashState(live)).toBe(fixture.hash);
  });
});

import { describe, expect, it } from "vitest";
import {
  createState,
  deserialize,
  hashState,
  serialize,
  step,
  submit,
  type Command,
  type SimState,
} from "../src/index";
import { cloneState } from "../src/state";
import { applyRoadDelta, drainRoadChanges, encodeRoadDelta, recordRoadChanges } from "../src/roads/delta";
import { checkRoadNetwork, isSegment, segmentIdLimit, type RoadNetwork } from "../src/roads/network";
import { heldIds } from "../src/undo";

// M2-01: every segment knows how old it is. A lower build order number is an
// older segment.

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
const road = (from: [number, number], to: [number, number], type = "street", playerId = "p1") =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type }, playerId);
const bulldoze = (segments: number[], playerId = "p1") => command("BulldozeRoad", { segments }, playerId);
const upgrade = (type: string, segments: number[], playerId = "p1") => command("UpgradeRoad", { segments, type }, playerId);
const undo = (playerId = "p1") => command("Undo", {}, playerId);

function ok(state: SimState, c: Command): void {
  expect(submit(state, c)).toEqual({ ok: true });
  step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

/** Live segment ids, ascending. */
function live(net: RoadNetwork): number[] {
  const out: number[] = [];
  for (let id = 0; id < segmentIdLimit(net); id++) if (isSegment(net, id)) out.push(id);
  return out;
}

/** The live segment with both ends at these points, either way round. */
function between(net: RoadNetwork, p: [number, number], q: [number, number]): number {
  const at = (node: number, [x, z]: [number, number]) => net.nodeX[node] === x && net.nodeZ[node] === z;
  const seg = live(net).find((s) => {
    const a = net.segA[s] ?? -1;
    const b = net.segB[s] ?? -1;
    return (at(a, p) && at(b, q)) || (at(a, q) && at(b, p));
  });
  if (seg === undefined) throw new Error(`no segment from ${p.join(",")} to ${q.join(",")}`);
  return seg;
}

const order = (net: RoadNetwork, seg: number) => net.segOrder[seg];

describe("segment build order", () => {
  it("numbers the outside connections from 0 in a new city", () => {
    const state = createState(SEED);
    const net = state.roads;
    expect(live(net).map((s) => order(net, s))).toEqual(live(net).map((_, i) => i));
    expect(net.segOrderNext).toBe(live(net).length);
  });

  it("gives a new segment the next number, and each piece of a new road its own", () => {
    const state = createState(SEED);
    const net = state.roads;
    const first = net.segOrderNext;
    ok(state, road([4200, 4600], [4600, 4600]));
    expect(order(net, between(net, [4200, 4600], [4600, 4600]))).toBe(first);
    // A street with a junction on the first one is two pieces, built in order.
    ok(state, road([4300, 4500], [4300, 4700]));
    expect(order(net, between(net, [4300, 4500], [4300, 4600]))).toBe(first + 1);
    expect(order(net, between(net, [4300, 4600], [4300, 4700]))).toBe(first + 2);
    expect(net.segOrderNext).toBe(first + 3);
  });

  it("gives both pieces of a split the number of the segment they were cut from", () => {
    const state = createState(SEED);
    const net = state.roads;
    ok(state, road([4200, 4600], [4600, 4600]));
    const old = order(net, between(net, [4200, 4600], [4600, 4600]));
    // Something newer, so the split pieces are not simply the newest number.
    ok(state, road([4200, 4800], [4600, 4800]));
    const crossing = net.segOrderNext;
    ok(state, road([4400, 4500], [4400, 4700]));
    expect(order(net, between(net, [4200, 4600], [4400, 4600]))).toBe(old);
    expect(order(net, between(net, [4400, 4600], [4600, 4600]))).toBe(old);
    // The crossing street is the newest: its two pieces take new numbers.
    expect(order(net, between(net, [4400, 4500], [4400, 4600]))).toBe(crossing);
    expect(order(net, between(net, [4400, 4600], [4400, 4700]))).toBe(crossing + 1);
    expect(net.segOrderNext).toBe(crossing + 2);
  });

  it("keeps a segment's number through an upgrade and a reverse", () => {
    const state = createState(SEED);
    const net = state.roads;
    ok(state, road([4200, 4600], [4600, 4600]));
    const seg = between(net, [4200, 4600], [4600, 4600]);
    const was = order(net, seg);
    const next = net.segOrderNext;
    ok(state, upgrade("avenue", [seg]));
    expect(order(net, seg)).toBe(was);
    ok(state, upgrade("oneWay", [seg]));
    const a = net.segA[seg];
    // Upgrading a one-way to its own type reverses it.
    ok(state, upgrade("oneWay", [seg]));
    expect(net.segB[seg]).toBe(a);
    expect(order(net, seg)).toBe(was);
    expect(net.segOrderNext).toBe(next);
  });

  it("brings a bulldozed segment back with its number, and the counter does not move", () => {
    const state = createState(SEED);
    const net = state.roads;
    ok(state, road([4200, 4600], [4600, 4600]));
    ok(state, road([4400, 4500], [4400, 4700]));
    const west = between(net, [4200, 4600], [4400, 4600]);
    const was = order(net, west);
    const next = net.segOrderNext;
    ok(state, bulldoze([west]));
    expect(isSegment(net, west)).toBe(false);
    // The undo journal keeps it.
    const removed = state.undo.at(-1)?.ops.find((op) => op.op === "removeSeg" && op.id === west);
    expect(removed?.op === "removeSeg" && removed.row.order).toBe(was);
    ok(state, road([4200, 4800], [4600, 4800]));
    ok(state, undo());
    // The newer street is p1's newest change, so it went first.
    expect(isSegment(net, west)).toBe(false);
    expect(net.segOrderNext).toBe(next);
    ok(state, undo());
    expect(isSegment(net, west)).toBe(true);
    expect(order(net, west)).toBe(was);
    expect(net.segOrderNext).toBe(next);
    expect(checkRoadNetwork(net, heldIds(state.undo))).toBeNull();
  });

  it("gives back the numbers a build took when it is undone with nothing in between", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4600, 4600]));
    const before = cloneState(state).roads;
    // A crossing splits the first street and takes two numbers.
    ok(state, road([4400, 4500], [4400, 4700]));
    ok(state, undo());
    expect(state.roads).toEqual(before);
  });

  it("keeps a newer player's number when an older build is undone, so no two roads share one", () => {
    const state = createState(SEED);
    const net = state.roads;
    ok(state, road([4200, 4600], [4600, 4600], "street", "p1"));
    ok(state, road([4200, 4800], [4600, 4800], "street", "p2"));
    const next = net.segOrderNext;
    ok(state, undo("p1"));
    expect(net.segOrderNext).toBe(next);
    ok(state, road([4200, 4700], [4600, 4700], "street", "p1"));
    expect(order(net, between(net, [4200, 4700], [4600, 4700]))).toBe(next);
  });

  it("is carried by a road delta, so a client copy keeps the counter", () => {
    const state = createState(SEED);
    const copy = cloneState(state).roads;
    recordRoadChanges(state.roads);
    ok(state, road([4200, 4600], [4600, 4600]));
    ok(state, road([4400, 4500], [4400, 4700]));
    const changes = drainRoadChanges(state.roads);
    if (!changes) throw new Error("no changes");
    expect(applyRoadDelta(copy, encodeRoadDelta(state.roads, changes))).not.toBeTypeOf("string");
    expect(copy).toEqual(state.roads);
  });

  it("refuses a loaded network with a number at or past its counter", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4600], [4600, 4600]));
    const net = cloneState(state).roads;
    net.segOrderNext -= 1;
    expect(checkRoadNetwork(net)).toMatch(/bad build order/);
    expect(checkRoadNetwork({ ...state.roads, segOrderNext: 1.5 })).toMatch(/segOrderNext/);
  });
});

describe("a city saved and reloaded mid-run", () => {
  it("hashes the same as one that never stopped", () => {
    // Each command is made from the city it is about to go into, since the
    // upgrade and the bulldoze name a piece of a split road by its id.
    const west = (net: RoadNetwork) => [between(net, [4200, 4600], [4400, 4600])];
    const commands: ((net: RoadNetwork) => Command)[] = [
      () => road([4200, 4600], [4600, 4600]),
      () => road([4200, 4800], [4600, 4800], "street", "p2"),
      () => road([4400, 4500], [4400, 4900]),
      (net) => upgrade("avenue", west(net)),
      (net) => bulldoze(west(net), "p2"),
      () => undo("p2"),
      () => road([4300, 4500], [4300, 4900], "avenue", "p2"),
      () => road([4500, 4500], [4500, 4900]),
      () => undo("p2"),
    ];
    const straight = createState(SEED);
    let reloaded = createState(SEED);
    commands.forEach((make, i) => {
      const c = make(straight.roads);
      ok(straight, c);
      ok(reloaded, c);
      if (i === 3) reloaded = deserialize(serialize(reloaded)).state;
    });
    expect(hashState(reloaded)).toBe(hashState(straight));
    expect(reloaded.roads.segOrderNext).toBe(straight.roads.segOrderNext);
  });
});

import { describe, expect, it } from "vitest";
import {
  CONNECTION_BALANCE,
  NONE,
  connectionEnd,
  connectionStub,
  createBareState,
  createState,
  nodeReachesOutside,
  segmentReachesOutside,
  segmentsReachingOutside,
  step,
  submit,
  type Command,
  type SimState,
} from "../src/index";
import { NETWORK_RAIL, NETWORK_ROAD, SEG_FIXED, addNode, addSegment, isNode, isSegment, nodeIdLimit, segmentIdLimit, segmentsAt, otherEnd } from "../src/roads/network";
import { growNetwork, churnNetwork } from "./road-network-helper";
import { cloneState } from "../src/state";
import { withEnds } from "./seen-ends";

// M3-06: whether a piece of the road network has a route to an outside
// connection, a derived answer per connected piece, kept current as roads change.

let seq = 0;
function command(state: SimState, type: string, payload: unknown): { ok: boolean } {
  const c: Command = { seq: ++seq, playerId: "p1", type, payload };
  const result = submit(state, c);
  step(state);
  return result;
}

/** Where the street from connection `i`'s stub end ends, `metres` beyond it. */
function fromStub(state: SimState, i: number, metres: number): { from: { x: number; z: number }; to: { x: number; z: number } } {
  const r = state.roads;
  const edge = state.connections[i] ?? NONE;
  const inner = connectionEnd(r, edge);
  const ix = r.nodeX[inner] ?? 0;
  const iz = r.nodeZ[inner] ?? 0;
  const dx = (ix - (r.nodeX[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  const dz = (iz - (r.nodeZ[edge] ?? 0)) / CONNECTION_BALANCE.stubLength;
  return { from: { x: ix, z: iz }, to: { x: ix + dx * metres, z: iz + dz * metres } };
}

/** The answer worked out from nothing: a walk over the road segments from every connection, either way along each. */
function walked(state: SimState): Uint8Array {
  const r = state.roads;
  const seen = new Uint8Array(nodeIdLimit(r));
  const queue: number[] = [];
  for (const edge of state.connections) {
    if (isNode(r, edge) && !seen[edge]) {
      seen[edge] = 1;
      queue.push(edge);
    }
  }
  while (queue.length > 0) {
    const node = queue.pop() ?? NONE;
    for (const seg of segmentsAt(r, node)) {
      if (r.segNetwork[seg] !== NETWORK_ROAD) continue;
      const next = otherEnd(r, seg, node);
      if (!seen[next]) {
        seen[next] = 1;
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Checks every node and segment against a walk from the connections, and the count of segments against one made by hand. */
function expectSound(state: SimState): void {
  const r = state.roads;
  const seen = walked(state);
  for (let n = 0; n < nodeIdLimit(r); n++) expect(nodeReachesOutside(state, n), `node ${n}`).toBe(isNode(r, n) && seen[n] === 1);
  let count = 0;
  for (let s = 0; s < segmentIdLimit(r); s++) {
    const reaches = isSegment(r, s) && r.segNetwork[s] === NETWORK_ROAD && seen[r.segA[s] ?? 0] === 1;
    expect(segmentReachesOutside(state, s), `segment ${s}`).toBe(reaches);
    // The connections' stubs are the only fixed segments.
    if (reaches && ((r.segFlags[s] ?? 0) & SEG_FIXED) === 0) count++;
  }
  expect(segmentsReachingOutside(state)).toBe(count);
  // A fresh copy, with nothing cached, agrees.
  expect(segmentsReachingOutside(cloneState(state))).toBe(count);
}

describe("which pieces of road reach outside", () => {
  it("counts only the stubs as reaching outside in a new city, and nothing the player built", () => {
    const state = createState(2026);
    expect(state.connections.length).toBeGreaterThan(0);
    for (const edge of state.connections) {
      expect(nodeReachesOutside(state, edge)).toBe(true);
      expect(segmentReachesOutside(state, connectionStub(state.roads, edge))).toBe(true);
    }
    expect(segmentsReachingOutside(state)).toBe(0);
    expectSound(state);
  });

  it("says a street from a stub reaches outside and a loose one does not, and follows a join and a bulldoze", () => {
    const state = createState(2026);
    const street = fromStub(state, 0, 300);
    expect(command(state, "BuildRoad", { ...street, type: "street" }).ok).toBe(true);
    const joined = segmentIdLimit(state.roads) - 1;
    // Across the street's far end, 150 m to one side, and 200 m along from there.
    const dx = (street.to.x - street.from.x) / 300;
    const dz = (street.to.z - street.from.z) / 300;
    const side = { x: street.to.x - dz * 150, z: street.to.z + dx * 150 };
    const along = { x: side.x + dx * 200, z: side.z + dz * 200 };
    expect(segmentReachesOutside(state, joined)).toBe(true);
    expect(segmentsReachingOutside(state)).toBe(1);

    expect(command(state, "BuildRoad", { from: side, to: along, type: "street" }).ok).toBe(true);
    const loose = segmentIdLimit(state.roads) - 1;
    expect(segmentReachesOutside(state, loose)).toBe(false);
    expect(nodeReachesOutside(state, state.roads.segA[loose] ?? NONE)).toBe(false);
    expectSound(state);

    // Joined to the street from the stub, the loose one reaches outside too.
    const link = { from: street.to, to: side, type: "street" };
    expect(command(state, "BuildRoad", link).ok).toBe(true);
    expect(segmentReachesOutside(state, loose)).toBe(true);
    expectSound(state);

    // Undo the link and it is cut off again.
    expect(command(state, "Undo", {}).ok).toBe(true);
    expect(segmentReachesOutside(state, loose)).toBe(false);
    expectSound(state);

    // Bulldoze the street from the stub and nothing the player built reaches outside.
    const bulldozed = command(state, "BulldozeRoad", withEnds(state.roads, { segments: [joined] }));
    expect(bulldozed).toEqual({ ok: true });
    expect(segmentsReachingOutside(state)).toBe(0);
    expectSound(state);
  });

  it("leaves rail out, and a removed or made-up segment reaches nothing", () => {
    const state = createState(2026);
    const r = state.roads;
    const edge = state.connections[0] ?? NONE;
    const inner = connectionEnd(r, edge);
    const far = addNode(r, (r.nodeX[inner] ?? 0) + 50, r.nodeZ[inner] ?? 0, 0);
    const rail = addSegment(r, inner, far, { type: 0, network: NETWORK_RAIL });
    expect(segmentReachesOutside(state, rail)).toBe(false);
    expect(nodeReachesOutside(state, far)).toBe(false);
    for (const id of [-1, 1.5, segmentIdLimit(r) + 3]) expect(segmentReachesOutside(state, id)).toBe(false);
    for (const id of [-1, 1.5, nodeIdLimit(r) + 3]) expect(nodeReachesOutside(state, id)).toBe(false);
    expectSound(state);
  });

  it("agrees with a walk from the connections after many random changes of roads, rail and paths", () => {
    const state = createState(2026);
    // Built before the changes, so it has to keep up with them.
    expect(segmentsReachingOutside(state)).toBe(0);
    const stubEnds = [...state.connections].map((edge) => connectionEnd(state.roads, edge));
    const first = nodeIdLimit(state.roads);
    growNetwork(state.roads, 7, 400);
    // Join the stub ends to random roads.
    stubEnds.forEach((end, i) => {
      let to = first + 5 * i;
      while (!isNode(state.roads, to)) to++;
      addSegment(state.roads, end, to, { type: 0 });
    });
    expectSound(state);
    expect(segmentsReachingOutside(state)).toBeGreaterThan(0);
    churnNetwork(state.roads, 11, 300);
    expectSound(state);
  });

  it("works on a city with no connections at all", () => {
    const state = createBareState(5);
    const a = addNode(state.roads, 100, 100, 0);
    const b = addNode(state.roads, 200, 100, 0);
    const s = addSegment(state.roads, a, b, { type: 0 });
    expect(segmentReachesOutside(state, s)).toBe(false);
    expect(segmentsReachingOutside(state)).toBe(0);
  });
});

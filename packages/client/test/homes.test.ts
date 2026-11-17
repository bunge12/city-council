// Issue M2-18: the homes figure in the top bar, counted in the client from
// its copy of the city and moved by each building delta. Run against the
// same SimHost the worker runs, with an in-memory transport and a fake
// clock, so the grower, the bulldozer and undo all send real deltas.
import { describe, expect, it } from "vitest";
import {
  SEG_FIXED,
  ZONING_BALANCE,
  buildingCount,
  createState,
  isBuilding,
  segmentEnds,
  segmentTypeId,
  step,
  submit,
  type SimState,
} from "@city-council/sim";
import { countHomes, homesBefore } from "../src/protocol/homes";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { formatHomesTitle } from "../src/ui/format";

const SEED = 2026;
const RESIDENTIAL = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;

function run(state: SimState, type: string, payload: unknown, seq: { n: number }): void {
  const result = submit(state, { seq: ++seq.n, playerId: "fixture", type, payload });
  if (!result.ok) throw new Error(`fixture ${type} refused: ${result.reason}`);
  step(state);
}

/**
 * A street along z = 4600 from x = 4200 to 4392, zoned R1 on its north side
 * and C1 on its south side, grown until at least six buildings stand.
 */
function city(): SimState {
  const state = createState(SEED);
  const seq = { n: 0 };
  run(state, "BuildRoad", { from: { x: 4200, z: 4600 }, to: { x: 4392, z: 4600 }, type: "street" }, seq);
  run(state, "ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z: 4571 }, to: { x: 4390, z: 4571 }, width: 44 }] }, seq);
  run(state, "ZoneCells", { zone: "commercial", density: 1, rects: [{ from: { x: 4202, z: 4629 }, to: { x: 4390, z: 4629 }, width: 44 }] }, seq);
  for (let t = 0; t < 6000 && buildingCount(state.buildings) < 6; t++) step(state);
  if (buildingCount(state.buildings) < 6) throw new Error("the buildings did not grow");
  return state;
}

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  const ticks = (n: number) => {
    for (let t = 0; t < n * 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const send = async (type: string, payload: unknown = {}) => {
    const outcome = mirror.sendCommandSettled(type, payload);
    await settle();
    ticks(1);
    return outcome;
  };
  const copy = (): SimState => {
    const s = mirror.state;
    if (!s) throw new Error("no snapshot");
    return s as unknown as SimState;
  };
  /** The mirror's running figure, and a full count of its copy, which must agree. */
  const check = () => {
    const full = countHomes(copy().buildings);
    expect(mirror.homes).toEqual(full);
    return full;
  };
  return { mirror, ticks, send, copy, check };
}

function homesIn(state: SimState): number[] {
  const out: number[] = [];
  for (let id = 0; id < state.buildings.flags.length; id++) if (isBuilding(state.buildings, id) && state.buildings.zone[id] === RESIDENTIAL) out.push(id);
  return out;
}

function street(state: SimState): number {
  const r = state.roads;
  for (let s = 0; s < r.segFlags.length; s++) {
    const flags = r.segFlags[s] ?? 0;
    if ((flags & 1) !== 0 && (flags & SEG_FIXED) === 0 && r.nodeZ[r.segA[s] ?? 0] === 4600) return s;
  }
  throw new Error("no street");
}

describe("the homes count", () => {
  it("is null before a snapshot and counts only residential buildings", () => {
    const { client } = memoryTransportPair();
    const mirror = new SimMirror(client, "p1");
    expect(mirror.homes).toBeNull();
    const state = city();
    const full = countHomes(state.buildings);
    const homes = homesIn(state);
    expect(full.count).toBe(homes.length);
    expect(full.count).toBeLessThan(buildingCount(state.buildings));
    expect(full.capacity).toBe(homes.reduce((sum, id) => sum + (state.buildings.residents[id] ?? 0), 0));
  });

  it("matches a full count over the mirror after grows, removals and an undo", async () => {
    const { mirror, ticks, send, copy, check } = setup(city());
    ticks(1);
    const start = check();
    expect(start.count).toBeGreaterThan(0);
    expect(start.capacity).toBeGreaterThan(0);

    // The grower builds more.
    expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
    for (let i = 0; i < 40 && (mirror.homes?.count ?? 0) <= start.count; i++) ticks(100);
    const grown = check();
    expect(grown.count).toBeGreaterThan(start.count);
    expect(await send("SetSpeed", { speed: 0 })).toEqual({ ok: true });
    // An update that changes no building keeps the same object, so the top bar does not redraw.
    const held = mirror.homes;
    ticks(1);
    expect(mirror.homes).toBe(held);

    // The bulldozer takes one house.
    const state = copy();
    const [house] = homesIn(state);
    if (house === undefined) throw new Error("no house");
    const seen = { id: house, segment: state.buildings.firstSeg[house], side: state.buildings.firstSide[house], place: state.buildings.firstPlace[house] };
    expect(await send("BulldozeBuilding", { buildings: [seen] })).toEqual({ ok: true });
    const lessOne = check();
    expect(lessOne.count).toBe(grown.count - 1);

    // A road takes every building on its cells. Undo brings the road and
    // its zoning back, not the buildings: the grower builds them again.
    const seg = street(copy());
    const net = copy().roads;
    expect(await send("BulldozeRoad", { segments: [seg], ends: [segmentEnds(net, seg)], types: [segmentTypeId(net, seg)] })).toEqual({ ok: true });
    expect(check().count).toBe(0);
    expect(await send("Undo")).toEqual({ ok: true });
    expect(check().count).toBe(0);
    expect(await send("SetSpeed", { speed: 4 })).toEqual({ ok: true });
    for (let i = 0; i < 40 && (mirror.homes?.count ?? 0) < 2; i++) ticks(100);
    expect(check().count).toBeGreaterThanOrEqual(2);
  });

  it("counts a home cut off past a shrunk id limit as gone", () => {
    const b = {
      flags: Uint8Array.of(1, 1, 1),
      zone: Uint8Array.of(RESIDENTIAL, RESIDENTIAL, RESIDENTIAL),
      residents: Int32Array.of(2, 3, 4),
    };
    expect(homesBefore(b, { ids: Int32Array.of(0), limit: 1 })).toEqual({ count: 3, capacity: 9 });
    expect(homesBefore(b, { ids: Int32Array.of(1, 2), limit: 1 })).toEqual({ count: 2, capacity: 7 });
  });
});

describe("the homes tooltip", () => {
  it("labels the room as capacity, not people", () => {
    expect(formatHomesTitle(null)).toBe("Homes built in the city");
    expect(formatHomesTitle({ count: 3, capacity: 1200 })).toBe("Residential buildings standing. Capacity: room for 1,200 residents in these homes. Not a count of people.");
    expect(formatHomesTitle({ count: 1, capacity: 1 })).toBe("Residential buildings standing. Capacity: room for 1 resident in this home. Not a count of people.");
  });
});

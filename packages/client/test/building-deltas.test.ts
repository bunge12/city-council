// M2-09: buildings in the protocol and the mirror. No command adds a
// building until the grower (issue 10), so the test hands the mirror a
// delta the host would send, after a real host has built the street and
// zoned it.
import { describe, expect, it } from "vitest";
import {
  BUILDING_TYPES,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  PROTOCOL_VERSION,
  ROAD_TYPES,
  ZONING_BALANCE,
  createBareState,
  roadTypeIndex,
  type BuildingDelta,
  type FromSimMessage,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror, type MirrorUpdate } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";

type Delta = Extract<FromSimMessage, { type: "delta" }>;

const CELL = ZONING_BALANCE.cellSize;
const HALF = (ROAD_TYPES[roadTypeIndex("street")]?.width ?? 0) / 2;
const chunk = (x: number, z: number) => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);
const HOUSE = BUILDING_TYPES.findIndex((t) => t.id === "single-family-home");

/** One house's row, two places wide and four deep from place `place` of segment 0's left side. */
function houseRows(place: number, alive: boolean): BuildingDelta["rows"] {
  const n = alive ? 1 : 0;
  return {
    flags: Uint8Array.of(n),
    firstSeg: Int32Array.of(0),
    firstSide: Uint8Array.of(0),
    firstPlace: Int32Array.of(alive ? place : 0),
    dir: Uint8Array.of(0),
    width: Uint8Array.of(alive ? 2 : 0),
    depth: Uint8Array.of(alive ? 4 : 0),
    zone: Uint8Array.of(n),
    density: Uint8Array.of(n),
    type: Uint16Array.of(alive ? HOUSE : 0),
    residents: Int32Array.of(alive ? 3 : 0),
    variant: Uint8Array.of(alive ? 1 : 0),
    builtAt: Float64Array.of(0),
  };
}

describe("building deltas in the mirror", () => {
  it("copies the rows, files each building by chunk with its lot's corners, and reports chunks once asked", async () => {
    const { client, host: hostEnd } = memoryTransportPair();
    const received: FromSimMessage[] = [];
    client.onMessage((m) => void received.push(m));
    let now = 0;
    const host = new SimHost(createBareState(2026), hostEnd, () => now);
    const mirror = new SimMirror(client, "p1");
    const updates: MirrorUpdate[] = [];
    mirror.subscribe((u) => updates.push(u));
    const tick = () => {
      for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
        now += PUMP_INTERVAL_MS;
        host.pump();
      }
    };
    const inject = (buildings: BuildingDelta) => {
      const deltas = received.filter((m): m is Delta => m.type === "delta");
      const last = deltas.at(-1);
      const state = mirror.state;
      if (!state || !last) throw new Error("no state");
      const message: Delta = {
        v: PROTOCOL_VERSION,
        type: "delta",
        seq: last.seq + 1,
        tick: state.tick,
        speed: state.speed,
        logFrom: last.logFrom + last.log.length,
        log: [],
        buildings,
        steps: 0,
        timings: [],
      };
      received.push(message);
      hostEnd.send(message);
    };

    // A street east along z = 4700 from x 4200, zoned R1 on its north side.
    await mirror.sendCommand("BuildRoad", { from: { x: 4200, z: 4700 }, to: { x: 4392, z: 4700 }, type: "street" });
    tick();
    const z = 4700 - HALF - 2 * CELL;
    await mirror.sendCommand("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4202, z }, to: { x: 4390, z }, width: 4 * CELL }] });
    tick();

    inject({ limit: 1, ids: Int32Array.of(0), rows: houseRows(3, true) });
    let last = updates.at(-1);
    // Nothing has asked about buildings yet, so no chunk is reported.
    expect(last?.kind === "delta" && last.buildingChunks).toEqual([]);
    expect(mirror.state?.buildings.flags).toEqual(Uint8Array.of(1));

    const here = chunk(4232, 4680);
    const [house] = mirror.buildingsInChunk(here);
    expect(house).toMatchObject({ id: 0, type: HOUSE, width: 2, depth: 4, residents: 3, variant: 1, chunk: here });
    const xs = [0, 2, 4, 6].map((i) => house?.corners?.[i] ?? 0);
    const zs = [1, 3, 5, 7].map((i) => house?.corners?.[i] ?? 0);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([4224, 4240]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([4700 - HALF - 4 * CELL, 4700 - HALF]);

    // Now it has been asked, removing the house reports its chunk.
    inject({ limit: 1, ids: Int32Array.of(0), rows: houseRows(0, false), free: Int32Array.of(0) });
    last = updates.at(-1);
    expect(last?.kind === "delta" && last.buildingChunks).toEqual([here]);
    expect(mirror.buildingsInChunk(here)).toEqual([]);
    expect(Array.from(mirror.state?.buildings.free ?? [])).toEqual([0]);

    // A delta whose rows do not fit makes the mirror ask for a snapshot.
    const asked = received.length;
    inject({ limit: 1, ids: Int32Array.of(0), rows: { ...houseRows(3, true), type: Uint16Array.of(9999) } });
    tick();
    expect(received.slice(asked).some((m) => m.type === "snapshot")).toBe(true);
  });
});

// M2-05: zoning cells in the protocol and the mirror. The same SimHost the
// worker runs, over an in-memory transport with a fake clock.
import { describe, expect, it } from "vitest";
import {
  CELL_OPEN,
  CELL_ROAD,
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  PROTOCOL_VERSION,
  ROAD_TYPES,
  ZONE_NONE,
  ZONING_BALANCE,
  applyCellDelta,
  cellStatuses,
  cellsInChunk,
  createBareState,
  hashState,
  nextFloat,
  nextInt,
  planZoneCells,
  roadTypeIndex,
  seedRng,
  type CellDelta,
  type FromSimMessage,
  type SimState,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror, type MirrorUpdate } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";

type Delta = Extract<FromSimMessage, { type: "delta" }>;

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
// The sim's build-road tests check it is still there.
const FLAT = { x0: 4100, z0: 4400, x1: 4700, z1: 5000 };
const CELL = ZONING_BALANCE.cellSize;
const HALF = (ROAD_TYPES[roadTypeIndex("street")]?.width ?? 0) / 2;

function setup() {
  const { client, host: hostEnd } = memoryTransportPair();
  const received: FromSimMessage[] = [];
  let listening = true;
  // Sit between the host and the mirror so a test can take a snapshot the mirror never sees.
  const filtered: typeof client = {
    send: (m, t) => client.send(m, t),
    onMessage: (handler) =>
      client.onMessage((m) => {
        received.push(m);
        if (listening) handler(m);
      }),
  };
  let now = 0;
  const host = new SimHost(createBareState(2026), hostEnd, () => now);
  const mirror = new SimMirror(filtered, "p1");
  const updates: MirrorUpdate[] = [];
  mirror.subscribe((u) => updates.push(u));
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  /** The host's city now, from a snapshot that goes only to the test. */
  const hostSnapshot = () => {
    listening = false;
    filtered.send({ v: PROTOCOL_VERSION, type: "requestSnapshot" });
    listening = true;
    const snap = received.at(-1);
    if (snap?.type !== "snapshot") throw new Error("no snapshot");
    return snap;
  };
  const deltas = () => received.filter((m): m is Delta => m.type === "delta");
  const state = () => {
    if (!mirror.state) throw new Error("no state");
    return mirror.state as SimState;
  };
  return { mirror, updates, tick, hostSnapshot, deltas, state };
}

const road = (from: [number, number], to: [number, number], type = "street") => ({
  from: { x: from[0], z: from[1] },
  to: { x: to[0], z: to[1] },
  type,
});
const rect = (from: [number, number], to: [number, number], width: number) => ({
  from: { x: from[0], z: from[1] },
  to: { x: to[0], z: to[1] },
  width,
});
const chunk = (x: number, z: number) => Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);
const zoned = (state: SimState) => state.cells.zone.reduce((n, z) => n + (z === ZONE_NONE ? 0 : 1), 0);
/** Where each cell a delta carries sits in `state.cells.zone`. */
const slotsOf = (state: SimState, cells: CellDelta) => {
  const out: number[] = [];
  cells.segIds.forEach((seg, g) => {
    for (let i = cells.segStart[g] ?? 0; i < (cells.segStart[g + 1] ?? 0); i++) out.push((state.cells.offset[seg] ?? 0) + (cells.local[i] ?? 0));
  });
  return out;
};

/** A street along z = 4500 with a strip two cells deep and 50 long on its north side: 100 cells. */
const STREET = road([4150, 4500], [4650, 4500]);
const STRIP = {
  zone: "residential",
  density: 1,
  rects: [rect([4200, 4500 - HALF - CELL], [4400, 4500 - HALF - CELL], 2 * CELL), rect([4400, 4500 - HALF - CELL], [4600, 4500 - HALF - CELL], 2 * CELL)],
};

describe("cell deltas", () => {
  it("carries a painted strip of 100 cells and nothing else", async () => {
    const { mirror, tick, deltas, state, hostSnapshot } = setup();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    const plan = planZoneCells(state(), STRIP);
    expect(plan.ok && plan.plan.cells.length).toBe(100);
    const before = deltas().length;
    expect(await mirror.sendCommand("ZoneCells", STRIP)).toEqual({ ok: true });
    tick();
    const sent = deltas().slice(before).filter((d) => d.cells !== undefined);
    expect(sent.length).toBe(1);
    const delta = sent[0] as Delta;
    const cells = delta.cells as CellDelta;
    expect(delta.roads).toBeUndefined();
    expect(cells.relaid.length).toBe(0);
    expect(cells.local.length).toBe(100);
    expect(slotsOf(state(), cells)).toEqual(plan.ok ? [...plan.plan.cells] : []);
    expect([...cells.zone].every((z) => z === 1) && [...cells.density].every((d) => d === 1)).toBe(true);
    expect(zoned(state())).toBe(100);
    expect(hashState(state())).toBe(hashState(hostSnapshot().state));
  });

  it("adds no cell data to a delta on a tick where no cell changed", async () => {
    const { mirror, tick, deltas } = setup();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    await mirror.sendCommand("NoOp");
    tick();
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    tick();
    expect(deltas().map((d) => "cells" in d)).toEqual([true, false, true, false]);
  });

  it("carries a cleared cell as unzoned", async () => {
    const { mirror, tick, deltas, state, hostSnapshot } = setup();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    expect(zoned(state())).toBe(100);
    await mirror.sendCommand("ZoneCells", { zone: "none", rects: [rect([4200, 4500 - HALF - CELL / 2], [4300, 4500 - HALF - CELL / 2], CELL)] });
    tick();
    const cells = deltas().at(-1)?.cells;
    expect(cells && [...cells.zone].every((z) => z === ZONE_NONE) && cells.local.length).toBe(13);
    expect(zoned(state())).toBe(87);
    expect(hashState(state())).toBe(hashState(hostSnapshot().state));
  });

  it("keeps the mirror equal to the sim when a road is built across zoned cells", async () => {
    const { mirror, tick, deltas, state, hostSnapshot } = setup();
    // Ask about cells first, so the mirror keeps its cell index current through the deltas.
    expect(mirror.cellAt(4400, 4500 - HALF - 1)).toBeNull();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    const at = mirror.cellAt(4400, 4500 - HALF - 1);
    expect(at?.status).toBe(CELL_OPEN);
    expect(state().cells.zone[at?.index ?? -1]).toBe(1);
    // Across the street and through the strip, which cuts the street in two.
    await mirror.sendCommand("BuildRoad", road([4400, 4400], [4400, 4600]));
    tick();
    const cells = deltas().at(-1)?.cells as CellDelta;
    // Both halves of the street and the new road were laid out again.
    expect(cells.relaid.length).toBeGreaterThanOrEqual(3);
    // Every zone the sim kept on its ground came with them.
    expect(cells.local.length).toBe(100);
    const snap = hostSnapshot().state;
    expect(zoned(snap)).toBe(100);
    expect(hashState(state())).toBe(hashState(snap));
    // The mirror's own index, kept current by deltas, against one built from the snapshot.
    expect([...cellStatuses(state())]).toEqual([...cellStatuses(snap)]);
    const under = mirror.cellAt(4400, 4500 - HALF - 1);
    expect(under?.status).toBe(CELL_ROAD);
    expect(state().cells.zone[under?.index ?? -1]).toBe(1);
  });

  it("is equal after a snapshot and after the same history of deltas", () => {
    const { mirror, tick, state, hostSnapshot } = setup();
    const rng = seedRng(105);
    const point = (): [number, number] => [FLAT.x0 + nextFloat(rng) * (FLAT.x1 - FLAT.x0), FLAT.z0 + nextFloat(rng) * (FLAT.z1 - FLAT.z0)];
    const live = () => {
      const roads = state().roads;
      const out: number[] = [];
      for (let id = 0; id < roads.segFlags.length; id++) if ((roads.segFlags[id] ?? 0) & 1) out.push(id);
      return out;
    };
    const zones = [...ZONING_BALANCE.zones.map((z) => z.id), "none"];
    for (let t = 0; t < 400; t++) {
      // The index is built part of the way in, from the copy as it then is.
      if (t === 40) mirror.cellAt(4400, 4700);
      const commands = 1 + nextInt(rng, 2);
      for (let i = 0; i < commands; i++) {
        const roll = nextInt(rng, 12);
        const segs = live();
        if (roll < 3 || segs.length === 0) void mirror.sendCommand("BuildRoad", road(point(), point(), ["street", "avenue", "oneway"][nextInt(rng, 3)]));
        else if (roll < 8) {
          const from = point();
          void mirror.sendCommand("ZoneCells", {
            zone: zones[nextInt(rng, zones.length)],
            density: 1 + nextInt(rng, 3),
            rects: [rect(from, [from[0] + nextFloat(rng) * 200 - 100, from[1] + nextFloat(rng) * 200 - 100], 16 + nextFloat(rng) * 150)],
          });
        } else if (roll < 9) void mirror.sendCommand("BulldozeRoad", { segments: [segs[nextInt(rng, segs.length)]] });
        else if (roll < 10) void mirror.sendCommand("UpgradeRoad", { segments: [segs[nextInt(rng, segs.length)]], type: "avenue" });
        else void mirror.sendCommand("Undo");
      }
      tick();
      if (t % 50 === 49) expect(hashState(state()), `tick ${t}`).toBe(hashState(hostSnapshot().state));
    }
    // A second mirror that connects now gets the snapshot and no history.
    const snap = hostSnapshot();
    const late = new SimMirror({ send: () => undefined, onMessage: (handler) => (handler(snap), () => undefined) }, "p2");
    const lateState = late.state as SimState;
    expect(hashState(state())).toBe(hashState(lateState));
    expect([...state().cells.offset]).toEqual([...lateState.cells.offset]);
    expect([...state().cells.zone]).toEqual([...lateState.cells.zone]);
    expect([...state().cells.density]).toEqual([...lateState.cells.density]);
    expect(state().cellsReadyAt).toBe(lateState.cellsReadyAt);
    expect([...cellStatuses(state())]).toEqual([...cellStatuses(lateState)]);
    for (const c of [chunk(4200, 4450), chunk(4200, 4700), chunk(4600, 4700)]) expect(mirror.cellsInChunk(c)).toEqual(late.cellsInChunk(c));
    // Enough happened for this to mean something.
    expect(zoned(state())).toBeGreaterThan(500);
    expect(state().log.filter((e) => e.type === "ZoneCells").length).toBeGreaterThan(100);
    expect(state().log.filter((e) => e.type === "Undo").length).toBeGreaterThan(20);
  });

  it("answers which cells are in a chunk and which is under a point", async () => {
    const { mirror, tick, state } = setup();
    expect(mirror.cellsInChunk(chunk(4200, 4450))).toEqual([]);
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    // The street runs along the line between two chunks in z and crosses x = 4500.
    const all = [chunk(4200, 4450), chunk(4600, 4450), chunk(4200, 4550), chunk(4600, 4550)].map((c) => mirror.cellsInChunk(c));
    expect(all.reduce((n, list) => n + list.length, 0)).toBe(state().cells.zone.length);
    expect(all.flat().filter((c) => state().cells.zone[c.index] !== ZONE_NONE).length).toBe(100);
    expect(mirror.cellsInChunk(chunk(4200, 4450))).toEqual(cellsInChunk(state(), chunk(4200, 4450)));
    const cell = mirror.cellAt(4204, 4500 - HALF - CELL - 1);
    expect(cell).toMatchObject({ segment: 0, depth: 1, status: CELL_OPEN });
    expect(state().cells.zone[cell?.index ?? -1]).toBe(1);
    expect(mirror.cellAt(4204, 4300)).toBeNull();
  });

  it("tells listeners which chunks' cells changed, once something has asked about cells", async () => {
    const { mirror, updates, tick } = setup();
    const cellChunks = () => updates.map((u) => (u.kind === "delta" ? u.cellChunks : null));
    await mirror.sendCommand("BuildRoad", road([4150, 4700], [4350, 4700]));
    tick();
    // Nothing has asked yet, so nothing drawn can be out of date.
    expect(cellChunks()).toEqual([[]]);
    mirror.cellsInChunk(chunk(4200, 4700));
    // A street along the line between two chunks in z, across x = 4500.
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    tick();
    // The strip lies north of the street, on both sides of x = 4500.
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    // One rectangle wholly inside one chunk.
    await mirror.sendCommand("ZoneCells", { zone: "commercial", density: 2, rects: [rect([4200, 4700 + HALF + CELL], [4300, 4700 + HALF + CELL], 2 * CELL)] });
    tick();
    expect(cellChunks().slice(1)).toEqual([
      [chunk(4200, 4450), chunk(4600, 4450), chunk(4200, 4550), chunk(4600, 4550)],
      [],
      [chunk(4200, 4450), chunk(4600, 4450)],
      [chunk(4200, 4700)],
    ]);
  });

  it("refuses a delta that cannot belong to the copy, and leaves the cells as they were", async () => {
    const { mirror, tick, deltas, state } = setup();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    const good = deltas().at(-1)?.cells as CellDelta;
    const copy = state();
    const zonesBefore = [...copy.cells.zone];
    const run = copy.cells.zone.length;
    const bad: [string, CellDelta][] = [
      ["a cell past its segment's run", { ...good, local: good.local.map((l, i) => (i === good.local.length - 1 ? run : l)) }],
      ["cells out of order", { ...good, local: good.local.slice().reverse() }],
      ["a segment the copy does not have", { ...good, segIds: Int32Array.of(7) }],
      ["a relaid segment the copy does not have", { ...good, relaid: Int32Array.of(7) }],
      ["a zone without a density", { ...good, density: new Uint8Array(good.density.length) }],
      ["an unknown zone", { ...good, zone: good.zone.map(() => 99) }],
      ["rows of different lengths", { ...good, zone: good.zone.slice(1) }],
      ["groups that do not cover the cells", { ...good, segStart: Int32Array.of(0, 5) }],
    ];
    for (const [what, delta] of bad) {
      expect(typeof applyCellDelta(copy, delta, []), what).toBe("string");
      expect([...copy.cells.zone], what).toEqual(zonesBefore);
    }
    // A road row whose segment gained cells that no delta carried.
    copy.cells = { offset: Int32Array.of(0, 0), zone: new Uint8Array(0), density: new Uint8Array(0) };
    expect(applyCellDelta(copy, null, [0])).toMatch(/segment 0 changed its cells/);
  });

  it("asks for a snapshot when a delta's cells do not fit, and catches up", async () => {
    const { mirror, tick, updates, state, hostSnapshot } = setup();
    await mirror.sendCommand("BuildRoad", STREET);
    tick();
    // The copy loses its cells behind the mirror's back.
    state().cells = { offset: Int32Array.of(0, 0), zone: new Uint8Array(0), density: new Uint8Array(0) };
    await mirror.sendCommand("ZoneCells", STRIP);
    tick();
    expect(updates.at(-1)).toEqual({ kind: "snapshot" });
    expect(zoned(state())).toBe(100);
    expect(hashState(state())).toBe(hashState(hostSnapshot().state));
  });
});

import { describe, expect, it } from "vitest";
import {
  CELL_OPEN,
  CELL_ROAD,
  DENSITY_NONE,
  ZONE_CLEAR,
  ZONE_NONE,
  ZONING_BALANCE,
  cellCorners,
  cellStatuses,
  cellsInBox,
  cellsSettled,
  cellsWalked,
  createState,
  deserialize,
  hashState,
  planZoneCells,
  serialize,
  step,
  validateCommand,
  type Command,
  type SimState,
  type ZoneRect,
} from "../src/index";
import { submit } from "./seen-ends";
import { cloneState } from "../src/state";
import { fromLocal } from "../src/zoning/cells";
import fixtureJson from "./fixtures/replay/zoning.json";
import { expectReplay, runFixture, type ReplayFixture } from "./replay-helper";

// M2-04: the ZoneCells command.

const fixture = fixtureJson as ReplayFixture;

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000)
// (build-road.test.ts).
const SEED = 2026;
const zoneNumber = (id: string) => ZONING_BALANCE.zones.findIndex((z) => z.id === id) + 1;
const R = zoneNumber("residential");
const C = zoneNumber("commercial");

let seq = 0;
function command(type: string, payload: unknown, playerId = "p1"): Command {
  return { seq: ++seq, playerId, type, payload };
}
const road = (from: [number, number], to: [number, number]) =>
  command("BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" });
const rect = (from: [number, number], to: [number, number], width: number): ZoneRect => ({
  from: { x: from[0], z: from[1] },
  to: { x: to[0], z: to[1] },
  width,
});
const zone = (zoneId: string, density: number | undefined, rects: ZoneRect[], playerId = "p1") =>
  command("ZoneCells", density === undefined ? { zone: zoneId, rects } : { zone: zoneId, density, rects }, playerId);

function ok(state: SimState, c: Command): void {
  expect(submit(state, c), c.type).toEqual({ ok: true });
  step(state);
  expect(state.log.at(-1)?.seq, `${c.type} should apply`).toBe(c.seq);
}

function refused(state: SimState, c: Command, reason: RegExp): void {
  const before = hashState(state);
  const result = submit(state, c);
  expect(result.ok, JSON.stringify(c.payload)).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(reason);
  expect(hashState(state)).toBe(before);
}

/** A street running east from (4200, 4600) for 24 cells: its left strip is north of it, from z 4595 back to 4547. */
function street(): SimState {
  const state = createState(SEED);
  ok(state, road([4200, 4600], [4392, 4600]));
  return state;
}

/** The slots of every zoned cell, with what each holds, as "slot:zone/density". */
function zoned(state: SimState): string[] {
  const out: string[] = [];
  state.cells.zone.forEach((z, slot) => {
    if (z !== ZONE_NONE || state.cells.density[slot] !== DENSITY_NONE) out.push(`${slot}:${z}/${state.cells.density[slot]}`);
  });
  return out;
}

/** The slots that differ between two cities with the same roads. */
function changed(before: SimState, after: SimState): number[] {
  const out: number[] = [];
  after.cells.zone.forEach((z, slot) => {
    if (z !== before.cells.zone[slot] || after.cells.density[slot] !== before.cells.density[slot]) out.push(slot);
  });
  return out;
}

/** The name of the cell in `slot`. */
function nameOf(state: SimState, slot: number) {
  const offset = state.cells.offset;
  let segment = 0;
  while ((offset[segment + 1] ?? 0) <= slot) segment++;
  return { segment, ...fromLocal(slot - (offset[segment] ?? 0)) };
}

describe("ZoneCells", () => {
  it("paints the open cells whose centres lie in the rectangle, edges included", () => {
    const state = street();
    // The row nearest the road on its north side has centres at z 4591, x 4204 to 4388.
    // From the first centre to the eighth, a hair wide: both end centres are on the edge.
    ok(state, zone("residential", 1, [rect([4204, 4591], [4260, 4591], 0.5)]));
    const cells = zoned(state).map((entry) => entry.split(":"));
    expect(cells.map(([, value]) => value)).toEqual(Array.from({ length: 8 }, () => `${R}/1`));
    const names = cells.map(([slot]) => nameOf(state, Number(slot)));
    expect(names.map((n) => n.place)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(names.every((n) => n.side === 0 && n.depth === 0)).toBe(true);
  });

  it("paints every row a wider rectangle covers, on both sides of the street", () => {
    const state = street();
    // 16 m either side of the centre line takes the first row each side
    // (centres 9 m out) and stops short of the second (17 m out).
    ok(state, zone("office", 3, [rect([4200, 4600], [4392, 4600], 32)]));
    expect(zoned(state)).toHaveLength(24 * 2);
    // Two rows a side.
    ok(state, zone("office", 3, [rect([4200, 4600], [4392, 4600], 36)]));
    expect(zoned(state)).toHaveLength(24 * 2 * 2);
    expect(new Set(zoned(state).map((entry) => entry.split(":")[1]))).toEqual(new Set([`${zoneNumber("office")}/3`]));
  });

  it("takes a rectangle at any angle", () => {
    const state = street();
    const [fx, fz, tx, tz, width] = [4210, 4540, 4330, 4660, 30];
    ok(state, zone("mixed", 2, [rect([fx, fz], [tx, tz], width)]));
    // Every cell, tested the slow way.
    const expected: number[] = [];
    const length = Math.hypot(tx - fx, tz - fz);
    cellStatuses(state).forEach((status, slot) => {
      const q = cellCorners(state, nameOf(state, slot)) ?? [];
      const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4 - fx;
      const z = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4 - fz;
      const along = (x * (tx - fx) + z * (tz - fz)) / length;
      const across = (x * (tz - fz) - z * (tx - fx)) / length;
      if (status === CELL_OPEN && along >= 0 && along <= length && Math.abs(across) <= width / 2) expected.push(slot);
    });
    expect(expected.length).toBeGreaterThan(20);
    expect(zoned(state).map((entry) => Number(entry.split(":")[0]))).toEqual(expected);
    // Drawn from the other end, it is the same ground.
    const other = street();
    ok(other, zone("mixed", 2, [rect([tx, tz], [fx, fz], width)]));
    expect(zoned(other)).toEqual(zoned(state));
  });

  it("repaints zoned cells, and counts only the ones that change", () => {
    const state = street();
    ok(state, zone("residential", 1, [rect([4200, 4591], [4264, 4591], 4)]));
    expect(zoned(state)).toHaveLength(8);
    // Over the last four painted and four more: all eight change.
    const before = cloneState(state);
    ok(state, zone("commercial", 2, [rect([4232, 4591], [4296, 4591], 4)]));
    expect(changed(before, state)).toHaveLength(8);
    expect(zoned(state).map((entry) => entry.split(":")[1])).toEqual([...Array(4).fill(`${R}/1`), ...Array(8).fill(`${C}/2`)]);
    // The same zone at another density is a change too.
    const again = cloneState(state);
    ok(state, zone("commercial", 3, [rect([4232, 4591], [4264, 4591], 4)]));
    expect(changed(again, state)).toHaveLength(4);
    // Residential over all twelve changes only the eight that are not R1.
    const plan = planZoneCells(state, zone("residential", 1, [rect([4200, 4591], [4296, 4591], 4)]).payload);
    expect(plan.ok && plan.plan.cells.length).toBe(8);
  });

  it("clears cells with the zone none, with or without a density", () => {
    const state = street();
    ok(state, zone("industrial", 2, [rect([4200, 4591], [4264, 4591], 4)]));
    ok(state, zone(ZONE_CLEAR, undefined, [rect([4200, 4591], [4232, 4591], 4)]));
    expect(zoned(state)).toHaveLength(4);
    ok(state, zone(ZONE_CLEAR, 2, [rect([4200, 4591], [4392, 4591], 4)]));
    expect(zoned(state)).toEqual([]);
    expect(hashState(state)).not.toBe(hashState(street()));
    expect(state.cells.zone.every((z) => z === ZONE_NONE)).toBe(true);
    expect(state.cells.density.every((d) => d === DENSITY_NONE)).toBe(true);
  });

  it("paints only the open cells of a rectangle half over blocked ones", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4700], [4600, 4700]));
    ok(state, road([4400, 4500], [4400, 4900]));
    // Across the junction: cells under the crossing street, cells that lost
    // their ground to the older road's, and open cells either side.
    const box = [4360, 4640, 4440, 4760] as const;
    const under = cellsInBox(state, ...box);
    const open = under.filter((c) => c.status === CELL_OPEN);
    expect(under.some((c) => c.status === CELL_ROAD)).toBe(true);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(under.length);
    ok(state, zone("residential", 2, [rect([4360, 4700], [4440, 4700], 120)]));
    expect(zoned(state)).toEqual(open.map((c) => `${c.index}:${R}/2`).sort((p, q) => parseInt(p) - parseInt(q)));
  });

  it("lists a cell under two rectangles once", () => {
    const state = street();
    const twice = [rect([4200, 4591], [4264, 4591], 4), rect([4232, 4591], [4296, 4591], 4), rect([4232, 4580], [4232, 4600], 4)];
    const plan = planZoneCells(state, zone("residential", 1, twice).payload);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.cells).toHaveLength(12);
    expect(new Set(plan.plan.cells).size).toBe(12);
    expect(Array.from(plan.plan.cells)).toEqual(Array.from(plan.plan.cells).sort((p, q) => p - q));
  });

  it("plans the cells the command then changes", () => {
    const state = createState(SEED);
    ok(state, road([4200, 4700], [4600, 4700]));
    ok(state, road([4400, 4500], [4400, 4900]));
    ok(state, zone("residential", 1, [rect([4300, 4660], [4500, 4660], 40)]));
    const strokes: [string, number | undefined, ZoneRect[]][] = [
      ["commercial", 2, [rect([4250, 4600], [4420, 4770], 60), rect([4380, 4520], [4380, 4680], 90)]],
      ["residential", 1, [rect([4200, 4700], [4456, 4700], 256)]],
      [ZONE_CLEAR, undefined, [rect([4360, 4830], [4460, 4630], 44)]],
    ];
    for (const [zoneId, density, rects] of strokes) {
      const c = zone(zoneId, density, rects);
      const plan = planZoneCells(state, c.payload);
      if (!plan.ok) throw new Error(plan.reason);
      const before = cloneState(state);
      // Planning changed nothing.
      expect(hashState(state)).toBe(hashState(before));
      ok(state, c);
      expect(changed(before, state)).toEqual(Array.from(plan.plan.cells));
      for (const slot of plan.plan.cells) {
        expect(state.cells.zone[slot]).toBe(plan.plan.zone);
        expect(state.cells.density[slot]).toBe(plan.plan.density);
      }
    }
  });

  it("is logged with its player id and tick like any other command", () => {
    const state = street();
    const c = zone("residential", 1, [rect([4200, 4591], [4264, 4591], 4)], "mayor-2");
    const tick = state.tick;
    ok(state, c);
    expect(state.log.at(-1)).toEqual({ tick, seq: c.seq, playerId: "mayor-2", type: "ZoneCells", payload: c.payload });
  });

  it("is refused with a reason", () => {
    const state = street();
    const good = [rect([4200, 4591], [4264, 4591], 4)];
    const payload = (over: Record<string, unknown>) => command("ZoneCells", { zone: "residential", density: 1, rects: good, ...over });
    refused(state, command("ZoneCells", null), /must be an object/);
    refused(state, command("ZoneCells", [good]), /must be an object/);
    // An unknown zone.
    for (const z of ["park", "", "R", 1, null, undefined]) refused(state, payload({ zone: z }), /unknown zone/);
    // An unknown density, also when clearing.
    for (const d of [0, 4, 1.5, "1", null, undefined]) refused(state, payload({ density: d }), /unknown density/);
    refused(state, payload({ zone: ZONE_CLEAR, density: 4 }), /unknown density/);
    // No rectangles, or more than the cap.
    for (const rects of [undefined, [], "all", { 0: good[0] }]) refused(state, payload({ rects }), /at least one rectangle/);
    const cap = ZONING_BALANCE.maxRectsPerCommand;
    refused(state, payload({ rects: Array.from({ length: cap + 1 }, () => good[0]) }), new RegExp(`too many rectangles: ${cap + 1}.*at most ${cap}`));
    expect(validateCommand(state, payload({ rects: Array.from({ length: cap }, () => good[0]) }))).toEqual({ ok: true });
    // A rectangle that is not one.
    const one = (r: unknown) => payload({ rects: [good[0], r] });
    refused(state, one(null), /rects\[1\] needs a from and a to/);
    refused(state, one({ from: { x: 4200, z: 4591 }, width: 4 }), /rects\[1\] needs a from and a to/);
    refused(state, one({ from: { x: 4200, z: Infinity }, to: { x: 4264, z: 4591 }, width: 4 }), /finite/);
    refused(state, one({ from: { x: "4200", z: 4591 }, to: { x: 4264, z: 4591 }, width: 4 }), /finite/);
    for (const width of [0, -4, NaN, "4", undefined]) refused(state, one({ ...good[0], width }), /rects\[1\]\.width/);
    refused(state, one(rect([4200, 4591], [4200, 4591], 4)), /rects\[1\] has no length/);
    const side = ZONING_BALANCE.maxRectSide;
    refused(state, one(rect([4200, 4591], [4200 + side + 1, 4591], 4)), /rects\[1\] is too big/);
    refused(state, one(rect([4200, 4591], [4264, 4591], side + 1)), /rects\[1\] is too big/);
    refused(state, one(rect([-1e200, 0], [1e200, 0], 4)), /rects\[1\] is too big/);
    // Nothing would change: open ground with no cells, and cells zoned this way already.
    refused(state, payload({ rects: [rect([4200, 4900], [4264, 4900], 40)] }), /no cell would change/);
    refused(state, payload({ zone: ZONE_CLEAR }), /no cell would change/);
    ok(state, payload({}));
    refused(state, payload({}), /no cell would change/);
    // Far off the map there is nothing either.
    refused(state, payload({ rects: [rect([-9e6, -9e6], [-9e6 + 50, -9e6], 40)] }), /no cell would change/);
  });

  it("drops a command that an earlier one in the same tick left nothing to do", () => {
    const state = street();
    const first = zone("residential", 1, [rect([4200, 4591], [4264, 4591], 4)]);
    const second = zone("residential", 1, [rect([4200, 4591], [4264, 4591], 4)], "p2");
    expect(submit(state, first)).toEqual({ ok: true });
    expect(submit(state, second)).toEqual({ ok: true });
    step(state);
    expect(state.log.filter((e) => e.type === "ZoneCells").map((e) => e.playerId)).toEqual(["p1"]);
  });

  it("paints the cells that are on the ground when it applies, whatever the roads were when it was sent", () => {
    const state = street();
    const before = cloneState(state);
    // Sent while the street is whole. A crossing street lands first and
    // splits it, so every cell has a new name by the time this applies.
    const cross = road([4296, 4500], [4296, 4700]);
    const paint = zone("residential", 1, [rect([4200, 4591], [4392, 4591], 4)]);
    expect(submit(state, cross)).toEqual({ ok: true });
    expect(submit(state, paint)).toEqual({ ok: true });
    step(state);
    expect(state.log.slice(-2).map((e) => e.type)).toEqual(["BuildRoad", "ZoneCells"]);
    const painted = zoned(state).map((entry) => nameOf(state, Number(entry.split(":")[0])));
    // Every cell of the row that is still open: the new street covers a few.
    const row = cellsInBox(state, 4200, 4590, 4392, 4592);
    expect(painted).toHaveLength(row.filter((c) => c.status === CELL_OPEN).length);
    expect(row.some((c) => c.status === CELL_ROAD)).toBe(true);
    expect(painted.length).toBeGreaterThan(18);
    expect(new Set(painted.map((n) => n.segment)).size).toBe(2);
    // On the whole street it would have been all 24.
    const whole = planZoneCells(before, paint.payload);
    expect(whole.ok && whole.plan.cells.length).toBe(24);
  });

  it("waits for a big change of roads to settle, and paints the same cells as a paused city (M2 review, #147)", () => {
    const grid = command("BuildRoadGrid", {
      origin: { x: 4104, z: 4404 },
      along: { x: 4680, z: 4404 },
      across: { x: 4104, z: 4980 },
      depth: 86,
      width: 86,
      type: "street",
    });
    const strokes = [
      zone("residential", 1, [rect([4110, 4500], [4366, 4500], 200), rect([4366, 4500], [4622, 4500], 200)]),
      zone("commercial", 3, [rect([4150, 4450], [4330, 4630], 120)]),
    ];
    // One city zones in the tick right after the grid, before its cells settle.
    const early = createState(SEED);
    ok(early, grid);
    expect(cellsSettled(early)).toBe(false);
    const ready = early.cellsReadyAt;
    for (const s of strokes) expect(submit(early, s)).toEqual({ ok: true });
    // Accepting them walked none of the change: the shape of the payload is all submit checks.
    expect(cellsWalked(early)).toBe(false);
    // A malformed one is still refused at once.
    expect(submit(early, zone("residential", 1, [])).ok).toBe(false);
    step(early);
    expect(early.log.at(-1)?.seq).toBe(grid.seq);
    expect(early.pending.map((c) => c.seq)).toEqual(strokes.map((c) => c.seq));
    // Its twin is saved and loaded with the strokes still waiting, which settles everything at once.
    const loaded = deserialize(serialize(cloneState(early))).state;
    while (early.log.at(-1)?.seq !== strokes[1]?.seq) step(early);
    // They landed from the tick the cells settled, in order, one a tick (`cellCommandsPerTick`).
    expect(early.log.slice(-2).map((e) => [e.seq, e.tick])).toEqual(strokes.map((c, i) => [c.seq, ready + i]));
    while (loaded.tick < early.tick) step(loaded);
    expect(hashState(loaded)).toBe(hashState(early));
    // A third pauses first: with no tick to wait for, its strokes apply at once.
    const paused = createState(SEED);
    ok(paused, grid);
    ok(paused, command("SetSpeed", { speed: 0 }));
    ok(paused, strokes[0] as Command);
    ok(paused, strokes[1] as Command);
    expect(Array.from(paused.cells.zone)).toEqual(Array.from(early.cells.zone));
    expect(Array.from(paused.cells.density)).toEqual(Array.from(early.cells.density));
    expect(zoned(early).length).toBeGreaterThan(500);
  });

  it("holds the player's later strokes behind a waiting one, in order, and lets their road go on", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoadGrid", { origin: { x: 4104, z: 4404 }, along: { x: 4680, z: 4404 }, across: { x: 4104, z: 4980 }, depth: 86, width: 86, type: "street" }));
    const stroke = zone("residential", 1, [rect([4110, 4500], [4366, 4500], 200)]);
    const street = road([4150, 4300], [4400, 4300]);
    const again = zone("commercial", 2, [rect([4110, 4500], [4366, 4500], 100)]);
    for (const c of [stroke, street, again]) expect(submit(state, c)).toEqual({ ok: true });
    step(state);
    // The street names its own ground and goes on; the second stroke keeps its place behind the first.
    expect(state.log.at(-1)?.seq).toBe(street.seq);
    expect(state.pending.map((c) => c.seq)).toEqual([stroke.seq, again.seq]);
    while (state.pending.length > 0) step(state);
    expect(state.log.slice(-2).map((e) => e.seq)).toEqual([stroke.seq, again.seq]);
  });

  it("lets another player's commands go on while one player's stroke waits", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoadGrid", { origin: { x: 4104, z: 4404 }, along: { x: 4680, z: 4404 }, across: { x: 4104, z: 4980 }, depth: 86, width: 86, type: "street" }));
    const stroke = zone("residential", 1, [rect([4110, 4500], [4366, 4500], 200)]);
    const street = command("BuildRoad", { from: { x: 4150, z: 4300 }, to: { x: 4400, z: 4300 }, type: "street" }, "p2");
    expect(submit(state, stroke)).toEqual({ ok: true });
    expect(submit(state, street)).toEqual({ ok: true });
    step(state);
    expect(state.log.at(-1)?.seq).toBe(street.seq);
    expect(state.pending.map((c) => c.seq)).toEqual([stroke.seq]);
  });
});

/**
 * The commands behind fixtures/replay/zoning.json, stepped live: roads, a
 * grid, strokes of every zone and density, a repaint, a clear, and a road
 * through zoned cells. `pausedSteps` extra steps run while paused at tick 9.
 */
function playLive(pausedSteps: number, reloadAt = -1): SimState {
  let state = createState(fixture.seed);
  let n = 0;
  const send = (playerId: string, type: string, payload: unknown) =>
    expect(submit(state, { seq: ++n, playerId, type, payload }), type).toEqual({ ok: true });
  const paint = (playerId: string, zoneId: string, density: number | undefined, rects: ZoneRect[]) =>
    send(playerId, "ZoneCells", density === undefined ? { zone: zoneId, rects } : { zone: zoneId, density, rects });
  const build = (playerId: string, from: [number, number], to: [number, number]) =>
    send(playerId, "BuildRoad", { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" });
  while (state.tick < fixture.untilTick) {
    if (state.tick === reloadAt) state = deserialize(serialize(state)).state;
    switch (state.tick) {
      case 0:
        build("p1", [4200, 4600], [4392, 4600]);
        break;
      case 1:
        paint("p1", "residential", 1, [rect([4200, 4575], [4392, 4575], 48)]);
        paint("p2", "commercial", 2, [rect([4200, 4625], [4392, 4625], 48)]);
        break;
      case 3:
        send("p2", "BuildRoadGrid", {
          origin: { x: 4104, z: 4704 },
          along: { x: 4488, z: 4704 },
          across: { x: 4104, z: 4992 },
          depth: 86,
          width: 86,
          type: "street",
        });
        break;
      case 4:
        // While the grid's cells are still settling.
        paint("p1", "office", 3, [rect([4110, 4760], [4360, 4760], 100)]);
        paint("p2", "industrial", 2, [rect([4150, 4720], [4320, 4890], 70)]);
        break;
      case 6:
        // A street through the first strip, and a stroke in the same tick.
        build("p1", [4296, 4500], [4296, 4704]);
        paint("p2", "mixed", 1, [rect([4200, 4591], [4392, 4591], 4)]);
        break;
      case 9:
        send("p1", "SetSpeed", { speed: 0 });
        step(state);
        paint("p1", "residential", 3, [rect([4250, 4550], [4350, 4650], 20), rect([4350, 4550], [4250, 4650], 20)]);
        for (let i = 0; i < pausedSteps; i++) step(state);
        send("p2", "SetSpeed", { speed: 2 });
        break;
      case 12:
        paint("p2", ZONE_CLEAR, undefined, [rect([4200, 4640], [4392, 4640], 20)]);
        paint("p1", "mixed", 2, [rect([4104, 4850], [4360, 4850], 256)]);
        break;
      case 14:
        send("p1", "BulldozeRoad", { segments: [segmentAt(state, 4248, 4600)] });
        break;
    }
    step(state);
  }
  return state;
}

/** The live segment whose cell holds point (x, z - 9): the street through (x, z) running east. */
function segmentAt(state: SimState, x: number, z: number): number {
  const cell = cellsInBox(state, x - 4, z - 13, x + 4, z - 5)[0];
  if (!cell) throw new Error(`no cell beside (${x}, ${z})`);
  return cell.segment;
}

describe("replay fixture zoning", () => {
  it("replays to its recorded hash", () => {
    const state = expectReplay(fixture);
    expect(state.log).toEqual(fixture.log);
    const types = new Set(fixture.log.map((e) => e.type));
    expect(types).toEqual(new Set(["BuildRoad", "BuildRoadGrid", "BulldozeRoad", "SetSpeed", "ZoneCells"]));
    // Every zone and every density is on the ground at the end.
    expect(new Set(state.cells.zone)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(new Set(state.cells.density)).toEqual(new Set([0, 1, 2, 3]));
  });

  it("gives the same hash on every run", () => {
    const hashes = [runFixture(fixture).hash, runFixture(fixture).hash, runFixture(fixture).hash];
    expect(new Set(hashes)).toEqual(new Set([fixture.hash]));
  });

  it.each([1, 7])("matches the same commands stepped live, with %d paused steps", (pausedSteps) => {
    const live = playLive(pausedSteps);
    expect(live.log).toEqual(fixture.log);
    expect(hashState(live)).toBe(fixture.hash);
  });

  it.each([2, 5, 7, 13])("matches a city saved and loaded at tick %d", (tick) => {
    expect(hashState(playLive(1, tick))).toBe(fixture.hash);
  });
});

describe("pausing while a stroke waits (M2 review, #147)", () => {
  it("applies the player's SetSpeed at once, and the stroke with it once paused", () => {
    const state = createState(SEED);
    ok(state, command("BuildRoadGrid", { origin: { x: 4104, z: 4404 }, along: { x: 4680, z: 4404 }, across: { x: 4104, z: 4980 }, depth: 86, width: 86, type: "street" }));
    const stroke = zone("residential", 1, [rect([4110, 4500], [4366, 4500], 200)]);
    const pause = command("SetSpeed", { speed: 0 });
    expect(submit(state, stroke)).toEqual({ ok: true });
    expect(submit(state, pause)).toEqual({ ok: true });
    step(state);
    expect(state.speed).toBe(0);
    expect(state.pending.map((c) => c.seq)).toEqual([stroke.seq]);
    // Paused, nothing waits: the next step paints.
    step(state);
    expect(state.log.at(-1)?.seq).toBe(stroke.seq);
  });
});

// M2-07: the zone tool. Its payloads, previews and input handling, run on a
// sim state the way the page runs them on the mirror's copy.
import { describe, expect, it } from "vitest";
import {
  CELL_OPEN,
  DENSITY_NONE,
  ZONE_NONE,
  ZONING_BALANCE,
  cellStatuses,
  cellsInBox,
  createState,
  hashState,
  planZoneCells,
  step,
  submit,
  type CommandResult,
  type SimState,
  type ZoneCellsPayload,
} from "@city-council/sim";
import {
  INITIAL_ZONE_TOOL,
  ZoneToolController,
  cellUnder,
  nearerSide,
  previewZone,
  rectsFor,
  stripCells,
  zonePayloads,
  type ZoneTarget,
  type ZoneToolHost,
} from "../src/tools/zone-tool";
import { INITIAL_ROAD_TOOL } from "../src/tools/road-tool";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const R = ZONING_BALANCE.zones.findIndex((z) => z.id === "residential") + 1;

let seq = 0;
function run(state: SimState, type: string, payload: unknown): void {
  const result = submit(state, { seq: ++seq, playerId: "p1", type, payload });
  expect(result, `${type} ${JSON.stringify(payload)}`).toEqual({ ok: true });
  step(state);
}

function road(state: SimState, from: [number, number], to: [number, number], control?: [number, number]): void {
  const payload: Record<string, unknown> = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" };
  if (control) payload["control"] = { x: control[0], z: control[1] };
  run(state, "BuildRoad", payload);
}

/** A street east from (4200, 4600), 24 cells long, and a second one 120 m north of it. */
function city(): SimState {
  const state = createState(SEED);
  road(state, [4200, 4600], [4392, 4600]);
  road(state, [4200, 4480], [4392, 4480]);
  return state;
}

/** The segment of the street through (x, z) running east: the one whose cell lies just north of it. */
function segmentAt(state: SimState, x: number, z: number): number {
  const cell = cellsInBox(state, x - 4, z - 13, x + 4, z - 5)[0];
  if (!cell) throw new Error(`no cell beside (${x}, ${z})`);
  return cell.segment;
}

/** Applies every payload, as the page sends them. */
function paint(state: SimState, payloads: readonly ZoneCellsPayload[]): void {
  for (const p of payloads) run(state, "ZoneCells", p);
}

function zonedSlots(state: SimState): number[] {
  const out: number[] = [];
  state.cells.zone.forEach((z, slot) => {
    if (z !== ZONE_NONE) out.push(slot);
  });
  return out;
}

function openOf(state: SimState, cells: readonly ZoneTarget[]): ZoneTarget[] {
  const status = cellStatuses(state);
  return cells.filter((c) => status[c.slot] === CELL_OPEN);
}

describe("fill", () => {
  it("paints the strip on one side, as deep as asked and no deeper", () => {
    const state = city();
    const seg = segmentAt(state, 4300, 4600);
    const side = nearerSide(state, seg, 4300, 4590);
    expect(side).not.toBeNull();
    const strip = stripCells(state, seg, side ?? 0, 2);
    expect(strip.every((c) => c.depth < 2 && c.side === side && c.segment === seg)).toBe(true);
    const preview = previewZone(state, "residential", 1, strip);
    expect(preview.ok).toBe(true);
    // One command for the whole strip.
    expect(preview.payloads).toHaveLength(1);
    const open = openOf(state, strip);
    expect(preview.cells.map((c) => c.slot).sort((a, b) => a - b)).toEqual(open.map((c) => c.slot).sort((a, b) => a - b));
    paint(state, preview.payloads);
    expect(zonedSlots(state)).toEqual(open.map((c) => c.slot).sort((a, b) => a - b));
    // Two rows: the road-edge row and the one behind it, on every open place.
    expect(new Set(open.map((c) => c.depth))).toEqual(new Set([0, 1]));
    for (const slot of zonedSlots(state)) {
      expect(state.cells.zone[slot]).toBe(R);
      expect(state.cells.density[slot]).toBe(1);
    }
  });

  it("takes the side nearer the pointer", () => {
    const state = city();
    const seg = segmentAt(state, 4300, 4600);
    const north = nearerSide(state, seg, 4300, 4590);
    const south = nearerSide(state, seg, 4300, 4610);
    expect(north).not.toBe(south);
  });

  it("paints exactly the cells of a curved strip at full depth", () => {
    const state = createState(SEED);
    road(state, [4200, 4800], [4440, 4800], [4320, 4660]);
    const seg = cellsInBox(state, 4100, 4600, 4700, 5000)[0]?.segment ?? -1;
    for (const side of [0, 1]) {
      const before = zonedSlots(state);
      const strip = stripCells(state, seg, side, DEPTH);
      const preview = previewZone(state, "commercial", 2, strip);
      expect(preview.ok).toBe(true);
      const open = openOf(state, strip).map((c) => c.slot);
      expect([...preview.cells.map((c) => c.slot)].sort((a, b) => a - b)).toEqual([...open].sort((a, b) => a - b));
      paint(state, preview.payloads);
      expect(zonedSlots(state)).toEqual([...before, ...open].sort((a, b) => a - b));
    }
  });

  it("sends nothing where nothing would change", () => {
    const state = city();
    const seg = segmentAt(state, 4300, 4600);
    const strip = stripCells(state, seg, 0, DEPTH);
    paint(state, previewZone(state, "residential", 1, strip).payloads);
    const again = previewZone(state, "residential", 1, strip);
    expect(again.ok).toBe(false);
    expect(again.payloads).toEqual([]);
    expect(again.reason).toMatch(/no cell would change/);
    // Another density changes them all again.
    expect(previewZone(state, "residential", 2, strip).ok).toBe(true);
  });
});

describe("brush", () => {
  it("paints the cells under the pointer on two streets", () => {
    const state = city();
    // A drag north from beside the south street, across the north one.
    const cells: ZoneTarget[] = [];
    for (let z = 4590; z >= 4460; z -= 2) {
      const cell = cellUnder(state, 4300, z);
      if (cell && !cells.some((c) => c.slot === cell.slot)) cells.push(cell);
    }
    const segs = new Set(cells.map((c) => c.segment));
    expect(segs.size).toBe(2);
    const preview = previewZone(state, "industrial", 3, cells);
    expect(preview.ok).toBe(true);
    expect(preview.cells).toHaveLength(cells.length);
    paint(state, preview.payloads);
    expect(zonedSlots(state)).toEqual(cells.map((c) => c.slot).sort((a, b) => a - b));
  });

  it("cuts a stroke too long for one command into several", () => {
    const state = city();
    const seg = segmentAt(state, 4300, 4600);
    // Every other cell along the strip, so no two share a column run.
    const cells = [...stripCells(state, seg, 0, DEPTH), ...stripCells(state, seg, 1, DEPTH)].filter((c) => c.depth % 2 === 0);
    const open = openOf(state, cells);
    expect(rectsFor(open).length).toBeGreaterThan(ZONING_BALANCE.maxRectsPerCommand);
    const payloads = zonePayloads("office", 1, open);
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((p) => p.rects.length <= ZONING_BALANCE.maxRectsPerCommand)).toBe(true);
    const preview = previewZone(state, "office", 1, open);
    paint(state, preview.payloads);
    expect(zonedSlots(state)).toEqual(open.map((c) => c.slot).sort((a, b) => a - b));
  });
});

describe("erase", () => {
  it("clears painted cells", () => {
    const state = city();
    const seg = segmentAt(state, 4300, 4600);
    const strip = stripCells(state, seg, 0, 3);
    paint(state, previewZone(state, "mixed", 2, strip).payloads);
    expect(zonedSlots(state).length).toBeGreaterThan(0);
    const erase = previewZone(state, "none", 2, strip);
    expect(erase.ok).toBe(true);
    expect(erase.payloads.every((p) => p.density === undefined)).toBe(true);
    paint(state, erase.payloads);
    expect(zonedSlots(state)).toEqual([]);
    expect(state.cells.density.every((d) => d === DENSITY_NONE)).toBe(true);
  });
});

describe("the controller", () => {
  type Store = ReturnType<ZoneToolHost["get"]>;
  function setup() {
    const state = city();
    let store: Store = { ...INITIAL_ROAD_TOOL, ...INITIAL_ZONE_TOOL };
    const sent: ZoneCellsPayload[] = [];
    let answer: (r: CommandResult) => void = () => undefined;
    const tool = new ZoneToolController({
      get: () => store,
      set: (patch) => {
        const before = store.tool;
        store = { ...store, ...patch };
        if (store.tool !== before) tool.toolChanged(store.tool, before);
      },
      city: () => state,
      version: () => state.tick,
      send: (payload) => {
        sent.push(payload);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      strokeId: () => 41,
    });
    return { state, tool, sent, get: () => store, answer: (r: CommandResult) => answer(r) };
  }

  it("opens and closes with its button", () => {
    const { tool, get } = setup();
    tool.toggle();
    expect(get().tool).toBe("zone");
    tool.toggle();
    expect(get().tool).toBeNull();
  });

  it("sends one ZoneCells for a fill click, keeps it marked until it is applied, and nothing for a click that changes nothing", async () => {
    const { state, tool, sent, get, answer } = setup();
    tool.toggle();
    tool.setDepth(2);
    const hover = { ground: { x: 4300, z: 4592 }, segment: segmentAt(state, 4300, 4600) };
    const preview = tool.preview(hover);
    expect(preview?.ok).toBe(true);
    tool.click(hover);
    expect(sent).toHaveLength(1);
    // One command is the whole stroke: it needs no stroke id.
    expect(sent[0]?.stroke).toBeUndefined();
    expect(get().zonePending).toHaveLength(1);
    // Applied by the sim, and the delta that carries it is in the copy: the mark goes.
    paint(state, sent);
    answer({ ok: true });
    await Promise.resolve();
    expect(get().zonePending).toHaveLength(0);
    // Nothing left to change: nothing is sent.
    const hash = hashState(state);
    tool.click(hover);
    expect(sent).toHaveLength(1);
    expect(get().zoneNote).toMatch(/no cell would change/);
    expect(hashState(state)).toBe(hash);
  });

  it("brushes a drag into one command, and Escape drops a stroke", () => {
    const { state, tool, sent, get } = setup();
    tool.toggle();
    tool.pickMode("brush");
    expect(tool.brushing()).toBe(true);
    tool.dragStart();
    for (let x = 4250; x <= 4330; x += 4) tool.brushOver(x, 4590);
    expect(get().zoneBrush?.length).toBeGreaterThan(5);
    expect(tool.escape()).toBe(true);
    expect(get().zoneBrush).toBeNull();
    expect(get().tool).toBe("zone");
    tool.dragStart();
    for (let x = 4250; x <= 4330; x += 4) tool.brushOver(x, 4590);
    tool.dragEnd();
    expect(sent).toHaveLength(1);
    const plan = planZoneCells(state, sent[0]);
    expect(plan.ok && plan.plan.cells.length).toBe(11);
  });

  it("gives every command of a stroke too big for one the same stroke id, so one undo takes it all back", () => {
    const { tool, sent } = setup();
    tool.toggle();
    tool.pickMode("brush");
    tool.dragStart();
    // Every other row back from the road, so no two cells of a column share a rectangle.
    for (let x = 4204; x < 4392; x += 8) for (const z of [4591, 4575, 4559]) tool.brushOver(x, z);
    tool.dragEnd();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((p) => p.stroke)).toEqual(sent.map(() => 41));
  });

  it("sends nothing for a second click on a stroke still on its way", () => {
    const { state, tool, sent, get } = setup();
    tool.toggle();
    const hover = { ground: { x: 4300, z: 4592 }, segment: segmentAt(state, 4300, 4600) };
    tool.click(hover);
    tool.click(hover);
    expect(sent).toHaveLength(1);
    expect(get().zoneNote).toMatch(/being zoned already/);
  });

  it("drops a stroke a lost drag left behind instead of painting it with the next click", () => {
    const { state, tool, sent } = setup();
    tool.toggle();
    tool.pickMode("brush");
    tool.dragStart();
    for (let x = 4250; x <= 4330; x += 4) tool.brushOver(x, 4590);
    // No dragEnd or dragCancel: the drag was taken over. A click paints only the cell under it.
    tool.click({ ground: { x: 4204, z: 4580 }, segment: -1 });
    expect(sent).toHaveLength(1);
    const plan = planZoneCells(state, sent[0]);
    expect(plan.ok && plan.plan.cells.length).toBe(1);
  });

  it("drops its stroke when another tool is picked", () => {
    const { tool, get } = setup();
    tool.toggle();
    tool.pickMode("brush");
    tool.dragStart();
    tool.brushOver(4300, 4590);
    expect(get().zoneBrush).toHaveLength(1);
    // As the road tool's toggle does.
    (tool as unknown as { host: ZoneToolHost }).host.set({ tool: "road" });
    expect(get().zoneBrush).toBeNull();
  });
});

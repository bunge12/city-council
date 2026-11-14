// Snapping to zoning cells (issue M2-08), on a city the sim built and
// zoned, read the way the client reads its mirror.
import { describe, expect, it } from "vitest";
import {
  CELL_OPEN,
  ROAD_TYPES,
  ZONING_BALANCE,
  cellAt,
  createBareState,
  generateTerrain,
  step,
  submit,
  type BuildPoint,
  type SimState,
} from "@city-council/sim";
import { snapMarks } from "../src/render/snap-marks-geometry";
import { zonedCellLookup } from "../src/tools/cell-snap";
import { CELL_SNAP, DEFAULT_GUIDES, type GuideToggles } from "../src/tools/config";
import { GridToolController, INITIAL_GRID_TOOL } from "../src/tools/grid-tool";
import { SNAP_SOURCES, nodeSource, snapPoint, startSource, type SnapContext } from "../src/tools/snap";

const SEED = 2026;
const terrain = generateTerrain(SEED);
const CELL = ZONING_BALANCE.cellSize;
const DEPTH = ZONING_BALANCE.zoneDepthCells;
const STREET = ROAD_TYPES.find((t) => t.id === "street")?.width ?? 0;

// A street west to east along z = 4600, from x = 4200 to 4392: 24 places.
// Its north side (side 0, toward smaller z) has cells from the road's edge
// at 4595 back to 4547; places run 8 m apart from x = 4200.
const Z = 4600;
const EDGE = Z - STREET / 2;
const BACK = EDGE - DEPTH * CELL;
// The zoned run: places 4 to 11 on the north side, every row.
const RUN_X0 = 4232;
const RUN_X1 = 4296;

function city(zone = true): SimState {
  const state = createBareState(SEED);
  let seq = 0;
  const send = (type: string, payload: unknown) => {
    const result = submit(state, { seq: ++seq, playerId: "test", type, payload });
    if (!result.ok) throw new Error(`${type} refused: ${result.reason}`);
    step(state);
  };
  send("BuildRoad", { from: { x: 4200, z: Z }, to: { x: 4392, z: Z }, type: "street" });
  if (zone) {
    const mid = (EDGE + BACK) / 2;
    send("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: RUN_X0 + 1, z: mid }, to: { x: RUN_X1 - 1, z: mid }, width: DEPTH * CELL - 2 }] });
  }
  for (let i = 0; i < 5; i++) step(state);
  return state;
}

const zoned = city();

type Over = Partial<Omit<SnapContext, "guides">> & { guides?: Partial<GuideToggles> };

/** A context on `state` for a road from `start`, at one metre a pixel unless told otherwise. Guide lines and offsets are off, so the cell sources are seen alone. */
function ctx(state: SimState, start: BuildPoint | null, over: Over = {}): SnapContext {
  const { guides, ...rest } = over;
  return {
    net: state.roads,
    start,
    source: start ? startSource(state.roads, start) : null,
    metresPerPixel: 1,
    guides: { ...DEFAULT_GUIDES, lines: false, offset: false, ...guides },
    free: false,
    gridStep: terrain.spacing,
    roadWidth: STREET,
    cells: zonedCellLookup(state),
    ...rest,
  };
}

/** Where the line behind the strip runs for a road of width `w`: its centre, clear of the cells. */
const behind = (w: number) => BACK - w / 2 - CELL_SNAP.clearance;

describe("the cell sources", () => {
  it("catch a cursor near a corner of the zoned area, set back for the road", () => {
    const s = snapPoint(RUN_X0 - 4, behind(STREET) - 1, ctx(zoned, null));
    expect(s.kind).toBe("corner");
    expect(s.x).toBeCloseTo(RUN_X0 - STREET / 2 - CELL_SNAP.clearance, 6);
    expect(s.z).toBeCloseTo(behind(STREET), 6);
  });

  it("catch a cursor near where a cell line meets the back of the strip", () => {
    const s = snapPoint(RUN_X0 + CELL + 1, behind(STREET) + 1, ctx(zoned, null));
    expect(s.kind).toBe("corner");
    expect(s.x).toBeCloseTo(RUN_X0 + CELL, 6);
    expect(s.z).toBeCloseTo(behind(STREET), 6);
  });

  it("catch a cursor near the back edge, and slide it along the line behind the strip", () => {
    // Zoomed in, so the corners 4 m away do not reach.
    const s = snapPoint(4260, behind(STREET) + 1.5, ctx(zoned, null, { metresPerPixel: 0.2 }));
    expect(s.kind).toBe("edge");
    expect(s.x).toBeCloseTo(4260, 6);
    expect(s.z).toBeCloseTo(behind(STREET), 6);
    expect(s.cellEdges).toEqual([{ ax: 4264, az: BACK, bx: 4256, bz: BACK }]);
  });

  it("catch a cursor near a cell line across the strip, on the line itself", () => {
    const s = snapPoint(4249, 4570, ctx(zoned, null, { metresPerPixel: 0.2 }));
    expect(s.kind).toBe("edge");
    expect(s.x).toBeCloseTo(4248, 6);
    expect(s.z).toBeCloseTo(4570, 6);
  });

  it("offer no line between two rows of the strip", () => {
    // 0.5 m off the line between rows 2 and 3, 4 m from any cell line across.
    const s = snapPoint(4252, EDGE - 3 * CELL + 0.5, ctx(zoned, null, { metresPerPixel: 0.2 }));
    expect(s.kind).toBe("none");
  });

  it("set the line back by half the width of the road being drawn", () => {
    const avenue = ROAD_TYPES.find((t) => t.id === "avenue")?.width ?? 0;
    expect(avenue).toBeGreaterThan(STREET);
    const s = snapPoint(4260, behind(avenue) + 1.5, ctx(zoned, null, { metresPerPixel: 0.2, roadWidth: avenue }));
    expect(s.kind).toBe("edge");
    expect(s.z).toBeCloseTo(behind(avenue), 6);
  });

  it("put a point where a cell line meets the strip's road on that road's centre line", () => {
    const s = snapPoint(RUN_X0 + 2 * CELL + 1.5, Z - 1, ctx(zoned, null, { metresPerPixel: 0.5 }));
    expect(s.kind).toBe("corner");
    expect(s.segment).toBe(0);
    expect(s.x).toBeCloseTo(RUN_X0 + 2 * CELL, 6);
    expect(s.z).toBeCloseTo(Z, 6);
  });

  it("set the end of the zoned area back for the road where it meets the strip's road", () => {
    const s = snapPoint(RUN_X1 + 4, Z - 1, ctx(zoned, null, { metresPerPixel: 0.5 }));
    expect(s.kind).toBe("corner");
    expect(s.x).toBeCloseTo(RUN_X1 + STREET / 2 + CELL_SNAP.clearance, 6);
    expect(s.z).toBeCloseTo(Z, 6);
  });

  it("give no point on the road a new road starts from", () => {
    const start = { x: 4244, z: Z };
    const s = snapPoint(RUN_X0 + 2 * CELL + 1.5, Z - 1, ctx(zoned, start, { metresPerPixel: 0.5, guides: { angle: false, length: false } }));
    expect(s.kind).not.toBe("corner");
  });

  it("leave a node to win over a cell corner in reach of both", () => {
    // A node at the run's corner on the road: the street's west end, with the run starting there.
    const state = createBareState(SEED);
    let seq = 0;
    const send = (type: string, payload: unknown) => {
      expect(submit(state, { seq: ++seq, playerId: "test", type, payload })).toEqual({ ok: true });
      step(state);
    };
    send("BuildRoad", { from: { x: 4200, z: Z }, to: { x: 4392, z: Z }, type: "street" });
    const mid = (EDGE + BACK) / 2;
    send("ZoneCells", { zone: "residential", density: 1, rects: [{ from: { x: 4201, z: mid }, to: { x: 4263, z: mid }, width: DEPTH * CELL - 2 }] });
    const cursor = { x: 4203, z: Z - 2 };
    const c = ctx(state, null);
    // Both reach: without the node source, a cell corner catches the cursor.
    expect(snapPoint(cursor.x, cursor.z, c, SNAP_SOURCES.filter((s) => s !== nodeSource)).kind).toBe("corner");
    const s = snapPoint(cursor.x, cursor.z, c);
    expect(s.kind).toBe("node");
    expect([s.x, s.z]).toEqual([4200, Z]);
  });

  it("catch nothing beside cells that are not zoned", () => {
    const s = snapPoint(4260, Z + STREET / 2 + DEPTH * CELL + STREET / 2 + 1, ctx(zoned, null, { metresPerPixel: 0.2 }));
    expect(s.kind).toBe("none");
  });

  it("are turned off by their toggle, by the free-hand key, and when zoomed far out", () => {
    const cursor = { x: RUN_X0 + CELL + 1, z: behind(STREET) + 1 };
    expect(snapPoint(cursor.x, cursor.z, ctx(zoned, null)).kind).toBe("corner");
    expect(snapPoint(cursor.x, cursor.z, ctx(zoned, null, { guides: { cells: false } })).kind).toBe("none");
    expect(snapPoint(cursor.x, cursor.z, ctx(zoned, null, { free: true })).kind).toBe("none");
    expect(snapPoint(cursor.x, cursor.z, ctx(zoned, null, { metresPerPixel: CELL_SNAP.maxMetresPerPixel * 1.5 })).kind).toBe("none");
    expect(snapPoint(cursor.x, cursor.z, ctx(zoned, null, { cells: null })).kind).toBe("none");
  });

  it("win over the six-cell parallel offset behind a straight strip", () => {
    const s = snapPoint(4260, behind(STREET) + 1.5, ctx(zoned, null, { metresPerPixel: 0.2, guides: { offset: true } }));
    expect(s.kind).toBe("edge");
  });

  it("are marked on screen: the cell edges, the line and a diamond at a corner", () => {
    const corner = snapPoint(RUN_X0 + CELL + 1, behind(STREET) + 1, ctx(zoned, null));
    const marks = snapMarks(corner, null, 1);
    expect(marks.some((m) => m.shape === "diamond" && m.look === "cell")).toBe(true);
    expect(marks.filter((m) => m.shape === "line" && m.look === "cell")).toHaveLength(2);
    const edge = snapPoint(4260, behind(STREET) + 1.5, ctx(zoned, null, { metresPerPixel: 0.2 }));
    expect(snapMarks(edge, null, 0.2).filter((m) => m.shape === "line" && m.look === "cell")).toHaveLength(2);
  });
});

describe("a road drawn with the cell snap", () => {
  /** The zone and whether it is open of each cell of the run, by its centre, place 4 to 11 and row 0 to 5. */
  function run(state: SimState): { place: number; open: boolean; zone: number }[] {
    const out: { place: number; open: boolean; zone: number }[] = [];
    for (let place = 4; place < 12; place++) {
      for (let row = 0; row < DEPTH; row++) {
        const cell = cellAt(state, 4200 + place * CELL + CELL / 2, EDGE - row * CELL - CELL / 2);
        out.push({ place, open: cell?.status === CELL_OPEN, zone: cell ? (state.cells.zone[cell.index] ?? 0) : 0 });
      }
    }
    return out;
  }

  it("along the back of a strip leaves every cell of the strip open", () => {
    const state = city();
    expect(run(state).every((c) => c.open && c.zone !== 0)).toBe(true);
    const from = snapPoint(RUN_X0 - 4, behind(STREET) - 1, ctx(state, null));
    const to = snapPoint(RUN_X1 + 4, behind(STREET) - 1, ctx(state, from, { guides: { angle: false, length: false } }));
    expect([from.kind, to.kind]).toEqual(["corner", "corner"]);
    expect(submit(state, { seq: 99, playerId: "test", type: "BuildRoad", payload: { from, to, type: "street" } })).toEqual({ ok: true });
    for (let i = 0; i < 5; i++) step(state);
    expect(run(state).every((c) => c.open && c.zone !== 0)).toBe(true);
  });

  it("across a strip on a cell line blocks only the two columns beside that line", () => {
    const state = city();
    const line = RUN_X0 + 4 * CELL;
    const from = snapPoint(line + 1, behind(STREET) - 1, ctx(state, null));
    const to = snapPoint(line + 1, Z - 1, ctx(state, from, { metresPerPixel: 0.5 }));
    expect([from.kind, to.kind]).toEqual(["corner", "corner"]);
    expect([from.x, to.x, to.z]).toEqual([line, line, Z]);
    expect(submit(state, { seq: 99, playerId: "test", type: "BuildRoad", payload: { from, to, type: "street" } })).toEqual({ ok: true });
    for (let i = 0; i < 5; i++) step(state);
    // The line runs between places 7 and 8; a street 10 m wide covers part of each.
    for (const c of run(state)) expect(c.open, `place ${c.place}`).toBe(c.place !== 7 && c.place !== 8);
  });
});

describe("the grid tool's corners", () => {
  it("snap to the same cell corners, and the toggle turns them off", () => {
    let s = { ...INITIAL_GRID_TOOL, tool: "grid" as const, roadType: "street" as const, guides: DEFAULT_GUIDES };
    const tool = new GridToolController({
      get: () => s,
      set: () => {},
      world: () => ({ net: zoned.roads, terrain, cells: zonedCellLookup(zoned) }),
      send: () => Promise.resolve({ ok: true }),
    });
    const ground = { x: RUN_X0 - 4, z: behind(STREET) - 1 };
    const hit = tool.snap(ground, { metresPerPixel: 1, free: false });
    expect(hit?.kind).toBe("corner");
    expect(hit?.x).toBeCloseTo(RUN_X0 - STREET / 2 - CELL_SNAP.clearance, 6);
    s = { ...s, guides: { ...DEFAULT_GUIDES, cells: false } };
    expect(tool.snap(ground, { metresPerPixel: 1, free: false })?.kind).toBe("none");
  });
});

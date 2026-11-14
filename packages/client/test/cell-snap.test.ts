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
    const cursor = { x: 4201.5, z: Z - 1 };
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
    // From a start on the cell line, the square join onto the street is the cell line's foot.
    const to = snapPoint(line + 1, Z - 1, ctx(state, from, { metresPerPixel: 0.5 }));
    expect([from.kind, to.kind]).toEqual(["corner", "segment"]);
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

// Issue M2-08 review: layouts where the cells of two strips, or two
// segments, do not share their corners. Every line and corner the snap
// offers must leave a road of the width being drawn clear of every zoned
// cell and off every road but the one it joins.
describe("lines offered where cells do not line up", () => {
  type Seg = [BuildPoint, BuildPoint];
  type Rect = { from: BuildPoint; to: BuildPoint; width: number };

  function layout(roads: Seg[], rects: Rect[]): SimState {
    const state = createBareState(SEED);
    let seq = 0;
    const send = (type: string, payload: unknown) => {
      const result = submit(state, { seq: ++seq, playerId: "test", type, payload });
      if (!result.ok) throw new Error(`${type} refused: ${result.reason}`);
      step(state);
    };
    for (const [from, to] of roads) send("BuildRoad", { from, to, type: "street" });
    send("ZoneCells", { zone: "residential", density: 1, rects });
    for (let i = 0; i < 5; i++) step(state);
    return state;
  }

  /** Distance from (x, z) to the quad, 0 inside it. */
  function toQuad(q: ArrayLike<number>, x: number, z: number): number {
    let inside = true;
    let sign = 0;
    let best = Infinity;
    for (let k = 0; k < 4; k++) {
      const ax = q[k * 2] ?? 0;
      const az = q[k * 2 + 1] ?? 0;
      const bx = q[((k + 1) % 4) * 2] ?? 0;
      const bz = q[((k + 1) % 4) * 2 + 1] ?? 0;
      const c = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const s = Math.sign(c);
      if (sign === 0) sign = s;
      else if (s !== sign) inside = false;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    return inside ? 0 : best;
  }

  /** Corners of every zoned, open cell in the box. */
  function zonedQuads(state: SimState, minX: number, minZ: number, maxX: number, maxZ: number): number[][] {
    return zonedCellLookup(state)(minX, minZ, maxX, maxZ).map((c) => Array.from(c.corners));
  }

  /** Every edge and corner the cell sources offer for cursors over the box, at a few zooms. */
  function offered(state: SimState, minX: number, minZ: number, maxX: number, maxZ: number) {
    const hits: ReturnType<typeof snapPoint>[] = [];
    for (const mpp of [0.2, 0.5, 1]) {
      for (let x = minX; x <= maxX; x += 1.5) {
        for (let z = minZ; z <= maxZ; z += 1.5) {
          const s = snapPoint(x, z, ctx(state, null, { metresPerPixel: mpp }));
          if (s.kind === "corner" || s.kind === "edge") hits.push(s);
        }
      }
    }
    return hits;
  }

  /** Each offered point clear of the zoned cells by half a street, unless it lies on a cell line or on a road's centre line. */
  function expectClear(state: SimState, minX: number, minZ: number, maxX: number, maxZ: number): number {
    const quads = zonedQuads(state, minX - 60, minZ - 60, maxX + 60, maxZ + 60);
    const hits = offered(state, minX, minZ, maxX, maxZ);
    let outside = 0;
    for (const h of hits) {
      if (h.kind === "corner" && h.segment !== undefined) continue;
      const e = h.cellEdges?.[0];
      const onCellLine = h.kind === "edge" && e && h.edgeLine && Math.abs(h.edgeLine.ax - e.ax) < 1e-9 && Math.abs(h.edgeLine.az - e.az) < 1e-9;
      if (onCellLine) continue;
      outside++;
      const l = h.kind === "edge" ? h.edgeLine : undefined;
      const points = l ? [0, 0.25, 0.5, 0.75, 1].map((t) => ({ x: l.ax + (l.bx - l.ax) * t, z: l.az + (l.bz - l.az) * t })) : [h];
      for (const p of points) {
        const d = Math.min(...quads.map((q) => toQuad(q, p.x, p.z)));
        expect(d, `${h.kind} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`).toBeGreaterThan(STREET / 2 - 0.02);
      }
    }
    return outside;
  }

  it("between two strips back to back whose cells are offset along the road", () => {
    // Twelve cells edge to edge, the second street starting 3 m further east.
    const north = 4494;
    const state = layout(
      [
        [{ x: 4200, z: Z }, { x: 4392, z: Z }],
        [{ x: 4203, z: north }, { x: 4395, z: north }],
      ],
      [
        { from: { x: 4210, z: (EDGE + BACK) / 2 }, to: { x: 4380, z: (EDGE + BACK) / 2 }, width: DEPTH * CELL - 2 },
        { from: { x: 4213, z: north + STREET / 2 + (DEPTH * CELL) / 2 }, to: { x: 4383, z: north + STREET / 2 + (DEPTH * CELL) / 2 }, width: DEPTH * CELL - 2 },
      ],
    );
    expectClear(state, 4240, BACK - 8, 4330, BACK + 8);
    // Nothing runs along the backs: there is no room for a road between the strips.
    const along = offered(state, 4240, BACK - 8, 4330, BACK + 8).filter((h) => h.kind === "edge" && h.edgeLine && Math.abs(h.edgeLine.az - h.edgeLine.bz) < 1e-6);
    expect(along).toEqual([]);
  });

  it("in front of a strip whose first row is not zoned", () => {
    const mid = (EDGE - CELL + BACK) / 2;
    const state = layout([[{ x: 4200, z: Z }, { x: 4392, z: Z }]], [{ from: { x: RUN_X0 + 1, z: mid }, to: { x: RUN_X1 - 1, z: mid }, width: (DEPTH - 1) * CELL - 2 }]);
    expectClear(state, RUN_X0 - 10, EDGE - 2 * CELL, RUN_X1 + 10, Z);
    // No line runs along the road's side of the strip, where a road would overlap the street.
    const front = offered(state, RUN_X0, EDGE - CELL - 6, RUN_X1, Z).filter((h) => h.kind === "edge" && h.edgeLine && Math.abs(h.edgeLine.az - h.edgeLine.bz) < 1e-6);
    expect(front).toEqual([]);
  });

  it("at a bend, where the cells of two segments leave a wedge between them", () => {
    // A 15 degree bend at (4300, 4600), zoned on its outer side along both segments.
    const bend = { x: 4300, z: Z };
    const far = { x: 4300 + 96 * Math.cos(Math.PI / 12), z: Z + 96 * Math.sin(Math.PI / 12) };
    const mid = (EDGE + BACK) / 2;
    const state = layout(
      [
        [{ x: 4204, z: Z }, bend],
        [bend, { x: Math.round(far.x * 8) / 8, z: Math.round(far.z * 8) / 8 }],
      ],
      [{ from: { x: 4210, z: mid }, to: { x: 4298, z: mid }, width: DEPTH * CELL - 2 }],
    );
    // Zone the second segment's outer side by its own direction.
    const ux = Math.cos(Math.PI / 12);
    const uz = Math.sin(Math.PI / 12);
    const off = STREET / 2 + (DEPTH * CELL) / 2;
    const r = submit(state, {
      seq: 50,
      playerId: "test",
      type: "ZoneCells",
      payload: { zone: "residential", density: 1, rects: [{ from: { x: bend.x + ux * 4 + uz * off, z: bend.z + uz * 4 - ux * off }, to: { x: bend.x + ux * 90 + uz * off, z: bend.z + uz * 90 - ux * off }, width: DEPTH * CELL - 2 }] },
    });
    expect(r).toEqual({ ok: true });
    for (let i = 0; i < 5; i++) step(state);
    expectClear(state, 4285, BACK - 8, 4320, Z);
  });

  it("leave the square join onto a zoned street to the segment snap while a road is drawn", () => {
    const start = { x: 4261.5, z: 4450 };
    const s = snapPoint(4262, Z - 2, ctx(zoned, start));
    expect(s.kind).toBe("segment");
    expect(s.perpendicular).toBe(true);
    expect(s.x).toBeCloseTo(4261.5, 6);
    expect(s.square || s.perpendicular).toBe(true);
  });

  it("put no edge point on the surface of a road, where a new road would end on it", () => {
    const hits = offered(zoned, RUN_X0, Z - STREET, RUN_X1, Z + STREET).filter((h) => h.kind === "edge");
    for (const h of hits) expect(Math.abs(h.z - Z), `edge at (${h.x}, ${h.z})`).toBeGreaterThanOrEqual(STREET - 0.02);
  });
});

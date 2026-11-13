// Guide lines and parallel offset for the road tool (issue M1-19), on
// networks the sim itself built, read the way the client reads its mirror.
import { describe, expect, it } from "vitest";
import { ROAD_TYPES, createBareState, generateTerrain, step, submit, type BuildPoint, type SimState } from "@city-council/sim";
import { buildSnapMarks, snapMarks } from "../src/render/snap-marks-geometry";
import { DEFAULT_GUIDES, GUIDE_LINES, PARALLEL_GAP_CELLS, SNAP, type GuideToggles } from "../src/tools/config";
import { INITIAL_ROAD_TOOL, RoadToolController, previewRoad, type RoadToolState } from "../src/tools/road-tool";
import { guideLinesNear, snapPoint, startSource, type SnapContext } from "../src/tools/snap";
import { formatOffset, offsetCells } from "../src/ui/RoadReadout";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

type Road = [BuildPoint, BuildPoint, string?];

function build(roads: Road[]): SimState {
  const state = createBareState(SEED);
  let seq = 0;
  for (const [from, to, type = "street"] of roads) {
    const result = submit(state, { seq: ++seq, playerId: "test", type: "BuildRoad", payload: { from, to, type } });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    step(state);
  }
  return state;
}

const width = (id: string) => ROAD_TYPES.find((t) => t.id === id)?.width ?? 0;
const STREET = width("street");
const AVENUE = width("avenue");

/** A street west to east along z = 4600, ending at (4600, 4600). */
const A: Road = [{ x: 4200, z: 4600 }, { x: 4600, z: 4600 }];
const END: BuildPoint = { x: 4600, z: 4600 };

type Over = Partial<Omit<SnapContext, "guides" | "net">> & { guides?: Partial<GuideToggles> };

/** The context for a road from `start` on `state`'s roads, at one metre a pixel, every guide but the grid on. */
function ctx(state: SimState, start: BuildPoint | null, over: Over = {}): SnapContext {
  const { guides, ...rest } = over;
  return {
    net: state.roads,
    start,
    source: start ? startSource(state.roads, start) : null,
    metresPerPixel: 1,
    guides: { ...DEFAULT_GUIDES, ...guides },
    free: false,
    gridStep: terrain.spacing,
    roadWidth: STREET,
    ...rest,
  };
}

describe("the guide settings", () => {
  it("start on, and take the offsets from the zoning depth", () => {
    expect(DEFAULT_GUIDES.lines).toBe(true);
    expect(DEFAULT_GUIDES.offset).toBe(true);
    expect(SNAP.zoneDepthCells).toBe(6);
    // Two strips back to back first, one strip second.
    expect(PARALLEL_GAP_CELLS).toEqual([12, 6]);
  });
});

describe("guide lines", () => {
  const one = build([A]);

  it("catch a line square to a road through a node nearby", () => {
    // From open ground north-east, the cursor 3 m off the line x = 4600 square to the street at its end.
    const start = { x: 4300, z: 4800 };
    const s = snapPoint(4603, 4760, ctx(one, start));
    expect(s.kind).toBe("line");
    expect([s.x, s.z]).toEqual([4600, 4760]);
    const g = s.guides?.[0];
    expect(g?.kind).toBe("line");
    expect([g?.x, g?.z]).toEqual([4600, 4600]);
    expect(Math.abs(g?.dz ?? 0)).toBeCloseTo(1, 12);
  });

  it("catch a line in line with a road, past its end", () => {
    const start = { x: 4700, z: 4800 };
    const s = snapPoint(4680, 4603, ctx(one, start));
    expect(s.kind).toBe("line");
    expect(s.x).toBeCloseTo(4680, 9);
    expect(s.z).toBeCloseTo(4600, 9);
    expect(Math.abs(s.guides?.[0]?.dx ?? 0)).toBeCloseTo(1, 12);
  });

  it("reach only so far, in pixels", () => {
    const start = { x: 4300, z: 4800 };
    expect(snapPoint(4600 + GUIDE_LINES.linePx + 1, 4760, ctx(one, start)).kind).toBe("none");
    expect(snapPoint(4600 + GUIDE_LINES.linePx + 1, 4760, ctx(one, start, { metresPerPixel: 2 })).kind).toBe("line");
  });

  it("show only while a road is being drawn, never from its own start, and at most the limit at once", () => {
    expect(snapPoint(4603, 4760, ctx(one, null)).kind).toBe("none");
    // From the street's end, the lines through that end are the angle guide's work.
    const fromEnd = guideLinesNear(4603, 4760, ctx(one, END));
    expect(fromEnd.every((g) => g.line.x !== 4600 || g.line.z !== 4600)).toBe(true);
    const grid = build([
      [{ x: 4200, z: 4500 }, { x: 4600, z: 4500 }],
      [{ x: 4200, z: 4700 }, { x: 4600, z: 4700 }],
      [{ x: 4300, z: 4500 }, { x: 4300, z: 4700 }],
      [{ x: 4500, z: 4500 }, { x: 4500, z: 4700 }],
    ]);
    // Far out, where every line is near enough to catch at a crossing, the limit holds.
    const lines = guideLinesNear(4400, 4600, ctx(grid, { x: 4410, z: 4900 }, { metresPerPixel: 20 }));
    expect(lines.length).toBe(GUIDE_LINES.maxLines);
    // Nearest the cursor first.
    for (let i = 1; i < lines.length; i++) expect(lines[i]?.d ?? 0).toBeGreaterThanOrEqual(lines[i - 1]?.d ?? 0);
  });

  it("snap to the crossing where two lines cross", () => {
    // A second street north to south from (4800, 4400): lines x = 4800 and z = 4400 through its end.
    const two = build([A, [{ x: 4800, z: 4400 }, { x: 4800, z: 4200 }]]);
    const start = { x: 4400, z: 4300 };
    const s = snapPoint(4603, 4404, ctx(two, start));
    expect(s.kind).toBe("crossing");
    expect([s.x, s.z]).toEqual([4600, 4400]);
    expect(s.guides?.map((g) => g.kind)).toEqual(["line", "line"]);
  });

  it("from a curve, run only from its end nodes, along its tangent there", () => {
    const state = createBareState(SEED);
    const result = submit(state, {
      seq: 1,
      playerId: "test",
      type: "BuildRoad",
      payload: { from: { x: 4200, z: 4600 }, to: { x: 4400, z: 4600 }, control: { x: 4300, z: 4500 }, type: "street" },
    });
    expect(result.ok).toBe(true);
    step(state);
    const lines = guideLinesNear(4250, 4560, ctx(state, { x: 4250, z: 4800 }));
    for (const g of lines) expect([4200, 4400]).toContain(g.line.x);
    // The tangent at (4200, 4600) points at the control point, 45 degrees off the axes.
    expect(lines.some((g) => g.line.x === 4200 && Math.abs(Math.abs(g.line.dx) - Math.SQRT1_2) < 1e-9)).toBe(true);
  });
});

describe("parallel offset", () => {
  const one = build([A]);

  it("snaps a street beside a street to 12 and 6 cells between the edges", () => {
    const main = snapPoint(4400, 4600 + 96 + STREET + 4, ctx(one, null));
    expect(main.kind).toBe("offset");
    expect(main.x).toBeCloseTo(4400, 9);
    expect(main.z).toBeCloseTo(4600 + 96 + STREET, 9);
    expect(offsetCells(main)).toBe(12);
    // Edge to edge: the centre distance less half of each road.
    expect(main.z - 4600 - STREET / 2 - STREET / 2).toBeCloseTo(96, 9);
    const light = snapPoint(4400, 4600 + 48 + STREET - 3, ctx(one, null));
    expect(light.kind).toBe("offset");
    expect(light.z).toBeCloseTo(4600 + 48 + STREET, 9);
    expect(offsetCells(light)).toBe(6);
    // On the other side too.
    const north = snapPoint(4400, 4600 - 96 - STREET + 5, ctx(one, null));
    expect(north.z).toBeCloseTo(4600 - 96 - STREET, 9);
  });

  it("takes both widths, so an avenue beside a street sits further out than a street beside a street", () => {
    const avenue = snapPoint(4400, 4600 + 106 + 2, ctx(one, null, { roadWidth: AVENUE }));
    expect(avenue.kind).toBe("offset");
    expect(avenue.z).toBeCloseTo(4600 + 96 + STREET / 2 + AVENUE / 2, 9);
    const lightAvenue = snapPoint(4400, 4600 + 62, ctx(one, null, { roadWidth: AVENUE }));
    expect(lightAvenue.z).toBeCloseTo(4600 + 48 + STREET / 2 + AVENUE / 2, 9);
    // And the existing road's own width counts: a street beside an avenue.
    const besideAvenue = build([[{ x: 4200, z: 4600 }, { x: 4600, z: 4600 }, "avenue"]]);
    const s = snapPoint(4400, 4600 + 108, ctx(besideAvenue, null));
    expect(s.kind).toBe("offset");
    expect(s.z).toBeCloseTo(4600 + 96 + AVENUE / 2 + STREET / 2, 9);
    for (const g of PARALLEL_GAP_CELLS) expect(g * SNAP.cellSize + (AVENUE + STREET) / 2).not.toBe(g * SNAP.cellSize + STREET);
  });

  it("gives the main offset the longer reach, and lets it win when both reach", () => {
    // 10 m off the main line is outside the light reach, inside the main one.
    expect(snapPoint(4400, 4706 - 10, ctx(one, null)).kind).toBe("offset");
    expect(snapPoint(4400, 4658 + 10, ctx(one, null)).kind).toBe("none");
    // At 4 m a pixel both reach a point between them, and the main one wins.
    const both = snapPoint(4400, 4682, ctx(one, null, { metresPerPixel: 4 }));
    expect(offsetCells(both)).toBe(12);
  });

  it("only beside a road, not far past its ends, and not from a curve", () => {
    expect(snapPoint(4800, 4706, ctx(one, null)).kind).toBe("none");
    expect(snapPoint(4620, 4706, ctx(one, null)).kind).toBe("offset");
  });

  it("builds a road whose edge sits 96 m from the first", () => {
    const from = snapPoint(4250, 4709, ctx(one, null));
    const to = snapPoint(4550, 4703, ctx(one, from));
    // The end catches the offset, or its crossing with the line square to the street's end.
    expect(["offset", "crossing"]).toContain(to.kind);
    const preview = previewRoad(one.roads, terrain, from, to, "street");
    expect(preview.ok).toBe(true);
    const after = build([A, [from, to]]);
    const zs = new Set<number>();
    for (let n = 0; n < after.roads.nodeFlags.length; n++) if (((after.roads.nodeFlags[n] ?? 0) & 1) !== 0) zs.add(after.roads.nodeZ[n] ?? 0);
    expect([...zs].sort()).toEqual([4600, 4706]);
    expect(4706 - 4600 - STREET).toBe(96);
  });
});

describe("guide priority", () => {
  it("puts a node and a segment before both guides", () => {
    const one = build([A]);
    // Near the street's end, which also lies on a guide line from the west end: the node wins.
    expect(snapPoint(4603, 4602, ctx(one, { x: 4300, z: 4800 })).kind).toBe("node");
    // A second street on the 12 cell offset: near it, the segment wins over the offset.
    const two = build([A, [{ x: 4200, z: 4706 }, { x: 4600, z: 4706 }]]);
    expect(snapPoint(4400, 4708, ctx(two, null)).kind).toBe("segment");
  });

  it("puts the angle guide before a guide line or an offset on its own", () => {
    // A street north to south at x = 4610, from z = 4900: its line x = 4610 runs beside the 90 degree ray from END.
    const two = build([A, [{ x: 4610, z: 4900 }, { x: 4610, z: 5000 }]]);
    const s = snapPoint(4604, 4680, ctx(two, END, { guides: { length: false } }));
    expect(s.kind).toBe("angle");
    expect(s.x).toBeCloseTo(4600, 9);
    // With the angle guide off, the line takes it.
    const off = snapPoint(4604, 4680, ctx(two, END, { guides: { angle: false, length: false } }));
    expect(off.kind).toBe("line");
    expect(off.x).toBeCloseTo(4610, 9);
  });

  it("puts the crossing of an angle ray and a guide before the angle alone", () => {
    // From END, square off the street, toward the 12 cell offset of the street itself: the road ends on it.
    const one = build([A]);
    const s = snapPoint(4602, 4703, ctx(one, END));
    expect(s.kind).toBe("crossing");
    expect([s.x, s.z]).toEqual([4600, 4706]);
    expect(s.guides?.map((g) => g.kind).sort()).toEqual(["angle", "offset"]);
    expect(s.square).toBe(true);
    // A line from a node far east: z = 4900 through (4800, 4900). The 90 degree ray crosses it at (4600, 4900).
    const two = build([A, [{ x: 4800, z: 4900 }, { x: 4800, z: 5000 }]]);
    const t = snapPoint(4602, 4897, ctx(two, END));
    expect(t.kind).toBe("crossing");
    expect(t.x).toBeCloseTo(4600, 9);
    expect(t.z).toBeCloseTo(4900, 9);
  });

  it("puts a guide line before the grid", () => {
    const one = build([A]);
    const s = snapPoint(4603, 4761, ctx(one, { x: 4300, z: 4800 }, { guides: { grid: true } }));
    expect(s.kind).toBe("line");
  });
});

describe("turning the guides off", () => {
  const one = build([A]);
  const start = { x: 4300, z: 4800 };

  it("with both toggles off, neither guide snaps", () => {
    const off = { guides: { lines: false, offset: false } };
    expect(snapPoint(4603, 4760, ctx(one, start, off)).kind).toBe("none");
    expect(snapPoint(4400, 4709, ctx(one, null, off)).kind).toBe("none");
    expect(snapPoint(4602, 4703, ctx(one, END, { guides: { lines: false, offset: false, length: false } })).kind).toBe("angle");
    // Each toggle on its own.
    expect(snapPoint(4603, 4760, ctx(one, start, { guides: { lines: false } })).kind).toBe("none");
    expect(snapPoint(4400, 4709, ctx(one, null, { guides: { offset: false } })).kind).toBe("none");
  });

  it("the free-hand key suspends both", () => {
    expect(snapPoint(4603, 4760, ctx(one, start, { free: true })).kind).toBe("none");
    expect(snapPoint(4400, 4709, ctx(one, null, { free: true })).kind).toBe("none");
  });

  it("the tool's toggles reach the snap", () => {
    let s: RoadToolState = { ...INITIAL_ROAD_TOOL, tool: "road" };
    const tool = new RoadToolController({
      get: () => s,
      set: (patch) => {
        s = { ...s, ...patch };
      },
      world: () => ({ net: one.roads, terrain }),
      send: () => Promise.resolve({ ok: true }),
    });
    const view = { metresPerPixel: 1, free: false };
    expect(tool.snap({ x: 4400, z: 4709 }, view)?.kind).toBe("offset");
    // An avenue sits further out.
    tool.pickType("avenue");
    expect(tool.snap({ x: 4400, z: 4709 }, view)?.z).toBeCloseTo(4600 + 96 + (STREET + AVENUE) / 2, 9);
    tool.toggleGuide("offset");
    expect(tool.snap({ x: 4400, z: 4709 }, view)?.kind).toBe("none");
  });
});

describe("guide markers", () => {
  const one = build([A]);

  it("show the line caught, the offset and its gap, and a crossing", () => {
    const start = { x: 4300, z: 4800 };
    const line = snapPoint(4603, 4760, ctx(one, start));
    expect(snapMarks(line, start, 1).map((m) => [m.shape, m.look])).toEqual([["line", "line"]]);
    const offset = snapPoint(4400, 4709, ctx(one, null));
    const marks = snapMarks(offset, null, 1);
    expect(marks.map((m) => [m.shape, m.look])).toEqual([
      ["line", "offset"],
      ["line", "offset"],
    ]);
    // The second runs across the gap back to the street's centre line.
    const gap = marks[1];
    if (gap?.shape !== "line") throw new Error("no gap line");
    expect(gap.bz).toBeCloseTo(4600, 9);
    expect(formatOffset(12)).toBe("12 cells beside the road, edge to edge");
    const crossing = snapPoint(4602, 4703, ctx(one, END));
    expect(snapMarks(crossing, END, 1).map((m) => m.shape)).toEqual(["line", "line", "line", "cross", "square"]);
    const tris = buildSnapMarks(terrain, snapMarks(crossing, END, 1), 1);
    expect(tris.indices.length % 3).toBe(0);
    expect(tris.indices.length).toBeGreaterThan(0);
  });

  it("a guide line runs from its node through the point and past it", () => {
    const start = { x: 4300, z: 4800 };
    const line = snapPoint(4603, 4760, ctx(one, start));
    const [m] = snapMarks(line, start, 2);
    if (m?.shape !== "line") throw new Error("no line");
    expect([m.ax, m.az]).toEqual([4600, 4600]);
    expect(m.bz).toBeGreaterThan(4760);
  });
});

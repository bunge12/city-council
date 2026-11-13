// Snapping for the road tool (issue M1-08), on a network the sim itself
// built, read the way the client reads its mirror.
import { describe, expect, it } from "vitest";
import { ROAD_BUILD, createBareState, generateTerrain, step, submit, type BuildPoint, type SimState } from "@city-council/sim";
import { liveRoadSegment, type RoadNet } from "../src/render/road-geometry";
import { buildSnapMarks, snapMarks } from "../src/render/snap-marks-geometry";
import { DEFAULT_GUIDES, SNAP, type GuideToggles } from "../src/tools/config";
import { INITIAL_ROAD_TOOL, RoadToolController, previewRoad, type RoadToolState } from "../src/tools/road-tool";
import { SNAP_SOURCES, snapPoint, startSource, type SnapContext, type SnapSource } from "../src/tools/snap";
import { formatCells } from "../src/ui/RoadReadout";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

function build(roads: [BuildPoint, BuildPoint][]): SimState {
  const state = createBareState(SEED);
  let seq = 0;
  for (const [from, to] of roads) {
    const result = submit(state, { seq: ++seq, playerId: "test", type: "BuildRoad", payload: { from, to, type: "street" } });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    step(state);
  }
  return state;
}

// A street west to east, ending at a node at (4600, 4600).
const state = build([[{ x: 4200, z: 4600 }, { x: 4600, z: 4600 }]]);
const net: RoadNet = state.roads;
const END: BuildPoint = { x: 4600, z: 4600 };

/** The context for a road from `start`, at one metre a pixel unless told otherwise. */
type Over = Partial<Omit<SnapContext, "guides">> & { guides?: Partial<GuideToggles> };

function ctx(start: BuildPoint | null, over: Over = {}): SnapContext {
  const { guides, ...rest } = over;
  return {
    net,
    start,
    source: start ? startSource(net, start) : null,
    metresPerPixel: 1,
    guides: { ...DEFAULT_GUIDES, ...guides },
    free: false,
    gridStep: terrain.spacing,
    ...rest,
  };
}

const deg = (d: number) => (d * Math.PI) / 180;
/** A point `len` metres from `from` at `angle` degrees clockwise in plan from due south (+z). */
function at(from: BuildPoint, angle: number, len: number): BuildPoint {
  return { x: from.x + Math.sin(deg(angle)) * len, z: from.z + Math.cos(deg(angle)) * len };
}

describe("startSource", () => {
  it("finds the node or the segment a road starts from, as the sim would join it", () => {
    const node = startSource(net, { x: 4601, z: 4602 });
    expect(node?.kind).toBe("node");
    expect(node?.dirs).toHaveLength(1);
    expect(node?.dirs[0]?.dx).toBeCloseTo(-1, 9);
    const seg = startSource(net, { x: 4400, z: 4603 });
    expect(seg?.kind).toBe("segment");
    expect(seg?.dirs).toHaveLength(2);
    expect(startSource(net, { x: 4400, z: 4610 })).toBeNull();
  });
});

describe("snapPoint targets", () => {
  it("catches a node within its pixel distance, and not beyond", () => {
    const near = snapPoint(4600 + SNAP.nodePx - 1, 4600, ctx(null));
    expect(near.kind).toBe("node");
    expect([near.x, near.z]).toEqual([4600, 4600]);
    // At two metres a pixel the same distance in metres is half as many pixels.
    expect(snapPoint(4600 + SNAP.nodePx + 6, 4600, ctx(null, { metresPerPixel: 2 })).kind).toBe("node");
    expect(snapPoint(4600 + SNAP.nodePx + 6, 4600, ctx(null)).kind).not.toBe("node");
  });

  it("catches the nearest point on a segment", () => {
    const s = snapPoint(4400.3, 4600 + SNAP.segmentPx - 1, ctx(null));
    expect(s.kind).toBe("segment");
    expect(s.x).toBeCloseTo(4400.3, 9);
    expect(s.z).toBe(4600);
    expect(snapPoint(4400, 4600 + Math.max(SNAP.segmentPx, SNAP.perpendicularPx) + 2, ctx(null)).kind).toBe("none");
  });

  it("meets a segment square when the cursor is near that point", () => {
    // From open ground north of the street, toward it a little off square.
    const start = { x: 4350, z: 4500 };
    const s = snapPoint(4360, 4596, ctx(start));
    expect(s.kind).toBe("segment");
    expect(s.perpendicular).toBe(true);
    expect([s.x, s.z]).toEqual([4350, 4600]);
    // With the angle guide off, it is the nearest point instead.
    const plain = snapPoint(4360, 4596, ctx(start, { guides: { angle: false } }));
    expect(plain.kind).toBe("segment");
    expect(plain.perpendicular).toBeUndefined();
    expect(plain.x).toBeCloseTo(4360, 9);
  });

  it("snaps a road 3 degrees off square to 90 degrees and marks it square", () => {
    const cursor = at(END, 3, 100);
    const s = snapPoint(cursor.x, cursor.z, ctx(END));
    expect(s.kind).toBe("angle");
    expect(s.square).toBe(true);
    expect(s.angle).toBeCloseTo(90, 9);
    expect(s.x).toBeCloseTo(4600, 9);
    // With the angle toggle off it keeps its 3 degrees.
    const off = snapPoint(cursor.x, cursor.z, ctx(END, { guides: { angle: false } }));
    expect(off.kind).toBe("none");
    expect(off.square).toBe(false);
    // The street leaves the start westward and the road heads 3 degrees east of south.
    expect(off.angle).toBeCloseTo(93, 9);
  });

  it("gives the lighter 15 degree steps a shorter reach, and lets the strong steps win when close", () => {
    // Angles here are measured from the street's direction at the start.
    const source = startSource(net, END);
    const dir = source?.dirs[0];
    if (!dir) throw new Error("no source");
    const rot = (d: number, len: number): BuildPoint => {
      const c = Math.cos(deg(d));
      const s = Math.sin(deg(d));
      return { x: END.x + (dir.dx * c - dir.dz * s) * len, z: END.z + (dir.dx * s + dir.dz * c) * len };
    };
    // 1 degree off 60 at 200 m is 3.5 m: inside the light reach.
    const light = rot(61, 200);
    const s = snapPoint(light.x, light.z, ctx(END));
    expect(s.kind).toBe("angle");
    expect(s.angle).toBeCloseTo(60, 6);
    // 3 degrees off 60 is 10.5 m: outside the light reach and far from 45 and 90.
    const loose = rot(63, 200);
    expect(snapPoint(loose.x, loose.z, ctx(END)).kind).toBe("none");
    // 3 degrees off 90 at the same length still catches, because 90 is strong.
    const strong = rot(87, 200);
    expect(snapPoint(strong.x, strong.z, ctx(END)).angle).toBeCloseTo(90, 6);
    // Close to the start, 45 and 60 are both in reach: 45 wins.
    const both = rot(52, 20);
    expect(snapPoint(both.x, both.z, ctx(END)).angle).toBeCloseTo(45, 6);
  });

  it("never offers a direction the sim would refuse as too sharp", () => {
    const source = startSource(net, END);
    const dir = source?.dirs[0];
    if (!dir) throw new Error("no source");
    // 15 degrees off the street itself.
    const p = { x: END.x + (dir.dx * Math.cos(deg(15)) - dir.dz * Math.sin(deg(15))) * 100, z: END.z + (dir.dx * Math.sin(deg(15)) + dir.dz * Math.cos(deg(15))) * 100 };
    const s = snapPoint(p.x, p.z, ctx(END, { guides: { length: false } }));
    expect(s.kind).not.toBe("angle");
    expect(ROAD_BUILD.minAngleDegrees).toBeGreaterThan(15);
  });

  it("snaps to the 16 m terrain grid only when its toggle is on", () => {
    expect(DEFAULT_GUIDES.grid).toBe(false);
    expect(snapPoint(4321.7, 4810.2, ctx(null)).kind).toBe("none");
    const s = snapPoint(4321.7, 4810.2, ctx(null, { guides: { grid: true } }));
    expect(s.kind).toBe("grid");
    expect([s.x, s.z]).toEqual([4320, 4816]);
    expect(terrain.spacing).toBe(16);
  });

  it("snaps the length to whole 8 m cells, along the guide or the cursor", () => {
    const along = at(END, 0, 99.9);
    const s = snapPoint(along.x, along.z, ctx(END));
    expect(s.lengthSnapped).toBe(true);
    expect(Math.hypot(s.x - END.x, s.z - END.z)).toBeCloseTo(96, 9);
    // From open ground there is no angle, but the length still snaps along the cursor.
    const open = { x: 4300, z: 4800 };
    const free = snapPoint(4300 + 30, 4800 + 40, ctx(open));
    expect(free.kind).toBe("none");
    expect(Math.hypot(free.x - 4300, free.z - 4800)).toBeCloseTo(48, 9);
    expect(Math.atan2(free.z - 4800, free.x - 4300)).toBeCloseTo(Math.atan2(40, 30), 9);
    // Off, the length is the cursor's.
    const off = snapPoint(along.x, along.z, ctx(END, { guides: { length: false } }));
    expect(off.lengthSnapped).toBe(false);
    expect(Math.hypot(off.x - END.x, off.z - END.z)).toBeCloseTo(99.9, 9);
  });
});

describe("snapPoint priority", () => {
  // A second street square to the first at x = 4500, from z = 4600 to 4800.
  const two = build([
    [{ x: 4200, z: 4600 }, { x: 4600, z: 4600 }],
    [{ x: 4500, z: 4600 }, { x: 4500, z: 4800 }],
  ]);
  const c = (start: BuildPoint | null, over: Over = {}) =>
    ctx(start, { net: two.roads, source: start ? startSource(two.roads, start) : null, ...over });

  it("puts a node before a segment, a segment before an angle, and an angle before the grid", () => {
    const grid = { guides: { grid: true } };
    // Near the T node at (4500, 4600) and on both segments: the node wins.
    expect(snapPoint(4505, 4603, c(null, grid)).kind).toBe("node");
    // Near the segment body only: the segment wins over the grid.
    expect(snapPoint(4504, 4700, c(null, grid)).kind).toBe("segment");
    // From the street's end, square and near the second street: the segment wins over the angle.
    const start = END;
    expect(snapPoint(4600 - 2, 4700, c(start, grid)).kind).toBe("angle");
    expect(snapPoint(4508, 4700, c(start, grid)).kind).toBe("segment");
    // Away from roads, the angle wins over the grid, and the grid takes the rest.
    expect(snapPoint(4601, 4720, c(start, grid)).kind).toBe("angle");
    expect(snapPoint(4650, 4700, c(start, grid)).kind).toBe("grid");
  });

  it("runs any list of sources in the order given, so more can be added", () => {
    const always: SnapSource = { id: "test", find: () => ({ kind: "grid", x: 1, z: 2 }) };
    expect(snapPoint(4505, 4603, c(null), [always, ...SNAP_SOURCES]).x).toBe(1);
    expect(snapPoint(4505, 4603, c(null), [...SNAP_SOURCES, always]).kind).toBe("node");
  });
});

describe("the free-hand key", () => {
  it("suspends angle, length and grid, and segment and node snaps past the merge distance", () => {
    const cursor = at(END, 3, 100);
    const s = snapPoint(cursor.x, cursor.z, ctx(END, { free: true, guides: { grid: true } }));
    expect(s.kind).toBe("none");
    expect(s.lengthSnapped).toBe(false);
    expect([s.x, s.z]).toEqual([cursor.x, cursor.z]);
    expect(snapPoint(4600 + 8, 4600, ctx(null, { free: true })).kind).toBe("none");
    expect(snapPoint(4400, 4608, ctx(null, { free: true })).kind).toBe("none");
  });

  it("still joins a node or a segment within the sim's merge distance", () => {
    const m = ROAD_BUILD.mergeDistance;
    expect(snapPoint(4600 + m - 0.5, 4600, ctx(null, { free: true })).kind).toBe("node");
    expect(snapPoint(4400, 4600 + m - 0.5, ctx(null, { free: true })).kind).toBe("segment");
  });
});

describe("snapped roads in the sim", () => {
  it("reads 96 m as 12 cells", () => {
    const cursor = at(END, 3, 99);
    const s = snapPoint(cursor.x, cursor.z, ctx(END));
    const preview = previewRoad(net, terrain, END, s, "street");
    expect(preview.ok).toBe(true);
    expect(preview.length).toBe(96);
    expect(formatCells(preview.length)).toBe("12 cells");
    expect(formatCells(8)).toBe("1 cell");
    expect(formatCells(100)).toBe("12.5 cells");
  });

  it("makes a T-junction exactly on the segment, never a node just off it", () => {
    for (const x of [4333.33, 4417.71, 4251.06]) {
      const start = { x, z: 4720.4 };
      const s = snapPoint(x + 3, 4598.7, ctx(start, { guides: { angle: false } }));
      expect(s.kind).toBe("segment");
      const after = build([
        [{ x: 4200, z: 4600 }, { x: 4600, z: 4600 }],
        [start, { x: s.x, z: s.z }],
      ]);
      const roads = after.roads;
      let nodesOnLine = 0;
      let nodesNearLine = 0;
      for (let n = 0; n < roads.nodeFlags.length; n++) {
        if (((roads.nodeFlags[n] ?? 0) & 1) === 0) continue;
        const dz = Math.abs((roads.nodeZ[n] ?? 0) - 4600);
        if (dz === 0) nodesOnLine++;
        else if (dz < 1) nodesNearLine++;
      }
      expect(nodesNearLine).toBe(0);
      // Both ends of the first street and the T node.
      expect(nodesOnLine).toBe(3);
      let live = 0;
      for (let seg = 0; seg < roads.segFlags.length; seg++) if (liveRoadSegment(roads, seg)) live++;
      expect(live).toBe(3);
    }
  });
});

describe("snap markers", () => {
  it("shows what each snap caught", () => {
    const node = snapPoint(4602, 4600, ctx(null));
    expect(snapMarks(node, null, 1).map((m) => m.shape)).toEqual(["ring"]);
    const seg = snapPoint(4400, 4605, ctx(null));
    expect(snapMarks(seg, null, 1).map((m) => m.shape)).toEqual(["diamond"]);
    const grid = snapPoint(4321, 4811, ctx(null, { guides: { grid: true } }));
    expect(snapMarks(grid, null, 1).map((m) => m.shape)).toEqual(["cross"]);
    const cursor = at(END, 3, 100);
    const angle = snapPoint(cursor.x, cursor.z, ctx(END));
    expect(snapMarks(angle, END, 1).map((m) => m.shape)).toEqual(["line", "square"]);
    const perp = snapPoint(4360, 4596, ctx({ x: 4350, z: 4500 }));
    expect(snapMarks(perp, { x: 4350, z: 4500 }, 1).map((m) => m.shape)).toEqual(["diamond", "square"]);
    const none = snapPoint(4650, 4800, ctx(null));
    expect(snapMarks(none, null, 1)).toEqual([]);
  });

  it("builds triangles for every marker, sized in pixels", () => {
    const cursor = at(END, 3, 100);
    const angle = snapPoint(cursor.x, cursor.z, ctx(END));
    const marks = [...snapMarks(angle, END, 1), ...snapMarks(snapPoint(4602, 4600, ctx(null)), null, 1)];
    const small = buildSnapMarks(terrain, marks, 0.5);
    const big = buildSnapMarks(terrain, marks, 2);
    expect(small.indices.length).toBeGreaterThan(0);
    expect(small.indices.length % 3).toBe(0);
    for (const i of small.indices) expect(i).toBeLessThan(small.positions.length / 3);
    // The ring's outer radius scales with metres per pixel.
    const extent = (a: Float32Array) => {
      let max = 0;
      for (let i = 0; i < a.length; i += 3) max = Math.max(max, Math.abs((a[i] ?? 0) - 4600));
      return max;
    };
    const ringOnly = snapMarks(snapPoint(4602, 4600, ctx(null)), null, 1);
    expect(extent(buildSnapMarks(terrain, ringOnly, 2).positions)).toBeCloseTo(2 * extent(buildSnapMarks(terrain, ringOnly, 1).positions), 3);
    expect(big.positions.length).toBeGreaterThan(0);
  });
});

describe("the guide toggles", () => {
  it("live in the tool's state, and the snap reads them", () => {
    let s: RoadToolState = { ...INITIAL_ROAD_TOOL, tool: "road", roadStart: END };
    const tool = new RoadToolController({
      get: () => s,
      set: (patch) => {
        s = { ...s, ...patch };
      },
      world: () => ({ net, terrain }),
      send: () => Promise.resolve({ ok: true }),
    });
    expect(s.guides).toEqual({ angle: true, length: true, grid: false });
    const cursor = at(END, 3, 100);
    expect(tool.snap(cursor, { metresPerPixel: 1, free: false })?.kind).toBe("angle");
    expect(tool.snap(cursor, { metresPerPixel: 1, free: true })?.kind).toBe("none");
    tool.toggleGuide("angle");
    expect(s.guides.angle).toBe(false);
    expect(tool.snap(cursor, { metresPerPixel: 1, free: false })?.kind).toBe("none");
    tool.toggleGuide("grid");
    expect(tool.snap(cursor, { metresPerPixel: 1, free: false })?.kind).toBe("grid");
    tool.toggleGuide("length");
    expect(s.guides).toEqual({ angle: false, length: false, grid: true });
  });
});

// The grid tool (issue M1-21) against the same SimHost the worker runs, with
// an in-memory transport and a fake clock. The tool's state is a plain object
// standing in for the UI store.
import { describe, expect, it } from "vitest";
import {
  ROAD_BUILD,
  createBareState,
  generateTerrain,
  type BuildRoadGridPayload,
  type CommandResult,
} from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import { liveRoadSegment, type RoadNet } from "../src/render/road-geometry";
import {
  GridToolController,
  INITIAL_GRID_TOOL,
  gridCorners,
  gridMarks,
  gridShapes,
  previewGrid,
  reachTo,
  type GridPreview,
  type GridToolState,
} from "../src/tools/grid-tool";
import { DEFAULT_GUIDES } from "../src/tools/config";
import type { RoadToolState } from "../src/tools/road-tool";

// Places on the map of seed 2026, as the sim's grid tests use them.
const SEED = 2026;
const terrain = generateTerrain(SEED);
/** Dry land north of an inlet that widens to the south-west. */
const INLET = { x0: 3300, z0: 6400, x1: 3800, z1: 6800 };

type State = GridToolState & Pick<RoadToolState, "tool" | "roadType" | "roadNote" | "roadStart" | "roadControl" | "roadChain" | "guides">;

function setup(send?: (payload: BuildRoadGridPayload) => Promise<CommandResult>) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(createBareState(SEED), hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let state: State = { ...INITIAL_GRID_TOOL, tool: null, roadType: "street", roadNote: null, roadStart: null, roadControl: null, roadChain: 0, guides: DEFAULT_GUIDES };
  const sent: BuildRoadGridPayload[] = [];
  const tool = new GridToolController({
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    world: () => (mirror.state ? { net: mirror.state.roads, terrain } : null),
    send: (payload) => {
      sent.push(payload);
      return send ? send(payload) : mirror.sendCommandSettled("BuildRoadGrid", payload);
    },
  });
  mirror.subscribe((u) => tool.mirrorUpdated(u));
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { mirror, tool, tick, settle, sent, state: () => state };
}

type Point = { x: number; z: number };

/**
 * Draws a rectangle as a player would (issue 88): a drag along the first
 * side from `origin` to `sideEnd`, then the pointer to `reach` and a click.
 * The pointer is passed as caught by a snap, so the reach is exactly to it.
 */
function draw(tool: GridToolController, origin: Point, sideEnd: Point, reach: Point): void {
  tool.dragStart(origin);
  tool.dragMove({ x: (origin.x + sideEnd.x) / 2, z: (origin.z + sideEnd.z) / 2 });
  tool.dragMove(sideEnd);
  tool.dragEnd();
  tool.hover(caught(reach));
  tool.click();
}

/** A pointer position as a snap that caught it, so the length guide leaves it be. */
const caught = (p: Point) => ({ ...p, kind: "node" as const, lengthSnapped: false, source: null, angle: null, square: false, squareTo: null });

/** Draws the rectangle square to the map from corner `a` to corner `b`, its first side running east or west from `a`. */
function drag(tool: GridToolController, a: Point, b: Point): void {
  draw(tool, a, { x: b.x, z: a.z }, b);
}

const key = (ax: number, az: number, bx: number, bz: number): string =>
  ax < bx || (ax === bx && az < bz) ? `${ax},${az}-${bx},${bz}` : `${bx},${bz}-${ax},${az}`;

function previewLinks(p: GridPreview): string[] {
  return p.streets.flatMap((s) => s.points.slice(1).map((b, k) => key(s.points[k]?.x ?? 0, s.points[k]?.z ?? 0, b.x, b.z))).sort();
}

function builtLinks(net: RoadNet): string[] {
  const out: string[] = [];
  for (let s = 0; s < net.segA.length; s++) {
    if (!liveRoadSegment(net, s)) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    out.push(key(net.nodeX[a] ?? 0, net.nodeZ[a] ?? 0, net.nodeX[b] ?? 0, net.nodeZ[b] ?? 0));
  }
  return out.sort();
}

describe("gridCorners", () => {
  it("takes the first side as drawn and reaches square to it, to the left for a positive reach", () => {
    expect(gridCorners({ x: 4200, z: 4500 }, { x: 4400, z: 4500 }, -200)).toEqual({
      origin: { x: 4200, z: 4500 },
      along: { x: 4400, z: 4500 },
      across: { x: 4200, z: 4300 },
    });
    expect(gridCorners({ x: 4200, z: 4500 }, { x: 4400, z: 4500 }, 200).across).toEqual({ x: 4200, z: 4700 });
  });

  it("follows a side at any angle and puts the corners on the build grid", () => {
    const d = { dx: Math.cos(0.3), dz: Math.sin(0.3) };
    const end = { x: 4200 + 300 * d.dx, z: 4500 + 300 * d.dz };
    const c = gridCorners({ x: 4200, z: 4500 }, end, 200);
    for (const p of [c.along, c.across]) {
      expect(p.x * 8).toBe(Math.round(p.x * 8));
      expect(p.z * 8).toBe(Math.round(p.z * 8));
    }
    expect(Math.hypot(c.along.x - 4200, c.along.z - 4500)).toBeCloseTo(300, 0);
    expect(Math.hypot(c.across.x - 4200, c.across.z - 4500)).toBeCloseTo(200, 0);
    // Square to the side, within the build grid's rounding.
    const dot = (c.along.x - 4200) * (c.across.x - 4200) + (c.along.z - 4500) * (c.across.z - 4500);
    expect(Math.abs(dot) / (300 * 200)).toBeLessThan(1e-3);
  });

  it("measures the reach from the side's line, signed by the side the point is on", () => {
    const o = { x: 0, z: 0 };
    const e = { x: 100, z: 0 };
    expect(reachTo(o, e, { x: 50, z: 30 })).toBeCloseTo(30, 9);
    expect(reachTo(o, e, { x: 500, z: -40 })).toBeCloseTo(-40, 9);
    expect(gridCorners(o, e, reachTo(o, e, { x: 50, z: 30 })).across).toEqual({ x: 0, z: 30 });
  });
});

describe("the grid tool", () => {
  it("counts the buildings in the way once the rectangle is placed, and again only for buildings near the rectangle (issue M2-15)", async () => {
    const { client, host: hostEnd } = memoryTransportPair();
    new SimHost(createBareState(SEED), hostEnd, () => 0);
    const mirror = new SimMirror(client, "p1");
    await new Promise((r) => setTimeout(r, 0));
    let state: State = { ...INITIAL_GRID_TOOL, tool: null, roadType: "street", roadNote: null, roadStart: null, roadControl: null, roadChain: 0, guides: DEFAULT_GUIDES };
    let counts = 0;
    const tool = new GridToolController({
      get: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
      world: () =>
        mirror.state
          ? {
              net: mirror.state.roads,
              terrain,
              clears: () => {
                counts++;
                return { ids: [7], residents: 3 };
              },
            }
          : null,
      send: () => Promise.resolve({ ok: true }),
    });
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4604, z: 4500 });
    expect(tool.preview()).toBeNull();
    tool.dragEnd();
    // While the reach follows the pointer, the buildings in the way are not counted.
    tool.hover(caught({ x: 4604, z: 4712 }));
    expect(tool.preview()?.clears).toBeNull();
    expect(counts).toBe(0);
    tool.click();
    expect(tool.preview()?.clears).toEqual({ ids: [7], residents: 3 });
    expect(counts).toBe(1);

    const delta = (ids: number[]) => ({ kind: "delta" as const, steps: 1, roadNodes: [], roadSegs: [], buildingIds: ids });
    const lots: Record<number, number[]> = { 1: [9000, 9000, 9008, 9000, 9008, 9008, 9000, 9008], 2: [4300, 4600, 4308, 4600, 4308, 4608, 4300, 4608] };
    const lotOf = (id: number) => lots[id] ?? null;
    // A building far away, and a delta with none: nothing to count again.
    tool.mirrorUpdated(delta([1]), lotOf);
    tool.mirrorUpdated(delta([]), lotOf);
    tool.preview();
    expect(counts).toBe(1);
    // One inside the rectangle, and one it counted that has gone.
    tool.mirrorUpdated(delta([2]), lotOf);
    tool.preview();
    expect(counts).toBe(2);
    tool.mirrorUpdated(delta([7]), lotOf);
    tool.preview();
    expect(counts).toBe(3);
  });

  it("lays a grid square to the map on open ground, with the default block depth of twelve cells", async () => {
    const { tool, tick, settle, sent, state, mirror } = setup();
    tool.toggle();
    expect(state().tool).toBe("grid");
    drag(tool, { x: 4200, z: 4500 }, { x: 4200 + 2 * 202, z: 4500 + 2 * 106 });
    const preview = tool.preview();
    expect(preview?.ok).toBe(true);
    expect(preview?.payload.depth).toBe(96);
    expect(preview?.payload.along).toEqual({ x: 4200 + 2 * 202, z: 4500 });
    // Depth 96 m and width 192 m between road edges: 2 by 2 blocks.
    expect(preview?.streets).toHaveLength(6);
    expect(preview?.cost).toBe(Math.round((preview?.length ?? 0) * (preview?.type.buildCostPerMetre ?? 0)));

    tool.confirm();
    expect(sent).toHaveLength(1);
    expect(state().gridOrigin).toBeNull();
    expect(state().gridPending).toHaveLength(1);
    await settle();
    // Queued, not built: the preview stays until the step that builds it.
    expect(state().gridPending).toHaveLength(1);
    tick();
    await settle();
    expect(state().gridPending).toHaveLength(0);
    const net = mirror.state?.roads;
    if (!net || !preview) throw new Error("no state");
    expect(builtLinks(net)).toEqual(previewLinks(preview));
    expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoadGrid"]);
  });

  it("lines the first side up with the road it starts on, and joins that road", async () => {
    const { tool, tick, settle, mirror, state } = setup();
    const d = { dx: 0.8, dz: 0.6 };
    await mirror.sendCommand("BuildRoad", { from: { x: 4150, z: 4450 }, to: { x: 4150 + 500 * d.dx, z: 4450 + 500 * d.dz }, type: "street" });
    tick();
    await settle();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    const origin = { x: 4150 + 100 * d.dx, z: 4450 + 100 * d.dz };

    tool.toggle();
    tool.dragStart(tool.snap(origin, { metresPerPixel: 0.5, free: false }));
    // A pointer a little off the road's line: the angle guide catches it on the line.
    const off = { x: origin.x + 300 * d.dx + 3 * d.dz, z: origin.z + 300 * d.dz - 3 * d.dx };
    const end = tool.snap(off, { metresPerPixel: 0.5, free: false });
    expect(end?.kind).toBe("angle");
    tool.dragMove(end);
    tool.dragEnd();
    expect(state().gridStage).toBe("depth");
    const side = state().gridSideEnd;
    const o = state().gridOrigin;
    if (!side || !o) throw new Error("no side");
    // Along the road, within the build grid's rounding, and whole cells long.
    expect(Math.abs((side.x - o.x) * d.dz - (side.z - o.z) * d.dx)).toBeLessThan(0.2);
    expect(Math.hypot(side.x - o.x, side.z - o.z) / 8).toBeCloseTo(Math.round(Math.hypot(side.x - o.x, side.z - o.z) / 8), 1);
    // Off the road to its left, two blocks deep.
    tool.hover(caught({ x: origin.x - 220 * d.dz, z: origin.z + 220 * d.dx }));
    tool.click();

    const preview = tool.preview();
    expect(preview?.ok, preview?.reason ?? "").toBe(true);
    // The first line lies along the road, so it is left out, and each street across it joins it.
    const across = preview?.streets.filter((s) => s.axis === 1) ?? [];
    expect(preview?.streets.filter((s) => s.axis === 0)).toHaveLength(across.length === 0 ? 0 : 2);
    expect(across.length).toBeGreaterThanOrEqual(2);
    expect(preview?.junctions).toHaveLength(across.length);
    const before = builtLinks(net).length;
    tool.confirm();
    await settle();
    tick();
    expect(mirror.state?.log.map((e) => e.type)).toEqual(["BuildRoad", "BuildRoadGrid"]);
    expect(builtLinks(net).length).toBeGreaterThan(before);
  });

  it("lines the first side up with the map on open ground, and leaves it free-hand with Alt", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    const near = { x: 4500, z: 4504 };
    const snapped = tool.snap(near, { metresPerPixel: 0.5, free: false });
    expect(snapped?.kind).toBe("angle");
    expect(snapped?.z).toBe(4500);
    expect(tool.snap(near, { metresPerPixel: 0.5, free: true })?.kind).toBe("none");
    tool.dragMove(snapped);
    tool.dragEnd();
    expect(state().gridSideEnd).toEqual({ x: 4504, z: 4500 });
  });

  it("sets the reach from the pointer, on either side, in whole cells unless a snap caught it", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4600, z: 4500 });
    tool.dragEnd();
    expect(tool.preview()).toBeNull();
    tool.hover({ x: 4400, z: 4703 });
    expect(state().gridReach).toBe(200);
    tool.hover({ x: 4400, z: 4297 });
    expect(state().gridReach).toBe(-200);
    expect(tool.payload()?.across).toEqual({ x: 4200, z: 4300 });
    tool.hover(caught({ x: 4400, z: 4703 }));
    expect(state().gridReach).toBe(203);
    // Held, the free-hand key leaves the reach where the pointer is.
    tool.hover({ x: 4400, z: 4703 }, true);
    expect(state().gridReach).toBe(203);
    expect(tool.preview()?.ok).toBe(true);
  });

  it("places the rectangle on the first Enter and sends it on the second, so the buildings in the way show first", () => {
    const { tool, sent, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4600, z: 4500 });
    tool.dragEnd();
    tool.hover(caught({ x: 4400, z: 4703 }));
    tool.confirm();
    expect(state().gridStage).toBe("placed");
    expect(sent).toHaveLength(0);
    // Placed, the pointer no longer moves it.
    tool.hover(caught({ x: 4400, z: 4900 }));
    expect(state().gridReach).toBe(203);
    tool.confirm();
    expect(sent).toHaveLength(1);
  });

  it("keeps the rectangle when the click that places it moves a few pixels", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4600, z: 4500 });
    tool.dragEnd();
    tool.hover(caught({ x: 4400, z: 4703 }));
    // A press that moved past the click slop is a drag, but too short to be a side.
    tool.dragStart({ x: 4400, z: 4703 });
    tool.dragMove({ x: 4403, z: 4705 });
    tool.dragEnd();
    expect(state()).toMatchObject({ gridStage: "placed", gridOrigin: { x: 4200, z: 4500 }, gridSideEnd: { x: 4600, z: 4500 }, gridReach: 203 });
    // A real drag starts a new side.
    tool.dragStart({ x: 4300, z: 4600 });
    tool.dragMove({ x: 4300, z: 4800 });
    tool.dragEnd();
    expect(state()).toMatchObject({ gridStage: "depth", gridOrigin: { x: 4300, z: 4600 }, gridSideEnd: { x: 4300, z: 4800 } });
  });

  it("drops a first side too short to build", () => {
    const { tool, state } = setup();
    tool.toggle();
    tool.dragStart({ x: 4200, z: 4500 });
    tool.dragMove({ x: 4204, z: 4500 });
    tool.dragEnd();
    expect(state().gridStage).toBeNull();
    expect(state().gridOrigin).toBeNull();
  });

  it("shows where water cuts the streets and builds what it showed", async () => {
    const { tool, tick, settle, mirror } = setup();
    tool.toggle();
    drag(tool, { x: INLET.x0, z: INLET.z0 }, { x: INLET.x1, z: INLET.z1 });
    const preview = tool.preview();
    if (!preview) throw new Error("no preview");
    expect(preview.ok, preview.reason ?? "").toBe(true);
    expect(preview.cuts.length).toBeGreaterThan(0);
    expect(gridMarks(preview.payload, preview.cuts).filter((m) => m.shape === "cross" && m.look === "cut")).toHaveLength(preview.cuts.length);
    tool.confirm();
    await settle();
    tick();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    expect(builtLinks(net)).toEqual(previewLinks(preview));
  });

  it("shows a grid over the cap in red with the reason and sends nothing", () => {
    const { tool, sent, state } = setup();
    tool.toggle();
    tool.setBlock("depth", 2);
    tool.setBlock("width", 2);
    drag(tool, { x: 4100, z: 4400 }, { x: 4500, z: 4800 });
    const preview = tool.preview();
    expect(preview?.ok).toBe(false);
    expect(preview?.reason).toMatch(
      new RegExp(`^Too big for one grid: it has \\d+ street sections, and one grid can lay ${ROAD_BUILD.gridMaxSections}\\. Make it smaller, or lay it in parts\\.$`),
    );
    if (preview) expect(gridShapes(preview, "refused")).toHaveLength(0);
    tool.confirm();
    expect(sent).toHaveLength(0);
    expect(state().gridNote).toBe(preview?.reason);
    expect(state().gridOrigin).not.toBeNull();
  });

  it("shows the sim's reason when it refuses a grid the preview passed", async () => {
    const { tool, settle, state } = setup(() => Promise.resolve({ ok: false, reason: "Street 1 of 6 in the grid: no" }));
    tool.toggle();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    tool.confirm();
    await settle();
    expect(state().gridPending).toHaveLength(0);
    expect(state().gridNote).toBe("Street 1 of 6 in the grid: no");
  });

  it("drops the rectangle on Escape or a right-click, and leaves on Escape with none", () => {
    const { tool, state } = setup();
    tool.toggle();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    tool.cancel();
    expect(state().gridOrigin).toBeNull();
    drag(tool, { x: 4200, z: 4500 }, { x: 4600, z: 4800 });
    expect(tool.escape()).toBe(true);
    expect(state().gridOrigin).toBeNull();
    expect(state().tool).toBe("grid");
    expect(tool.escape()).toBe(true);
    expect(state().tool).toBeNull();
  });

  it("keeps block sizes in whole cells within limits", () => {
    const { tool, state } = setup();
    tool.setBlock("depth", 7.6);
    tool.setBlock("width", 0);
    tool.setBlock("width", Number.NaN);
    expect(state().gridDepthCells).toBe(8);
    expect(state().gridWidthCells).toBe(2);
  });

  it("previews a grid at the cap well inside a frame", () => {
    const { mirror } = setup();
    const net = mirror.state?.roads;
    if (!net) throw new Error("no state");
    // 13 by 14 lines 40 m apart over the flat square: 337 sections on open
    // ground, near the most one grid can lay (issue 88).
    const payload = { origin: { x: 4110, z: 4410 }, along: { x: 4110 + 12 * 40, z: 4410 }, across: { x: 4110, z: 4410 + 13 * 40 }, depth: 30, width: 30, type: "street" };
    const first = previewGrid(net, terrain, payload);
    expect(first.ok, first.reason ?? "").toBe(true);
    expect(first.streets).toHaveLength(27);
    expect(first.streets.reduce((n, s) => n + s.points.length - 1, 0)).toBe(337);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) previewGrid(net, terrain, payload);
    // Generous for a slow CI runner; on the development container it is a few milliseconds.
    expect((performance.now() - t0) / 10).toBeLessThan(16);
  });
});

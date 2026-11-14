// M2-01: the drawing tools read the zoning cell size and depth from the
// sim's `balance/zoning.json`, so changing the file moves the length snap,
// the parallel offset gaps and the grid tool's default depth with it.
//
// The client reaches the sim only through its entry file (CLAUDE.md rule 1),
// so the test changes the file's numbers where the entry hands them out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZONING_BALANCE, createBareState, generateTerrain, step, submit, type SimState, type ZoningBalance } from "@city-council/sim";

const zoning = ZONING_BALANCE;
const SEED = 2026;
const terrain = generateTerrain(SEED);

/** A street west to east along z = 4600, ending at a node at (4600, 4600), 10 m wide. */
function street(): SimState {
  const state = createBareState(SEED);
  const result = submit(state, { seq: 1, playerId: "test", type: "BuildRoad", payload: { from: { x: 4200, z: 4600 }, to: { x: 4600, z: 4600 }, type: "street" } });
  if (!result.ok) throw new Error(result.reason);
  step(state);
  return state;
}
const SIM = "@city-council/sim";

/** The tool settings and the grid tool's first state, loaded fresh as if `zoning.json` said `override`. */
async function toolsWith(override: Partial<ZoningBalance>) {
  vi.resetModules();
  vi.doMock(SIM, async (importOriginal) => {
    const sim = await importOriginal<typeof import("@city-council/sim")>();
    return { ...sim, ZONING_BALANCE: { ...sim.ZONING_BALANCE, ...override } };
  });
  const config = await import("../src/tools/config");
  const grid = await import("../src/tools/grid-tool");
  const snap = await import("../src/tools/snap");
  return { ...config, INITIAL_GRID_TOOL: grid.INITIAL_GRID_TOOL, snapPoint: snap.snapPoint, startSource: snap.startSource };
}

afterEach(() => {
  vi.doUnmock(SIM);
  vi.resetModules();
});

describe("tool settings from zoning.json", () => {
  it("take the cell size and depth as the file has them", async () => {
    const tools = await toolsWith({});
    expect(tools.SNAP.cellSize).toBe(zoning.cellSize);
    expect(tools.SNAP.zoneDepthCells).toBe(zoning.zoneDepthCells);
    expect(tools.PARALLEL_GAP_CELLS).toEqual([2 * zoning.zoneDepthCells, zoning.zoneDepthCells]);
    expect(tools.GRID_TOOL.defaultDepthCells).toBe(2 * zoning.zoneDepthCells);
  });

  it("follow a change to the depth: the parallel offset gaps and the grid tool's default depth", async () => {
    const tools = await toolsWith({ zoneDepthCells: 4 });
    expect(tools.SNAP.zoneDepthCells).toBe(4);
    expect(tools.PARALLEL_GAP_CELLS).toEqual([8, 4]);
    expect(tools.GRID_TOOL.defaultDepthCells).toBe(8);
    expect(tools.INITIAL_GRID_TOOL.gridDepthCells).toBe(8);
    expect(tools.GUIDES.find((g) => g.id === "offset")?.title).toMatch(/8 or 4 cells/);
  });

  it("follow a change to the cell size: the length snap", async () => {
    const tools = await toolsWith({ cellSize: 10 });
    expect(tools.SNAP.cellSize).toBe(10);
    expect(tools.GUIDES.find((g) => g.id === "length")?.title).toMatch(/10 m cells/);
  });

  // Issue M2-08: the snap itself, not only the numbers, follows the file.
  it("move the parallel offset snap and the length snap when the file changes", async () => {
    const state = street();
    const tools = await toolsWith({ zoneDepthCells: 4, cellSize: 10 });
    const ctx = (start: { x: number; z: number } | null, offset: boolean) => ({
      net: state.roads,
      start,
      source: start ? tools.startSource(state.roads, start) : null,
      metresPerPixel: 1,
      guides: { ...tools.DEFAULT_GUIDES, lines: false, offset, cells: false },
      free: false,
      gridStep: terrain.spacing,
      roadWidth: 10,
    });
    // One strip of 4 cells of 10 m between the road edges: 40 m, plus half of each road.
    const one = 4 * 10 + 5 + 5;
    const s = tools.snapPoint(4400, 4600 + one + 3, ctx(null, true));
    expect(s.kind).toBe("offset");
    expect(s.z).toBeCloseTo(4600 + one, 6);
    // Two strips: 80 m between the edges.
    expect(tools.snapPoint(4400, 4600 + 2 * 40 + 10 - 4, ctx(null, true)).z).toBeCloseTo(4690, 6);
    // Straight on from the road's end, the length rounds to whole 10 m cells.
    const l = tools.snapPoint(4600 + 63, 4600, ctx({ x: 4600, z: 4600 }, false));
    expect(l.lengthSnapped).toBe(true);
    expect(l.x).toBeCloseTo(4660, 6);
  });
});

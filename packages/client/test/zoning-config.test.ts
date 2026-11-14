// M2-01: the drawing tools read the zoning cell size and depth from the
// sim's `balance/zoning.json`, so changing the file moves the length snap,
// the parallel offset gaps and the grid tool's default depth with it.
//
// The client reaches the sim only through its entry file (CLAUDE.md rule 1),
// so the test changes the file's numbers where the entry hands them out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZONING_BALANCE, type ZoningBalance } from "@city-council/sim";

const zoning = ZONING_BALANCE;
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
  return { ...config, INITIAL_GRID_TOOL: grid.INITIAL_GRID_TOOL };
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
});

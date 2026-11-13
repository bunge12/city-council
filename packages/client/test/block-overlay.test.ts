// The debug panel's block overlay (issue M1-18) against the same SimHost the
// worker runs, with an in-memory transport and a fake clock. The overlay's
// state is a plain object standing in for the UI store.
import { describe, expect, it } from "vitest";
import { NONE, buildBlockIndex, createState, generateTerrain, listBlocks, step, submit, type RoadNetwork, type SimState } from "@city-council/sim";
import { PUMP_INTERVAL_MS, SimHost } from "../src/protocol/host";
import { SimMirror } from "../src/protocol/mirror";
import { memoryTransportPair } from "../src/protocol/transport";
import type { RoadNet } from "../src/render/road-geometry";
import { buildPreviewGeometry } from "../src/render/road-preview-geometry";
import {
  BlockOverlayController,
  INITIAL_BLOCK_OVERLAY,
  blockLabelPoint,
  blockShapes,
  blocksReadout,
  formatArea,
  type BlockOverlayState,
} from "../src/tools/block-overlay";

// Seed 2026 has a dry, nearly flat square from (4100, 4400) to (4700, 5000).
const SEED = 2026;
const terrain = generateTerrain(SEED);

/** Streets round the square from (4200, 4500) to (4400, 4700). */
const LOOP: [[number, number], [number, number]][] = [
  [
    [4200, 4500],
    [4400, 4500],
  ],
  [
    [4400, 4500],
    [4400, 4700],
  ],
  [
    [4400, 4700],
    [4200, 4700],
  ],
  [
    [4200, 4700],
    [4200, 4500],
  ],
];

function city(): SimState {
  const state = createState(SEED);
  let seq = 0;
  for (const [from, to] of LOOP) {
    const payload = { from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, type: "street" };
    const result = submit(state, { seq: ++seq, playerId: "fixture", type: "BuildRoad", payload });
    if (!result.ok) throw new Error(`fixture road refused: ${result.reason}`);
    step(state);
  }
  return state;
}

function setup(state: SimState) {
  const { client, host: hostEnd } = memoryTransportPair();
  let now = 0;
  const host = new SimHost(state, hostEnd, () => now);
  const mirror = new SimMirror(client, "p1");
  let ui: BlockOverlayState = { ...INITIAL_BLOCK_OVERLAY };
  const overlay = new BlockOverlayController({
    get: () => ui,
    set: (patch) => {
      ui = { ...ui, ...patch };
    },
    net: () => mirror.state?.roads ?? null,
  });
  mirror.subscribe(() => overlay.refresh());
  const tick = () => {
    for (let t = 0; t < 100; t += PUMP_INTERVAL_MS) {
      now += PUMP_INTERVAL_MS;
      host.pump();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const net = (): RoadNet => {
    const roads = mirror.state?.roads;
    if (!roads) throw new Error("no snapshot");
    return roads;
  };
  return { mirror, overlay, tick, settle, net, ui: () => ui };
}

/** The live segment whose middle is at (x, z). */
function segmentAt(net: RoadNet, x: number, z: number): number {
  for (let s = 0; s < net.segFlags.length; s++) {
    if (((net.segFlags[s] ?? 0) & 1) === 0) continue;
    const a = net.segA[s] ?? 0;
    const b = net.segB[s] ?? 0;
    if (((net.nodeX[a] ?? 0) + (net.nodeX[b] ?? 0)) / 2 === x && ((net.nodeZ[a] ?? 0) + (net.nodeZ[b] ?? 0)) / 2 === z) return s;
  }
  return NONE;
}

describe("block overlay", () => {
  it("outlines the loop's block with its area, and loses it when a side is bulldozed", async () => {
    const t = setup(city());
    t.tick();
    await t.settle();
    expect(t.mirror.state).not.toBeNull();
    expect(blocksReadout(t.ui())).toBe("off");
    expect(t.ui().blocks).toBeNull();

    t.overlay.toggle();
    expect(t.ui().showBlocks).toBe(true);
    const blocks = t.ui().blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.area).toBe(40_000);
    expect(blocksReadout(t.ui())).toBe("1 block");
    // The same blocks the sim finds from scratch.
    expect(blocks).toEqual(listBlocks(buildBlockIndex(t.net() as unknown as RoadNetwork)));

    const shapes = blockShapes(t.net(), blocks);
    expect(shapes).toHaveLength(4);
    expect(shapes.every((s) => s.look === "block")).toBe(true);
    expect(buildPreviewGeometry(terrain, shapes).indices.length).toBeGreaterThan(0);
    const label = blockLabelPoint(t.net(), blocks[0] ?? { id: 0, segments: [], forward: [], area: 0 });
    expect(label.x).toBeCloseTo(4300, 6);
    expect(label.z).toBeCloseTo(4600, 6);

    // Bulldoze the south side: the mirror's blocks follow the delta.
    const sent = t.mirror.sendCommand("BulldozeRoad", { segments: [segmentAt(t.net(), 4300, 4700)] });
    t.tick();
    expect((await sent).ok).toBe(true);
    await t.settle();
    expect(t.ui().blocks).toEqual([]);
    expect(blocksReadout(t.ui())).toBe("no blocks");

    t.overlay.toggle();
    expect(t.ui().showBlocks).toBe(false);
    expect(t.ui().blocks).toBeNull();
  });

  it("draws a segment two blocks share once", async () => {
    const state = city();
    const result = submit(state, { seq: 99, playerId: "fixture", type: "BuildRoad", payload: { from: { x: 4300, z: 4500 }, to: { x: 4300, z: 4700 }, type: "street" } });
    expect(result.ok).toBe(true);
    step(state);
    const t = setup(state);
    t.tick();
    await t.settle();
    t.overlay.toggle();
    const blocks = t.ui().blocks ?? [];
    expect(blocks.map((b) => b.area)).toEqual([20_000, 20_000]);
    // Two blocks of four sides each, sharing one, with the outer sides split where the new street meets them.
    expect(blockShapes(t.net(), blocks)).toHaveLength(7);
  });

  it("formats areas and counts", () => {
    expect(formatArea(40_000)).toBe("40,000 m²");
    expect(formatArea(812.6)).toBe("813 m²");
    expect(blocksReadout({ showBlocks: true, blocks: null })).toBe("waiting for roads");
    expect(blocksReadout({ showBlocks: true, blocks: [] })).toBe("no blocks");
  });
});

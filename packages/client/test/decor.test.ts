// Decoration placement: the same trees in the same places on every load,
// none in the water, and the woods where the forest mask says.
import { beforeAll, describe, expect, it } from "vitest";
import { generateTerrain, heightAt, type Terrain } from "@city-council/sim";
import { InstancedMesh, Scene, Vector3, type Object3D } from "three/webgpu";
import { DECOR } from "../src/render/config";
import { DECOR_STRIDE, cellHash, placeDecor, type DecorInstances } from "../src/render/decor";
import { createDecorLayer } from "../src/render/decor-meshes";
import { MASK_GRASS, MASK_SIDE, MASK_TREES, masked } from "../src/render/road-geometry";
import { chunkCentre, chunksPerSide } from "../src/render/terrain-chunks";

let terrain: Terrain;
beforeAll(() => {
  terrain = generateTerrain(1);
});

function* instances(placed: DecorInstances) {
  for (let k = 0; k < placed.count; k++) {
    const o = k * DECOR_STRIDE;
    yield { x: placed.data[o] ?? 0, y: placed.data[o + 1] ?? 0, z: placed.data[o + 2] ?? 0, height: placed.data[o + 3] ?? 0 };
  }
}

/** Every chunk's decoration on the map. */
function wholeMap(t: Terrain) {
  const per = chunksPerSide(t);
  const out = [];
  for (let cj = 0; cj < per; cj++) for (let ci = 0; ci < per; ci++) out.push(placeDecor(t, ci, cj));
  return out;
}

describe("decoration placement", () => {
  it("hashes cells to fixed values", () => {
    // Pinned, so a change to the hash that moves every tree is a visible decision.
    expect([cellHash(1, 0, 0, 0), cellHash(1, 10, -3, 7), cellHash(42, 123, 456, 0x9e37)]).toMatchSnapshot();
  });

  it("places the same decoration every time", () => {
    const a = placeDecor(terrain, 5, 7);
    const b = placeDecor(generateTerrain(1), 5, 7);
    expect(a.broadleaf.data).toEqual(b.broadleaf.data);
    expect(a.conifer.data).toEqual(b.conifer.data);
    expect(a.grass.data).toEqual(b.grass.data);
  });

  it("places different decoration for a different seed", () => {
    const other = generateTerrain(2);
    const a = wholeMap(terrain).reduce((n, d) => n + d.broadleaf.count + d.conifer.count, 0);
    const b = wholeMap(other).reduce((n, d) => n + d.broadleaf.count + d.conifer.count, 0);
    expect(a).not.toBe(b);
  }, 30_000);

  it("keeps trees and grass on dry land, at ground height, within their size range", () => {
    let problems = 0;
    for (const d of wholeMap(terrain)) {
      for (const tree of [...instances(d.broadleaf), ...instances(d.conifer)]) {
        const ground = heightAt(terrain, tree.x, tree.z);
        if (ground - terrain.waterLevel < DECOR.trees.minAbove) problems++;
        if (Math.abs(tree.y - ground) > 1) problems++;
        if (tree.height < DECOR.trees.minHeight || tree.height > DECOR.trees.maxHeight) problems++;
      }
      for (const tuft of instances(d.grass)) {
        if (heightAt(terrain, tuft.x, tuft.z) - terrain.waterLevel < DECOR.grass.minAbove) problems++;
      }
    }
    expect(problems).toBe(0);
  }, 30_000);

  it("puts most trees in the forest", () => {
    let inForest = 0;
    let total = 0;
    for (const d of wholeMap(terrain)) {
      for (const tree of [...instances(d.broadleaf), ...instances(d.conifer)]) {
        const i = Math.floor(tree.x / terrain.spacing + 0.5);
        const j = Math.floor(tree.z / terrain.spacing + 0.5);
        if (terrain.forest[j * terrain.samples + i] === 1) inForest++;
        total++;
      }
    }
    expect(total).toBeGreaterThan(10_000);
    expect(inForest / total).toBeGreaterThan(0.8);
    console.log(`seed 1: ${total} trees, ${((100 * inForest) / total).toFixed(0)}% in forest`);
  }, 30_000);
});

// Issue 141: a chunk whose mask changes, as when a building comes onto a lot,
// keeps drawing its old trees until the new ones are built, so it never
// shows bare for a frame.
describe("the decoration layer", () => {
  /** The tree instances drawn under `root`: visible meshes in visible groups. */
  function treesDrawn(root: Object3D): number {
    let n = 0;
    root.traverseVisible((o) => {
      if (o instanceof InstancedMesh && (o.name === "broadleaf" || o.name === "conifer")) n += o.count;
    });
    return n;
  }

  /** The forest chunk nearest the middle of the map, and an eye over it. */
  function forestChunk(): { chunk: number; eye: Vector3 } {
    const per = chunksPerSide(terrain);
    let best = { chunk: -1, d: Infinity };
    for (let cj = 0; cj < per; cj++) {
      for (let ci = 0; ci < per; ci++) {
        const p = placeDecor(terrain, ci, cj);
        if (p.broadleaf.count + p.conifer.count < 200) continue;
        const d = Math.hypot(ci - per / 2, cj - per / 2);
        if (d < best.d) best = { chunk: cj * per + ci, d };
      }
    }
    const ci = best.chunk % per;
    const cj = Math.floor(best.chunk / per);
    const c = chunkCentre(ci, cj);
    return { chunk: best.chunk, eye: new Vector3(c.x, heightAt(terrain, c.x, c.z) + 200, c.z) };
  }

  it("draws a chunk's old trees until the new mask's are built, then only the new", () => {
    const { chunk, eye } = forestChunk();
    expect(chunk).toBeGreaterThanOrEqual(0);
    // The chunk's mask, which the test changes: at first nothing masked.
    let mask: Uint8Array | null = null;
    const scene = new Scene();
    const layer = createDecorLayer(terrain, scene, (c) => (c === chunk ? mask : null));
    // Every chunk in range built, a few a frame. A fixed count of frames, as in
    // the next test: how many chunks a frame builds depends on how fast the
    // machine is (BUILD_MS_PER_FRAME), and stopping at the first frame that
    // adds no trees stopped early on a busy runner, when that frame built only
    // a chunk with none, before the forest chunk was built (issue #230).
    for (let f = 0; f < 500; f++) layer.update(eye);
    const before = treesDrawn(scene);
    expect(before).toBeGreaterThan(0);

    // Half the chunk is taken, as by a new lot: no trees there.
    mask = new Uint8Array(MASK_SIDE * MASK_SIDE);
    mask.fill(MASK_TREES | MASK_GRASS, 0, (MASK_SIDE * MASK_SIDE) / 2);
    expect(layer.refresh([chunk])).toEqual([chunk]);
    // Until the next update the old trees stay: the frame drawn now is not bare.
    expect(treesDrawn(scene)).toBe(before);

    // One update builds the chunk again and swaps it in whole.
    layer.update(eye);
    const placed = placeDecor(terrain, chunk % chunksPerSide(terrain), Math.floor(chunk / chunksPerSide(terrain)));
    let gone = 0;
    for (const kind of [placed.broadleaf, placed.conifer]) {
      for (let k = 0; k < kind.count; k++) {
        const o = k * DECOR_STRIDE;
        if (masked(mask, chunk, kind.data[o] ?? 0, kind.data[o + 2] ?? 0, MASK_TREES)) gone++;
      }
    }
    expect(gone).toBeGreaterThan(0);
    expect(treesDrawn(scene)).toBe(before - gone);
    expect(layer.counts().trees).toBe(before - gone);
    layer.dispose();
  });

  it("drops a chunk out of range at once, and builds it when it comes back", () => {
    const { chunk, eye } = forestChunk();
    let mask: Uint8Array | null = null;
    const scene = new Scene();
    const layer = createDecorLayer(terrain, scene, (c) => (c === chunk ? mask : null));
    for (let f = 0; f < 500; f++) layer.update(eye);
    const near = treesDrawn(scene);
    // The camera leaves: the chunk's trees are hidden, then its mask changes.
    const far = new Vector3(-50_000, 1000, -50_000);
    layer.update(far);
    mask = new Uint8Array(MASK_SIDE * MASK_SIDE).fill(MASK_TREES);
    expect(layer.refresh([chunk])).toEqual([chunk]);
    // Back in range: built with the new mask, every tree of the chunk gone.
    for (let f = 0; f < 500; f++) layer.update(eye);
    expect(treesDrawn(scene)).toBeLessThan(near);
    layer.dispose();
  });

  it("builds every chunk in range in one update with no budget, and says how many are left to build (issue #223)", () => {
    const { chunk, eye } = forestChunk();
    const budgeted = createDecorLayer(terrain, new Scene());
    const flushed = createDecorLayer(terrain, new Scene());
    expect(flushed.pending()).toBe(0);
    flushed.update(eye, Infinity);
    expect(flushed.pending()).toBe(0);
    // The budget takes frames to get there, at least one chunk each; zero milliseconds builds exactly one.
    budgeted.update(eye, 0);
    const left = budgeted.pending();
    expect(left).toBeGreaterThan(0);
    budgeted.update(eye, 0);
    expect(budgeted.pending()).toBe(left - 1);
    for (let f = 0; f < 500 && budgeted.pending() > 0; f++) budgeted.update(eye, 0);
    expect(budgeted.pending()).toBe(0);
    expect(budgeted.counts()).toEqual(flushed.counts());
    // A chunk marked to build again is pending until the next update builds it.
    flushed.refresh([chunk]);
    expect(flushed.pending()).toBe(0);
    const mask = new Uint8Array(MASK_SIDE * MASK_SIDE).fill(MASK_TREES);
    const relaid = createDecorLayer(terrain, new Scene(), (c) => (c === chunk ? mask : null));
    relaid.update(eye, Infinity);
    mask.fill(0);
    expect(relaid.refresh([chunk])).toEqual([chunk]);
    expect(relaid.pending()).toBe(1);
    relaid.update(eye, Infinity);
    expect(relaid.pending()).toBe(0);
    for (const l of [budgeted, flushed, relaid]) l.dispose();
  });
});

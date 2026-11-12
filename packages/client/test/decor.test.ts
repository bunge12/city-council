// Decoration placement: the same trees in the same places on every load,
// none in the water, and the woods where the forest mask says.
import { beforeAll, describe, expect, it } from "vitest";
import { generateTerrain, heightAt, type Terrain } from "@city-council/sim";
import { DECOR } from "../src/render/config";
import { DECOR_STRIDE, cellHash, placeDecor, type DecorInstances } from "../src/render/decor";
import { chunksPerSide } from "../src/render/terrain-chunks";

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

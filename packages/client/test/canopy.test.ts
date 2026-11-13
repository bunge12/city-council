// Issue 47: the canopy stand-in for trees too far away to draw. The terrain
// material reads the forest mask from a texture; this checks the texture
// matches the mask texel for texel, and that the stand-in hands over to the
// trees where they stop being drawn.
import { describe, expect, it } from "vitest";
import { generateTerrain } from "@city-council/sim";
import { DECOR } from "../src/render/config";
import { forestTexture } from "../src/render/terrain-material";

const terrain = generateTerrain(2026);

describe("the canopy stand-in", () => {
  it("has one texel per height sample, full where the mask is forest and empty elsewhere", () => {
    const t = forestTexture(terrain);
    expect(t.image.width).toBe(terrain.samples);
    expect(t.image.height).toBe(terrain.samples);
    const data = t.image.data as Uint8Array;
    let forest = 0;
    for (let k = 0; k < terrain.forest.length; k++) {
      expect(data[k]).toBe((terrain.forest[k] ?? 0) === 1 ? 255 : 0);
      if (terrain.forest[k] === 1) forest++;
    }
    // The fixture seed has forest, so the check covers both values.
    expect(forest).toBeGreaterThan(0);
    expect(forest).toBeLessThan(terrain.forest.length);
    t.dispose();
  });

  it("is full where trees stop being drawn, and starts fading in before that", () => {
    expect(DECOR.canopy.fadeTo).toBe(DECOR.trees.drawDistance);
    expect(DECOR.canopy.fadeFrom).toBeLessThan(DECOR.canopy.fadeTo);
  });
});

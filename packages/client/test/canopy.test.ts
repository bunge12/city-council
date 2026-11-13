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
  it("has one texel per height sample: full inside a forest, empty well clear of one, and in between at its edge", () => {
    const t = forestTexture(terrain);
    const n = terrain.samples;
    expect(t.image.width).toBe(n);
    expect(t.image.height).toBe(n);
    const data = t.image.data as Uint8Array;
    const forestWithin = (i: number, j: number, r: number) => {
      let count = 0;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) count += terrain.forest[Math.min(Math.max(j + dj, 0), n - 1) * n + Math.min(Math.max(i + di, 0), n - 1)] ?? 0;
      }
      return count;
    };
    const seen = { full: 0, empty: 0, edge: 0 };
    for (let j = 0; j < n; j += 3) {
      for (let i = 0; i < n; i += 3) {
        const v = data[j * n + i] ?? 0;
        const near = forestWithin(i, j, 2);
        if (near === 25) {
          expect(v).toBe(255);
          seen.full++;
        } else if (near === 0) {
          expect(v).toBe(0);
          seen.empty++;
        } else {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThan(255);
          seen.edge++;
        }
      }
    }
    // The fixture seed has all three, so the check covers each case.
    expect(Math.min(seen.full, seen.empty, seen.edge)).toBeGreaterThan(0);
    t.dispose();
  });

  it("is full where trees stop being drawn, and starts fading in before that", () => {
    expect(DECOR.canopy.fadeTo).toBe(DECOR.trees.drawDistance);
    expect(DECOR.canopy.fadeFrom).toBeLessThan(DECOR.canopy.fadeTo);
  });
});

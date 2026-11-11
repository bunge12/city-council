import { describe, expect, it } from "vitest";
import {
  TERRAIN_BALANCE,
  fnv1a64,
  generateTerrain,
  hashTerrain,
  heightAt,
  isWaterAt,
  mapSize,
  slopeAt,
  type Terrain,
} from "../src/index";
import fixture from "./fixtures/terrain-hashes.json";

const cache = new Map<number, Terrain>();
function terrain(seed: number): Terrain {
  let t = cache.get(seed);
  if (!t) {
    t = generateTerrain(seed);
    cache.set(seed, t);
  }
  return t;
}

function heightsHash(t: Terrain): string {
  return fnv1a64(new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength));
}

function share(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v;
  return n / mask.length;
}

describe("generateTerrain", () => {
  it("builds a 12 km map of 750 x 750 samples 16 m apart", () => {
    const t = terrain(1);
    expect(t.samples).toBe(750);
    expect(t.spacing).toBe(16);
    expect(mapSize(t)).toBe(12000);
    expect(t.heights).toBeInstanceOf(Float32Array);
    expect(t.heights.length).toBe(750 * 750);
    for (const mask of [t.fertile, t.forest, t.ore]) {
      expect(mask).toBeInstanceOf(Uint8Array);
      expect(mask.length).toBe(750 * 750);
    }
  });

  // If one of these fails, every saved city would load onto a different map.
  // Change the fixture only on purpose and say why in the pull request.
  for (const { seed, heights, terrain: all } of fixture.seeds) {
    it(`matches the committed hashes for seed ${seed}`, () => {
      const t = terrain(seed);
      expect(heightsHash(t)).toBe(heights);
      expect(hashTerrain(t)).toBe(all);
    });

    it(`seed ${seed} has at least the buildable share in the balance file`, () => {
      const t = terrain(seed);
      expect(t.buildableShare).toBeGreaterThanOrEqual(TERRAIN_BALANCE.buildable.minShare);
    });

    it(`seed ${seed} has water, hills and every resource`, () => {
      const t = terrain(seed);
      let water = 0;
      let peak = 0;
      for (const h of t.heights) {
        if (h <= t.waterLevel) water++;
        peak = h > peak ? h : peak;
      }
      const waterShare = water / t.heights.length;
      expect(waterShare).toBeGreaterThan(TERRAIN_BALANCE.waterShare - 0.01);
      expect(waterShare).toBeLessThan(TERRAIN_BALANCE.waterShare + 0.01);
      expect(peak - t.waterLevel).toBeGreaterThan(150);
      expect(share(t.fertile)).toBeGreaterThan(0.05);
      expect(share(t.forest)).toBeGreaterThan(0.05);
      expect(share(t.ore)).toBeGreaterThan(0.002);
    });
  }

  it("gives the same map twice and different maps for different seeds", () => {
    expect(hashTerrain(generateTerrain(1))).toBe(hashTerrain(terrain(1)));
    expect(hashTerrain(terrain(1))).not.toBe(hashTerrain(terrain(42)));
  });

  it("flattens the relief until the buildable share is reached", () => {
    // A balance that demands more flat land than the first pass gives.
    const strict: typeof TERRAIN_BALANCE = JSON.parse(JSON.stringify(TERRAIN_BALANCE));
    strict.buildable.minShare = 0.6;
    const first = terrain(7);
    expect(first.attempts).toBe(1);
    expect(first.buildableShare).toBeLessThan(0.6);
    const t = generateTerrain(7, strict);
    expect(t.attempts).toBeGreaterThan(1);
    expect(t.buildableShare).toBeGreaterThanOrEqual(0.6);
  });

  it("rejects seeds that are not 32-bit unsigned integers", () => {
    expect(() => generateTerrain(-1)).toThrow(RangeError);
    expect(() => generateTerrain(1.5)).toThrow(RangeError);
    expect(() => generateTerrain(2 ** 32)).toThrow(RangeError);
  });
});

describe("heightAt and slopeAt", () => {
  // A 3 x 3 map, 10 m apart, that rises 1 m per sample in x and 2 m in z.
  const plane: Terrain = {
    seed: 0,
    samples: 3,
    spacing: 10,
    heights: new Float32Array([0, 1, 2, 2, 3, 4, 4, 5, 6]),
    waterLevel: 0.5,
    fertile: new Uint8Array(9),
    forest: new Uint8Array(9),
    ore: new Uint8Array(9),
    buildableShare: 0,
    attempts: 1,
  };

  it("returns sample heights on samples", () => {
    expect(heightAt(plane, 0, 0)).toBe(0);
    expect(heightAt(plane, 10, 0)).toBe(1);
    expect(heightAt(plane, 0, 10)).toBe(2);
    expect(heightAt(plane, 20, 20)).toBe(6);
  });

  it("interpolates bilinearly between samples", () => {
    expect(heightAt(plane, 5, 0)).toBe(0.5);
    expect(heightAt(plane, 15, 15)).toBe(4.5);
    expect(heightAt(plane, 2.5, 7.5)).toBe(1.75);
  });

  it("clamps points off the map to the edge", () => {
    expect(heightAt(plane, -50, -50)).toBe(0);
    expect(heightAt(plane, 500, 500)).toBe(6);
    expect(heightAt(plane, 500, 0)).toBe(2);
  });

  it("reports slope as rise over run", () => {
    const expected = Math.sqrt(0.1 * 0.1 + 0.2 * 0.2);
    expect(slopeAt(plane, 3, 4)).toBeCloseTo(expected, 12);
    expect(slopeAt(plane, 20, 20)).toBeCloseTo(expected, 12);
  });

  it("finds water at or below the water level", () => {
    expect(isWaterAt(plane, 0, 0)).toBe(true);
    expect(isWaterAt(plane, 10, 0)).toBe(false);
  });

  it("matches the samples on a generated map", () => {
    const t = terrain(42);
    const i = 300;
    const j = 411;
    expect(heightAt(t, i * 16, j * 16)).toBe(t.heights[j * 750 + i]);
    const mid = heightAt(t, i * 16 + 8, j * 16);
    const a = t.heights[j * 750 + i] ?? 0;
    const b = t.heights[j * 750 + i + 1] ?? 0;
    expect(mid).toBeCloseTo((a + b) / 2, 4);
  });
});

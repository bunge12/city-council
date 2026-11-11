import { describe, expect, it } from "vitest";
import { createState, nextFloat, nextInt, nextU32, seedRng } from "../src/index";

function take(rng: Uint32Array, n: number): number[] {
  return Array.from({ length: n }, () => nextU32(rng));
}

describe("xoshiro128**", () => {
  it("matches the reference output for state 1, 2, 3, 4", () => {
    // From the reference C implementation by Blackman and Vigna.
    expect(take(new Uint32Array([1, 2, 3, 4]), 6)).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492,
    ]);
  });

  it("produces the committed sequence for seed 12345", () => {
    // If this fails, the generator or its seeding changed and every saved
    // city and replay log would diverge. Change it only on purpose, with a
    // snapshot version bump.
    expect(take(seedRng(12345), 8)).toEqual([
      518667457, 440444462, 4232892992, 3757857622, 3939018813, 1334683535, 3795058715,
      2092637810,
    ]);
  });

  it("stores its state in SimState and advances it in place", () => {
    const state = createState(12345);
    const first = nextU32(state.rng);
    expect(first).toBe(518667457);
    expect(nextU32(state.rng)).toBe(440444462);
  });

  it("gives floats in [0, 1) and ints in [0, n)", () => {
    const rng = seedRng(7);
    for (let i = 0; i < 1000; i++) {
      const f = nextFloat(rng);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = nextInt(rng, 6);
      expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
    }
  });

  it("gives different sequences for different seeds", () => {
    expect(take(seedRng(1), 4)).not.toEqual(take(seedRng(2), 4));
  });
});

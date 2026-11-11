import { describe, expect, it } from "vitest";
import { TICK_MS, simInfo } from "../src/index";

describe("simInfo", () => {
  it("reports the fixed 100 ms tick", () => {
    expect(TICK_MS).toBe(100);
    expect(simInfo()).toEqual({ name: "city-council sim", tickMs: 100 });
  });
});

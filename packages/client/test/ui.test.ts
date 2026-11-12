// The UI shell's pure parts: formatting, the tick rate readout, shortcuts
// and seeds. Components themselves are checked in the Playwright walkthrough.
import { describe, expect, it } from "vitest";
import { gameDate } from "@city-council/sim";
import { formatGameDate, formatMoneyShort, formatSpeed } from "../src/ui/format";
import { TickRateMeter } from "../src/ui/rate";
import { parseSeed, randomSeed } from "../src/ui/seed";
import { TOOL_ROAD_TYPES } from "../src/tools/road-tool";
import { SHORTCUTS, shortcutFor, toggledSpeed, type KeyPress } from "../src/ui/shortcuts";
import { setViewReadout, useViewReadout } from "../src/ui/store";

describe("formatMoneyShort", () => {
  it.each([
    [0, "$0"],
    [7, "$7"],
    [999, "$999"],
    [1_000, "$1K"],
    [1_250, "$1.3K"],
    [12_400, "$12K"],
    [480_000_000, "$480M"],
    [3_200_000_000, "$3.2B"],
    [3_000_000_000, "$3B"],
    [2_800_000, "$2.8M"],
    [4_200_000, "$4.2M"],
    [9_960_000, "$10M"],
    [99_600_000, "$100M"],
    [999_600, "$1M"],
    [999_600_000, "$1B"],
    [6_000_000_000_000, "$6T"],
    [-12_000, "-$12K"],
    [-3_200_000_000, "-$3.2B"],
    [-0.4, "$0"],
  ])("writes %d as %s", (dollars, text) => {
    expect(formatMoneyShort(dollars)).toBe(text);
  });

  it("is exact for whole dollars up to 2^53, as money is stored", () => {
    expect(formatMoneyShort(2 ** 53)).toBe("$9007T");
  });

  it("refuses amounts that are not numbers", () => {
    expect(() => formatMoneyShort(Number.NaN)).toThrow(RangeError);
    expect(() => formatMoneyShort(Infinity)).toThrow(RangeError);
  });
});

describe("game date and speed text", () => {
  it("shows the date the tick falls on", () => {
    expect(formatGameDate(gameDate(0))).toBe("1 Jan, Year 1");
    expect(formatGameDate(gameDate(33 * 100))).toBe("3 Feb, Year 1");
    expect(formatGameDate(gameDate(365 * 100 + 364 * 100))).toBe("31 Dec, Year 2");
  });

  it("shows pause as a word and the rest as multiples", () => {
    expect([0, 1, 2, 4].map(formatSpeed)).toEqual(["paused", "1x", "2x", "4x"]);
  });
});

describe("TickRateMeter", () => {
  it("measures ticks per second over the window", () => {
    const meter = new TickRateMeter(1000);
    expect(meter.rate()).toBeNull();
    // Deltas arrive every 25 ms at 4x: one tick each.
    for (let t = 0; t <= 2000; t += 25) meter.add(t, t / 25);
    expect(meter.rate()).toBeCloseTo(40, 5);
  });

  it("forgets samples older than the window", () => {
    const meter = new TickRateMeter(1000);
    for (let t = 0; t <= 1000; t += 100) meter.add(t, t / 100); // 10/s
    for (let t = 1100; t <= 3000; t += 100) meter.add(t, 10); // paused
    expect(meter.rate()).toBe(0);
  });

  it("starts over when the tick goes back, as after a load", () => {
    const meter = new TickRateMeter(1000);
    for (let t = 0; t <= 1000; t += 100) meter.add(t, 500 + t / 100);
    meter.add(1100, 3);
    expect(meter.rate()).toBeNull();
  });
});

const press = (code: string, more: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  targetTag: "BODY",
  targetEditable: false,
  ...more,
});

describe("shortcuts", () => {
  it("maps the speed keys to SetSpeed speeds and Space to pause", () => {
    expect(shortcutFor(press("Digit1"))).toEqual({ kind: "speed", speed: 1 });
    expect(shortcutFor(press("Digit2"))).toEqual({ kind: "speed", speed: 2 });
    expect(shortcutFor(press("Digit3"))).toEqual({ kind: "speed", speed: 4 });
    expect(shortcutFor(press("Numpad3"))).toEqual({ kind: "speed", speed: 4 });
    expect(shortcutFor(press("Space"))).toEqual({ kind: "togglePause" });
    expect(shortcutFor(press("Backquote"))).toEqual({ kind: "toggleDebug" });
    expect(shortcutFor(press("KeyL"))).toEqual({ kind: "toggleLog" });
  });

  it("maps B to the road tool, Z X C to the road types and Escape to cancel", () => {
    expect(shortcutFor(press("KeyB"))).toEqual({ kind: "roadTool" });
    expect(shortcutFor(press("KeyZ"))).toEqual({ kind: "roadType", type: "street" });
    expect(shortcutFor(press("KeyX"))).toEqual({ kind: "roadType", type: "avenue" });
    expect(shortcutFor(press("KeyC"))).toEqual({ kind: "roadType", type: "oneWay" });
    expect(shortcutFor(press("Escape"))).toEqual({ kind: "escape" });
    expect(shortcutFor(press("Escape", { targetTag: "INPUT" }))).toBeNull();
    // Every type the tool offers has a key.
    const types = SHORTCUTS.flatMap((s) => (s.action.kind === "roadType" ? [s.action.type] : []));
    expect(types).toEqual([...TOOL_ROAD_TYPES]);
  });

  it("leaves typing, modified keys, repeats and the camera keys alone", () => {
    expect(shortcutFor(press("Digit1", { targetTag: "INPUT" }))).toBeNull();
    expect(shortcutFor(press("Digit1", { targetEditable: true }))).toBeNull();
    expect(shortcutFor(press("Digit1", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(press("Digit1", { repeat: true }))).toBeNull();
    expect(shortcutFor(press("Space", { targetTag: "BUTTON" }))).toBeNull();
    expect(shortcutFor(press("Digit1", { targetTag: "BUTTON" }))).toEqual({ kind: "speed", speed: 1 });
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "Equal", "Minus"]) {
      expect(shortcutFor(press(code))).toBeNull();
    }
  });

  it("gives every key one action", () => {
    const codes = SHORTCUTS.flatMap((s) => s.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("pauses when running and resumes at the last running speed", () => {
    expect(toggledSpeed(2, 2)).toBe(0);
    expect(toggledSpeed(0, 4)).toBe(4);
    expect(toggledSpeed(0, 0)).toBe(1);
  });
});

describe("seeds", () => {
  it("accepts whole numbers from 0 to 2^32 - 1", () => {
    expect(parseSeed("0")).toBe(0);
    expect(parseSeed(" 4294967295 ")).toBe(4294967295);
    for (const bad of ["", "-1", "1.5", "4294967296", "12abc", "1e3"]) expect(parseSeed(bad)).toBeNull();
  });

  it("makes random seeds in range", () => {
    for (let i = 0; i < 20; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true);
    }
  });
});

describe("view readout store", () => {
  it("only updates when a readout changed", () => {
    let updates = 0;
    const unsubscribe = useViewReadout.subscribe(() => updates++);
    setViewReadout({ cursor: "1, 2, 3 m" });
    setViewReadout({ cursor: "1, 2, 3 m" });
    setViewReadout({ cursor: "1, 2, 3 m", zoomBand: "city" });
    unsubscribe();
    expect(updates).toBe(2);
    expect(useViewReadout.getState()).toMatchObject({ cursor: "1, 2, 3 m", zoomBand: "city" });
  });
});

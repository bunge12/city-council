import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, PRESETS, PRESET_BENCHMARK, SHADOWS, VISUAL_FEATURES, featureOn } from "../src/render/config";
import { shadowFocus, snapToTexels } from "../src/render/lighting";
import {
  PRESET_STORAGE_KEY,
  choosePreset,
  lightingFor,
  loadPreset,
  presetForBenchmark,
  presetFromAddress,
  savePreset,
  type StoredPreset,
} from "../src/render/presets";
import { graphicsReadout } from "../src/ui/DebugPanel";

/** A Storage stand-in over a Map. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("the feature list", () => {
  it("names a real preset for every feature", () => {
    for (const [feature, preset] of Object.entries(VISUAL_FEATURES)) expect(PRESETS, feature).toContain(preset);
  });

  it("turns a feature on at its preset and every later one", () => {
    expect(featureOn("sunShadows", "low")).toBe(false);
    expect(featureOn("sunShadows", "balanced")).toBe(true);
    expect(featureOn("sunShadows", "high")).toBe(true);
    expect(featureOn("longShadows", "balanced")).toBe(false);
    expect(featureOn("longShadows", "high")).toBe(true);
    expect(featureOn("trees", "low")).toBe(true);
  });

  it("puts nothing that costs a shader in Low", () => {
    expect(featureOn("sunShadows", "low")).toBe(false);
    expect(featureOn("softAmbient", "low")).toBe(false);
  });
});

describe("lighting per preset", () => {
  it("gives Low flat light and no shadows", () => {
    expect(lightingFor("low")).toEqual({ preset: "low", softAmbient: false, shadows: null });
  });

  it("gives Balanced soft ambient and shadows near the camera", () => {
    expect(lightingFor("balanced")).toEqual({ preset: "balanced", softAmbient: true, shadows: { ...SHADOWS.near } });
  });

  it("gives High a longer shadow range and a larger map than Balanced", () => {
    const balanced = lightingFor("balanced").shadows;
    const high = lightingFor("high").shadows;
    expect(high && balanced && high.range > balanced.range).toBe(true);
    expect(high && balanced && high.mapSize > balanced.mapSize).toBe(true);
  });
});

describe("which preset the page uses", () => {
  const kept: StoredPreset = { preset: "high", source: "benchmark", benchmarkMs: 3.1, benchmarkBackend: "WebGPU" };

  it("reads ?preset= and ignores names that are not presets", () => {
    expect(presetFromAddress("?preset=low")).toBe("low");
    expect(presetFromAddress("?webgl&preset=balanced")).toBe("balanced");
    expect(presetFromAddress("?preset=high")).toBe("high");
    expect(presetFromAddress("?preset=ultra")).toBeNull();
    expect(presetFromAddress("")).toBeNull();
  });

  it("lets the address win and skip the benchmark", () => {
    expect(choosePreset("?preset=low", kept)).toMatchObject({ preset: "low", source: "address", runBenchmark: false });
    expect(choosePreset("?preset=low", null)).toMatchObject({ preset: "low", source: "address", runBenchmark: false });
  });

  it("uses the kept preset on a second visit, without the benchmark", () => {
    expect(choosePreset("", kept)).toMatchObject({ preset: "high", source: "benchmark", runBenchmark: false });
    expect(choosePreset("", { ...kept, source: "player", preset: "low" })).toMatchObject({ preset: "low", source: "player", runBenchmark: false });
  });

  it("runs the benchmark on a first visit, starting from the default", () => {
    expect(choosePreset("", null)).toMatchObject({ preset: DEFAULT_PRESET, runBenchmark: true });
  });
});

describe("the benchmark's rule", () => {
  it("picks by milliseconds per draw", () => {
    expect(presetForBenchmark(PRESET_BENCHMARK.lowAbove + 0.1)).toBe("low");
    expect(presetForBenchmark(PRESET_BENCHMARK.lowAbove)).toBe("balanced");
    expect(presetForBenchmark(PRESET_BENCHMARK.highBelow)).toBe("balanced");
    expect(presetForBenchmark(PRESET_BENCHMARK.highBelow - 0.1)).toBe("high");
  });

  it("picks Low when the benchmark could not measure", () => {
    expect(presetForBenchmark(Infinity)).toBe("low");
    expect(presetForBenchmark(NaN)).toBe("low");
  });

  it("has thresholds in order", () => {
    expect(PRESET_BENCHMARK.highBelow).toBeLessThan(PRESET_BENCHMARK.lowAbove);
  });
});

describe("keeping the preset in the browser", () => {
  it("round-trips through storage under one key", () => {
    const storage = memoryStorage();
    const value: StoredPreset = { preset: "balanced", source: "player", benchmarkMs: 5.5, benchmarkBackend: "WebGL 2" };
    expect(savePreset(storage, value)).toBe(true);
    expect([...storage.data.keys()]).toEqual([PRESET_STORAGE_KEY]);
    expect(loadPreset(storage)).toEqual(value);
  });

  it("reads missing, broken or unknown values as nothing kept", () => {
    const storage = memoryStorage();
    expect(loadPreset(storage)).toBeNull();
    storage.setItem(PRESET_STORAGE_KEY, "{not json");
    expect(loadPreset(storage)).toBeNull();
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ preset: "ultra", source: "player" }));
    expect(loadPreset(storage)).toBeNull();
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ preset: "low", source: "someone" }));
    expect(loadPreset(storage)).toBeNull();
    expect(loadPreset(null)).toBeNull();
  });

  it("survives a browser that refuses storage", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadPreset(refusing)).toBeNull();
    expect(savePreset(refusing, { preset: "low", source: "player", benchmarkMs: null, benchmarkBackend: null })).toBe(false);
  });
});

describe("the debug panel's readout", () => {
  const base = { wanted: "balanced", shown: "balanced", source: "benchmark", benchmark: { state: "done", ms: 6.25, backend: "WebGPU", thisVisit: true } } as const;

  it("says what the benchmark measured and when it ran", () => {
    expect(graphicsReadout(base)).toBe("Balanced (picked by the benchmark on this visit: 6.3 ms per draw on WebGPU)");
    expect(graphicsReadout({ ...base, benchmark: { ...base.benchmark, thisVisit: false } })).toBe(
      "Balanced (picked by the benchmark on an earlier visit: 6.3 ms per draw on WebGPU)",
    );
  });

  it("says when the address forced the preset", () => {
    expect(graphicsReadout({ ...base, wanted: "low", shown: "low", source: "address", benchmark: { state: "none", ms: null, backend: null, thisVisit: false } })).toBe(
      "Low (forced by ?preset= in the address, benchmark skipped)",
    );
  });

  it("says while a switch waits for its shaders", () => {
    expect(graphicsReadout({ ...base, wanted: "high", shown: "low", source: "player" })).toMatch(/^Low, switching to High \(chosen in settings/);
  });
});

describe("where the shadows centre", () => {
  const flat = () => 10;

  it("is the ground point the camera looks at", () => {
    const [x, y, z] = shadowFocus([0, 110, 0], [0, -Math.SQRT1_2, -Math.SQRT1_2], flat, 1000);
    expect(x).toBeCloseTo(0);
    expect(y).toBe(10);
    expect(z).toBeCloseTo(-100);
  });

  it("stays within the range of the camera when it looks at the horizon", () => {
    const [x, , z] = shadowFocus([0, 110, 0], [0.6, -0.01, 0.8], flat, 300);
    expect(Math.hypot(x, z)).toBeCloseTo(300);
  });

  it("follows hills along the view ray", () => {
    // A slope rising 0.5 m per metre from x = 0: the ray from 100 m up at 45 degrees meets it at x = 66.7.
    const slope = (x: number) => Math.max(0, x * 0.5);
    const [x, y] = shadowFocus([0, 100, 0], [Math.SQRT1_2, -Math.SQRT1_2, 0], slope, 1000);
    expect(x).toBeGreaterThan(60);
    expect(x).toBeLessThan(80);
    expect(y).toBeCloseTo(slope(x));
  });

  it("snaps to the shadow map's texel grid, moving less than a texel", () => {
    const sun = [0.55, 0.55, 0.3] as const;
    const texel = 0.3125;
    const p = [1234.5, 40, 987.25] as const;
    const a = snapToTexels(p, sun, texel);
    expect(Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2])).toBeLessThan(texel);
    // A point on the grid stays put.
    const again = snapToTexels(a, sun, texel);
    expect(Math.hypot(again[0] - a[0], again[1] - a[1], again[2] - a[2])).toBeLessThan(1e-6);
  });
});

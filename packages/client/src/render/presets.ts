// The graphics preset: which one the page asks for, which one this browser
// keeps, and what each one draws. Presentation only. The preset is kept in
// this browser's local storage, never in sim state or a city file, so two
// players on different presets see the same city.

import { DEFAULT_PRESET, PRESETS, PRESET_BENCHMARK, SHADOWS, featureOn, type Preset } from "./config";

export type { Preset } from "./config";

/** Where the preset in use came from. */
export type PresetSource =
  /** `?preset=` in the address. Not kept, and the benchmark does not run. */
  | "address"
  /** The first-run benchmark picked it, on this visit or an earlier one. */
  | "benchmark"
  /** The player chose it in the settings. */
  | "player";

/** What this browser keeps about the preset. */
export interface StoredPreset {
  preset: Preset;
  source: "benchmark" | "player";
  /** The benchmark's mean milliseconds per draw, when it ran in this browser. */
  benchmarkMs: number | null;
  /** The renderer the benchmark ran on. */
  benchmarkBackend: string | null;
}

/** The local storage key the preset is kept under. */
export const PRESET_STORAGE_KEY = "city-council:graphics";

export function isPreset(value: unknown): value is Preset {
  return typeof value === "string" && (PRESETS as readonly string[]).includes(value);
}

/** The preset `?preset=` asks for, or null when the address names none or names one that does not exist. */
export function presetFromAddress(search: string): Preset | null {
  const value = new URLSearchParams(search).get("preset");
  return isPreset(value) ? value : null;
}

/** Reads the kept preset. Anything missing or malformed reads as nothing kept, so the benchmark runs again. */
export function loadPreset(storage: Pick<Storage, "getItem"> | null): StoredPreset | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(PRESET_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPreset>;
    if (!isPreset(parsed.preset)) return null;
    if (parsed.source !== "benchmark" && parsed.source !== "player") return null;
    return {
      preset: parsed.preset,
      source: parsed.source,
      benchmarkMs: typeof parsed.benchmarkMs === "number" ? parsed.benchmarkMs : null,
      benchmarkBackend: typeof parsed.benchmarkBackend === "string" ? parsed.benchmarkBackend : null,
    };
  } catch {
    return null;
  }
}

/** Keeps the preset. Returns false when the browser would not store it; the game still runs, and asks again next visit. */
export function savePreset(storage: Pick<Storage, "setItem"> | null, value: StoredPreset): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** What the page starts with: the preset to use, where it came from, and whether to run the benchmark. */
export interface PresetChoice {
  preset: Preset;
  source: PresetSource;
  runBenchmark: boolean;
  stored: StoredPreset | null;
}

/** Decides the preset at load: the address wins, then what this browser kept, then the benchmark. */
export function choosePreset(search: string, stored: StoredPreset | null): PresetChoice {
  const forced = presetFromAddress(search);
  if (forced) return { preset: forced, source: "address", runBenchmark: false, stored };
  if (stored) return { preset: stored.preset, source: stored.source, runBenchmark: false, stored };
  return { preset: DEFAULT_PRESET, source: "benchmark", runBenchmark: true, stored: null };
}

/** The benchmark's rule: the preset for a mean of `msPerDraw` milliseconds per draw of the start view at Balanced. */
export function presetForBenchmark(msPerDraw: number, rule: { lowAbove: number; highBelow: number } = PRESET_BENCHMARK): Preset {
  if (!Number.isFinite(msPerDraw) || msPerDraw > rule.lowAbove) return "low";
  if (msPerDraw < rule.highBelow) return "high";
  return "balanced";
}

/** How a preset lights the scene. */
export interface LightingSettings {
  preset: Preset;
  /** Sky and ground fill; false is one flat ambient colour. */
  softAmbient: boolean;
  /** The sun's shadow map, or null for no shadows. */
  shadows: { range: number; mapSize: number } | null;
}

export function lightingFor(preset: Preset): LightingSettings {
  const shadows = featureOn("longShadows", preset) ? SHADOWS.far : featureOn("sunShadows", preset) ? SHADOWS.near : null;
  return { preset, softAmbient: featureOn("softAmbient", preset), shadows: shadows && { ...shadows } };
}

/** The preset's name for people. */
export function presetLabel(preset: Preset): string {
  return preset === "low" ? "Low" : preset === "balanced" ? "Balanced" : "High";
}

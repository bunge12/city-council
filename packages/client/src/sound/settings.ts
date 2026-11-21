// The sound settings, kept in this browser's local storage like the
// graphics preset (render/presets.ts). Never in sim state or a city file.

import { DEFAULT_SOUND } from "./config";

export interface SoundSettings {
  /** Interface cue volume, 0 to 1. */
  interface: number;
  /** Ambience volume, 0 to 1. No layer plays yet; issue M3-19 adds the first. */
  ambience: number;
  muted: boolean;
}

/** The local storage key the settings are kept under. */
export const SOUND_STORAGE_KEY = "city-council:sound";

function volume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Reads the kept settings. A missing or unreadable field reads as its default. */
export function loadSound(storage: Pick<Storage, "getItem"> | null): SoundSettings {
  let raw: string | null;
  try {
    raw = storage?.getItem(SOUND_STORAGE_KEY) ?? null;
  } catch {
    return { ...DEFAULT_SOUND };
  }
  if (raw === null) return { ...DEFAULT_SOUND };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SOUND };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_SOUND };
  const value = parsed as Partial<Record<keyof SoundSettings, unknown>>;
  return {
    interface: volume(value.interface, DEFAULT_SOUND.interface),
    ambience: volume(value.ambience, DEFAULT_SOUND.ambience),
    muted: typeof value.muted === "boolean" ? value.muted : DEFAULT_SOUND.muted,
  };
}

/** Keeps the settings. Returns false when the browser would not store them; sound still follows them this visit. */
export function saveSound(storage: Pick<Storage, "setItem"> | null, value: SoundSettings): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SOUND_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

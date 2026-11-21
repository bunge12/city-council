// Sound settings for the client (issue M3-02). Presentation numbers, not game
// balance: sound never touches the sim (PRD, "Sound").

/** The most cues that sound at once. A cue asked for while this many are still sounding is dropped. */
export const MAX_VOICES = 6;

/** How many of the latest cue requests the test hook keeps. */
export const CUE_HISTORY = 200;

/** What a browser with nothing kept starts with. Volumes run from 0 to 1. */
export const DEFAULT_SOUND = { interface: 0.5, ambience: 0.5, muted: false } as const;

/** The whole mix sits this far under full scale, so cues stay quiet at full volume. */
export const MASTER_GAIN = 0.35;

/** One oscillator in a cue: a wave that glides from one pitch to another under a short envelope. */
export interface ToneRecipe {
  wave: OscillatorType;
  /** Hz at the start and the end of the tone. */
  from: number;
  to: number;
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds the tone lasts, attack and release included. */
  length: number;
  /** Peak level, 0 to 1, before the interface volume. */
  peak: number;
}

/** A burst of white noise through a low-pass filter, for the bulldozer's rumble. */
export interface NoiseRecipe {
  at: number;
  length: number;
  peak: number;
  /** Low-pass cut-off in Hz. */
  cutoff: number;
}

export interface CueRecipe {
  tones: readonly ToneRecipe[];
  noise?: NoiseRecipe;
}

/** Seconds an envelope takes to reach its peak. Short enough to feel instant, long enough not to click. */
export const ATTACK = 0.006;

/**
 * The interface cues, each synthesised from these. All are under a quarter
 * of a second. A road and a zone rise, an undo falls back, a refusal is a
 * low double buzz that never sounds like the others.
 */
export const CUES = {
  road: {
    tones: [
      { wave: "sine", from: 523, to: 523, at: 0, length: 0.08, peak: 0.5 },
      { wave: "sine", from: 784, to: 784, at: 0.06, length: 0.1, peak: 0.45 },
    ],
  },
  zone: {
    tones: [{ wave: "triangle", from: 600, to: 900, at: 0, length: 0.12, peak: 0.45 }],
  },
  bulldoze: {
    tones: [{ wave: "sine", from: 140, to: 60, at: 0, length: 0.22, peak: 0.7 }],
    noise: { at: 0, length: 0.2, peak: 0.35, cutoff: 900 },
  },
  undo: {
    tones: [
      { wave: "sine", from: 698, to: 698, at: 0, length: 0.07, peak: 0.4 },
      { wave: "sine", from: 466, to: 466, at: 0.06, length: 0.1, peak: 0.4 },
    ],
  },
  reject: {
    tones: [
      { wave: "triangle", from: 196, to: 185, at: 0, length: 0.08, peak: 0.6 },
      { wave: "triangle", from: 196, to: 185, at: 0.11, length: 0.08, peak: 0.6 },
    ],
  },
} as const satisfies Record<string, CueRecipe>;

export type Cue = keyof typeof CUES;

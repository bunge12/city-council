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
 * The interface cues, each synthesised from these. All but the milestone
 * are under a quarter of a second. A road and a zone rise, an undo falls
 * back, a refusal is a low double buzz that never sounds like the others.
 * Money spent is two bright clinks, a little late so it follows the cue of
 * the command that spent it (M4-14). A milestone is a rising major chord,
 * the one cue that is a reward, under half a second.
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
  money: {
    tones: [
      { wave: "triangle", from: 1568, to: 1568, at: 0.1, length: 0.05, peak: 0.3 },
      { wave: "triangle", from: 2093, to: 2093, at: 0.15, length: 0.08, peak: 0.25 },
    ],
  },
  milestone: {
    tones: [
      { wave: "sine", from: 523, to: 523, at: 0, length: 0.14, peak: 0.4 },
      { wave: "sine", from: 659, to: 659, at: 0.1, length: 0.14, peak: 0.4 },
      { wave: "sine", from: 784, to: 784, at: 0.2, length: 0.14, peak: 0.4 },
      { wave: "sine", from: 1047, to: 1047, at: 0.3, length: 0.18, peak: 0.45 },
    ],
  },
} as const satisfies Record<string, CueRecipe>;

export type Cue = keyof typeof CUES;

/**
 * The ambient layers (issue M3-19). What is heard follows the camera's
 * height and what is on screen (PRD, "Sound"). Both are quiet enough to
 * leave on for an hour.
 *
 * Wind is a few seconds of noise, looped, through a low-pass filter, its
 * level drifting with two slow sine waves that never line up. Its layer
 * sits at `street` in the street band and climbs with the camera's height
 * through the district band to `city`.
 */
export const WIND = {
  /** The layer's level in the street band and in the city band, 0 to 1. */
  street: 0.15,
  city: 1,
  /** The source's level under the layer's, before the ambience volume. */
  gain: 0.5,
  /** Seconds of noise looped. Long enough that the loop is not heard. */
  loopSeconds: 4,
  /** Low-pass cut-off in Hz. */
  cutoff: 420,
  /** The slow drifts in level: each a sine of `hz` that moves the level by up to `depth` of it. */
  drifts: [
    { hz: 0.071, depth: 0.3 },
    { hz: 0.029, depth: 0.25 },
  ],
} as const;

/**
 * Construction: short knocks and clanks at uneven times while buildings go
 * up in view, in the street band only, each placed left or right by where
 * one of the buildings sits on screen. However many go up, no more than
 * `voices` sound at once, from the cap the cues share.
 */
export const CONSTRUCTION_SOUND = {
  /** The layer's level in the street band, 0 to 1. Zero in the others. */
  level: 0.6,
  /** Seconds between sounds with one building going up: anywhere from `gapMin` to `gapMax`. */
  gapMin: 0.4,
  gapMax: 1.8,
  /** More buildings make the gaps shorter, by the square root of their count, up to this many times. */
  busiest: 2.5,
  /** The most construction sounds playing at once. */
  voices: 2,
  /** How far left or right a building at the edge of the screen is placed: 1 is all the way. */
  panSpread: 0.8,
  /** Each sound is one of these, at random. A hammer is two blows, a little uneven. */
  sounds: [
    {
      tones: [
        { wave: "triangle", from: 1150, to: 900, at: 0, length: 0.05, peak: 0.3 },
        { wave: "triangle", from: 1120, to: 880, at: 0.23, length: 0.05, peak: 0.25 },
      ],
      noise: { at: 0, length: 0.035, peak: 0.2, cutoff: 3200 },
    },
    {
      tones: [
        { wave: "sine", from: 1870, to: 1850, at: 0, length: 0.14, peak: 0.12 },
        { wave: "sine", from: 2730, to: 2700, at: 0, length: 0.09, peak: 0.07 },
      ],
    },
    {
      tones: [{ wave: "sine", from: 130, to: 70, at: 0, length: 0.14, peak: 0.4 }],
      noise: { at: 0, length: 0.09, peak: 0.2, cutoff: 600 },
    },
  ],
} as const satisfies { sounds: readonly CueRecipe[] } & Record<string, unknown>;

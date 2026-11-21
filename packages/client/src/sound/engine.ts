// The audio engine (issue M3-02), on Web Audio. Every sound is synthesised
// here from the recipes in config.ts: there are no audio files.
//
// Browsers block audio until the player first clicks or presses a key, so the
// engine makes no audio context until `unlock` is called from one, and
// schedules nothing before then.
//
// The graph is master <- interface bus <- cues, and master <- ambience bus <-
// layers. Mute zeroes the master, so it silences both. A layer is the seam
// issue M3-19 builds on: the view sets its level, and its sources connect to
// its input. No layer makes a sound yet.
//
// A context can also be held paused: a touch the browser does not count as a
// gesture, or a tab it put to sleep. Its clock stops, so nothing is
// scheduled on it; the cue is recorded as `suspended` and the engine asks it
// to resume.
//
// Every cue asked for is recorded with what became of it, for the test hook.

import { ATTACK, CUES, CUE_HISTORY, MASTER_GAIN, MAX_VOICES, type Cue, type CueRecipe } from "./config";
import type { SoundSettings } from "./settings";

/** The parts of an AudioContext the engine uses, so a test can hand it a fake. */
export type SoundContext = Pick<
  AudioContext,
  "currentTime" | "state" | "destination" | "sampleRate" | "resume" | "createGain" | "createOscillator" | "createBufferSource" | "createBuffer" | "createBiquadFilter"
>;

/**
 * What became of a cue the engine was asked to play: `played`, or why not.
 * `locked` before the first click or key, `suspended` while the browser
 * holds the audio context paused, `unavailable` when the browser
 * gave no audio context, `muted`, `silent` with the interface volume at
 * zero, and `capped` with every voice in use.
 */
export type CueOutcome = "played" | "locked" | "suspended" | "unavailable" | "muted" | "silent" | "capped";

export interface CueRecord {
  cue: Cue;
  outcome: CueOutcome;
}

/** An ambient layer: a level the view sets, under the ambience volume. */
export interface AmbientLayer {
  readonly name: string;
  /** The level the view last set, 0 to 1. */
  readonly level: number;
  setLevel(level: number): void;
  /** Where the layer's sources connect, or null until the engine has started. */
  input(): AudioNode | null;
}

export interface SoundEngineOptions {
  /** Makes the audio context. Called once, from the first click or key. */
  createContext: () => SoundContext;
  settings: SoundSettings;
  maxVoices?: number;
}

const QUIET = 0.0001;
/** Seconds ahead of now a cue is scheduled, so its first sample is not late. */
const LEAD = 0.005;

interface Started {
  ctx: SoundContext;
  master: GainNode;
  interfaceBus: GainNode;
  ambienceBus: GainNode;
  noise: AudioBuffer;
}

class Layer implements AmbientLayer {
  level = 0;
  gain: GainNode | null = null;
  ctx: SoundContext | null = null;
  constructor(readonly name: string) {}
  setLevel(level: number): void {
    this.level = Math.min(1, Math.max(0, level));
    if (this.gain && this.ctx) this.gain.gain.setValueAtTime(this.level, this.ctx.currentTime);
  }
  input(): AudioNode | null {
    return this.gain;
  }
}

export class SoundEngine {
  private readonly createContext: () => SoundContext;
  private readonly maxVoices: number;
  private settings: SoundSettings;
  private started: Started | null = null;
  private failed = false;
  /** When each sounding cue ends, in the context's seconds. */
  private voiceEnds: number[] = [];
  private readonly records: CueRecord[] = [];
  private readonly layers = new Map<string, Layer>();

  constructor(options: SoundEngineOptions) {
    this.createContext = options.createContext;
    this.settings = { ...options.settings };
    this.maxVoices = options.maxVoices ?? MAX_VOICES;
  }

  /** Whether audio is running: started by a click or key, and not held paused by the browser. */
  get unlocked(): boolean {
    return this.started?.ctx.state === "running";
  }

  /** Cues sounding now. */
  get voices(): number {
    this.pruneVoices();
    return this.voiceEnds.length;
  }

  /** Starts audio. Call it from a click or key handler; later calls only resume a suspended context. */
  unlock(): void {
    if (this.failed) return;
    if (this.started) {
      void this.started.ctx.resume().catch(() => undefined);
      return;
    }
    let ctx: SoundContext;
    try {
      ctx = this.createContext();
    } catch {
      this.failed = true;
      return;
    }
    const master = ctx.createGain();
    const interfaceBus = ctx.createGain();
    const ambienceBus = ctx.createGain();
    interfaceBus.connect(master);
    ambienceBus.connect(master);
    master.connect(ctx.destination);
    this.started = { ctx, master, interfaceBus, ambienceBus, noise: noiseBuffer(ctx) };
    for (const layer of this.layers.values()) this.wireLayer(layer);
    this.applyGains();
    void ctx.resume().catch(() => undefined);
  }

  setSettings(settings: SoundSettings): void {
    this.settings = { ...settings };
    this.applyGains();
  }

  /** Plays a cue now, if it can, and records what became of it. */
  play(cue: Cue): CueOutcome {
    const outcome = this.schedule(cue);
    this.records.push({ cue, outcome });
    if (this.records.length > CUE_HISTORY) this.records.splice(0, this.records.length - CUE_HISTORY);
    return outcome;
  }

  /** The cues asked for, oldest first, with what became of each. */
  requests(): CueRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  clearRequests(): void {
    this.records.length = 0;
  }

  /** The ambient layer named `name`, made on first use. Its level starts at zero. */
  layer(name: string): AmbientLayer {
    let layer = this.layers.get(name);
    if (!layer) {
      layer = new Layer(name);
      this.layers.set(name, layer);
      this.wireLayer(layer);
    }
    return layer;
  }

  private wireLayer(layer: Layer): void {
    if (!this.started || layer.gain) return;
    const gain = this.started.ctx.createGain();
    gain.gain.value = layer.level;
    gain.connect(this.started.ambienceBus);
    layer.gain = gain;
    layer.ctx = this.started.ctx;
  }

  private applyGains(): void {
    const s = this.started;
    if (!s) return;
    const now = s.ctx.currentTime;
    s.master.gain.setValueAtTime(this.settings.muted ? 0 : MASTER_GAIN, now);
    s.interfaceBus.gain.setValueAtTime(this.settings.interface, now);
    s.ambienceBus.gain.setValueAtTime(this.settings.ambience, now);
  }

  private pruneVoices(): void {
    const now = this.started?.ctx.currentTime ?? 0;
    this.voiceEnds = this.voiceEnds.filter((end) => end > now);
  }

  private schedule(cue: Cue): CueOutcome {
    if (this.failed) return "unavailable";
    const s = this.started;
    if (!s) return "locked";
    if (s.ctx.state !== "running") {
      // A stopped clock would hold every voice forever, so nothing is scheduled on it.
      void s.ctx.resume().catch(() => undefined);
      return "suspended";
    }
    if (this.settings.muted) return "muted";
    if (this.settings.interface <= 0) return "silent";
    this.pruneVoices();
    if (this.voiceEnds.length >= this.maxVoices) return "capped";
    const start = s.ctx.currentTime + LEAD;
    this.voiceEnds.push(start + synthesise(s, CUES[cue], start));
    return "played";
  }
}

/** Schedules one cue on the interface bus at `start`. Returns how long it sounds, in seconds. */
function synthesise(s: Started, recipe: CueRecipe, start: number): number {
  const { ctx } = s;
  let length = 0;
  for (const tone of recipe.tones) {
    const t = start + tone.at;
    const osc = ctx.createOscillator();
    osc.type = tone.wave;
    osc.frequency.setValueAtTime(tone.from, t);
    if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to, t + tone.length);
    const env = envelope(ctx, t, tone.length, tone.peak);
    osc.connect(env);
    env.connect(s.interfaceBus);
    osc.start(t);
    osc.stop(t + tone.length + 0.02);
    length = Math.max(length, tone.at + tone.length);
  }
  if (recipe.noise) {
    const n = recipe.noise;
    const t = start + n.at;
    const source = ctx.createBufferSource();
    source.buffer = s.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(n.cutoff, t);
    const env = envelope(ctx, t, n.length, n.peak);
    source.connect(filter);
    filter.connect(env);
    env.connect(s.interfaceBus);
    source.start(t);
    source.stop(t + n.length + 0.02);
    length = Math.max(length, n.at + n.length);
  }
  return length;
}

/** A gain that rises to `peak` in ATTACK seconds and dies away by `length`. */
function envelope(ctx: SoundContext, t: number, length: number, peak: number): GainNode {
  const env = ctx.createGain();
  env.gain.setValueAtTime(QUIET, t);
  env.gain.linearRampToValueAtTime(peak, t + ATTACK);
  env.gain.exponentialRampToValueAtTime(QUIET, t + length);
  return env;
}

/** A quarter of a second of white noise, made once, for every rumble. */
function noiseBuffer(ctx: SoundContext): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate / 4));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

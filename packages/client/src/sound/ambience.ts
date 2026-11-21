// The ambient layers (issue M3-19): wind and open air, always, strongest in
// the city zoom band; construction while buildings go up in view, in the
// street band only. Both are synthesised (config.ts); there are no audio
// files. The view calls `update` once a frame with the camera's height and
// where on screen the buildings the renderer is drawing under construction
// sit, so the sim is never asked.

import { ZOOM_BANDS } from "../camera/config";
import type { ZoomBand } from "../camera/zoom-band";
import { CONSTRUCTION_SOUND, WIND } from "./config";
import type { AmbienceBlock, CueOutcome, SoundContext, SoundEngine } from "./engine";

/** The wind layer's level for a camera `height` metres above the ground: faint in the street band, rising through the district band, full in the city band. */
export function windLevel(height: number, bands: { streetBelow: number; districtBelow: number } = ZOOM_BANDS): number {
  const t = Math.min(1, Math.max(0, (height - bands.streetBelow) / (bands.districtBelow - bands.streetBelow)));
  return WIND.street + (WIND.city - WIND.street) * t;
}

/** The construction layer's level in zoom band `band`: heard in the street band only. */
export function constructionLevel(band: ZoomBand): number {
  return band === "street" ? CONSTRUCTION_SOUND.level : 0;
}

/** Where a sound from `x` pixels across a screen `width` wide is placed: -spread at the left edge, 0 in the middle, spread at the right. */
export function panAt(x: number, width: number, spread: number = CONSTRUCTION_SOUND.panSpread): number {
  if (!(width > 0)) return 0;
  const across = Math.min(1, Math.max(-1, (x / width) * 2 - 1));
  return across * spread;
}

/** Seconds to the next construction sound with `sites` buildings going up in view, for a `roll` from 0 to 1. */
export function constructionGap(sites: number, roll: number): number {
  const base = CONSTRUCTION_SOUND.gapMin + (CONSTRUCTION_SOUND.gapMax - CONSTRUCTION_SOUND.gapMin) * roll;
  return base / Math.min(CONSTRUCTION_SOUND.busiest, Math.sqrt(Math.max(1, sites)));
}

/** What the ambience reads from the view each frame. */
export interface AmbientView {
  /** The camera's height above the ground below it, metres. */
  height: number;
  band: ZoomBand;
  /** Seconds since the last frame. */
  seconds: number;
  /** How far across the screen, in pixels, each building going up in view sits. */
  sites: readonly number[];
  /** The screen's width in pixels. */
  width: number;
  /** Whether game time runs. A paused city's buildings stand still, and so does their noise. */
  running: boolean;
}

/** What the ambience is doing, for the test hook. */
export interface AmbienceReport {
  wind: { level: number; playing: boolean };
  construction: {
    level: number;
    /** Buildings going up in view. */
    sites: number;
    /** Whether the layer is heard: in the street band, with buildings going up in view, game time running, and the ambience audible. */
    playing: boolean;
    /** Sounds the layer has played, and what became of the last it asked for. */
    played: number;
    last: CueOutcome | null;
    /** Where the last sound played was placed, -1 left to 1 right. */
    pan: number | null;
  };
  /** Why nothing is scheduled, or null when the ambience may be heard. */
  blocked: AmbienceBlock | null;
}

/** The longest frame the construction timer counts, so a tab coming back from the background does not owe a burst. */
const LONGEST_FRAME = 0.5;

export class Ambience {
  private readonly wind;
  private readonly construction;
  /** Seconds until the next construction sound, while the layer plays. */
  private untilNext = 0;
  private constructionOn = false;
  private report_: AmbienceReport = {
    wind: { level: 0, playing: false },
    construction: { level: 0, sites: 0, playing: false, played: 0, last: null, pan: null },
    blocked: "locked",
  };

  constructor(
    private readonly engine: SoundEngine,
    private readonly random: () => number = Math.random,
  ) {
    this.wind = engine.layer("wind");
    this.construction = engine.layer("construction");
  }

  update(view: AmbientView): void {
    const blocked = this.engine.ambienceBlock();
    const wind = windLevel(view.height);
    this.wind.setLevel(wind);
    const windPlaying = this.engine.hold("wind", true, startWind);

    const level = constructionLevel(view.band);
    this.construction.setLevel(level);
    const on = blocked === null && level > 0 && view.running && view.sites.length > 0;
    const c = this.report_.construction;
    if (on && !this.constructionOn) this.untilNext = CONSTRUCTION_SOUND.gapMin * this.random();
    this.constructionOn = on;
    if (on) {
      this.untilNext -= Math.min(LONGEST_FRAME, Math.max(0, view.seconds));
      if (this.untilNext <= 0) {
        const site = view.sites[Math.floor(this.random() * view.sites.length)] ?? view.width / 2;
        const sounds = CONSTRUCTION_SOUND.sounds;
        const recipe = sounds[Math.floor(this.random() * sounds.length)] ?? sounds[0];
        const pan = panAt(site, view.width);
        const outcome = this.engine.playOnLayer("construction", recipe, pan, CONSTRUCTION_SOUND.voices);
        c.last = outcome;
        if (outcome === "played") {
          c.played++;
          c.pan = pan;
        }
        this.untilNext = constructionGap(view.sites.length, this.random());
      }
    }
    this.report_ = {
      wind: { level: wind, playing: windPlaying },
      construction: { ...c, level, sites: view.sites.length, playing: on },
      blocked,
    };
  }

  report(): AmbienceReport {
    return { wind: { ...this.report_.wind }, construction: { ...this.report_.construction }, blocked: this.report_.blocked };
  }
}

/** Starts the wind: looped noise, low-passed, its level drifting slowly. Returns what stops it. */
function startWind(ctx: SoundContext, out: AudioNode): () => void {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * WIND.loopSeconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown noise, a running sum of white noise kept from wandering off: softer than white, more like air.
  let last = 0;
  for (let i = 0; i < frames; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(WIND.cutoff, ctx.currentTime);
  const level = ctx.createGain();
  level.gain.setValueAtTime(WIND.gain, ctx.currentTime);
  source.connect(filter);
  filter.connect(level);
  level.connect(out);
  const drifts = WIND.drifts.map((d) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(d.hz, ctx.currentTime);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(WIND.gain * d.depth, ctx.currentTime);
    osc.connect(depth);
    depth.connect(level.gain);
    osc.start(ctx.currentTime);
    return osc;
  });
  source.start(ctx.currentTime);
  return () => {
    const end = ctx.currentTime + 0.05;
    // A short fade, so stopping does not click.
    level.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
    source.stop(end);
    for (const osc of drifts) osc.stop(end);
  };
}

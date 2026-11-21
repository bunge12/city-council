// Issue M3-19: the wind and construction layers. Their levels by zoom band,
// the pan from a screen position, and what the ambience schedules on a fake
// audio context: nothing at all with the ambience volume at zero or muted,
// and no more than a few construction voices however many buildings go up.
import { describe, expect, it } from "vitest";
import { ZOOM_BANDS } from "../src/camera/config";
import { zoomBand } from "../src/camera/zoom-band";
import { Ambience, constructionGap, constructionLevel, levelEnds, panAt, windLevel, type AmbientView } from "../src/sound/ambience";
import { CONSTRUCTION_SOUND, DEFAULT_SOUND, WIND } from "../src/sound/config";
import { engineWith, first, type FakeContext, type FakeGain } from "./fake-audio";

/** A random number generator that repeats, so a test sees the same sounds each run. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const STREET = 200;
const DISTRICT = 1500;
const CITY = 6000;

function viewAt(height: number, sites: number[] = [], extra: Partial<AmbientView> = {}): AmbientView {
  return { height, band: zoomBand(height), seconds: 1 / 60, sites, width: 1000, running: true, ...extra };
}

/** Runs the ambience for `seconds` at 60 frames a second, moving the fake clock, and returns the most voices sounding at once. */
function run(ambience: Ambience, ctx: FakeContext, engine: { voices: number }, seconds: number, view: AmbientView): number {
  let most = 0;
  for (let i = 0; i < seconds * 60; i++) {
    ctx.currentTime += 1 / 60;
    ambience.update(view);
    most = Math.max(most, engine.voices);
  }
  return most;
}

describe("layer levels by zoom band", () => {
  it("the wind is faint in the street band, louder in the district band and strongest in the city band", () => {
    expect(zoomBand(STREET)).toBe("street");
    expect(zoomBand(DISTRICT)).toBe("district");
    expect(zoomBand(CITY)).toBe("city");
    expect(windLevel(STREET)).toBe(WIND.street);
    expect(windLevel(DISTRICT)).toBeGreaterThan(WIND.street);
    expect(windLevel(DISTRICT)).toBeLessThan(WIND.city);
    expect(windLevel(CITY)).toBe(WIND.city);
    expect(WIND.street).toBeLessThan(WIND.city / 4);
  });

  it("the wind rises steadily with the camera, with no jump at a band's edge", () => {
    let last = windLevel(50);
    for (let h = 50; h <= 8000; h += 50) {
      const level = windLevel(h);
      expect(level).toBeGreaterThanOrEqual(last);
      expect(level - last).toBeLessThan(0.05);
      last = level;
    }
    expect(windLevel(ZOOM_BANDS.streetBelow)).toBe(WIND.street);
    expect(windLevel(ZOOM_BANDS.districtBelow)).toBe(WIND.city);
  });

  it("construction is heard in the street band only", () => {
    expect(constructionLevel("street")).toBe(CONSTRUCTION_SOUND.level);
    expect(constructionLevel("street")).toBeGreaterThan(0);
    expect(constructionLevel("district")).toBe(0);
    expect(constructionLevel("city")).toBe(0);
  });
});

describe("pan from a screen position", () => {
  it("places a building at the left edge left, in the middle centred and at the right edge right", () => {
    expect(panAt(0, 1000)).toBeCloseTo(-CONSTRUCTION_SOUND.panSpread);
    expect(panAt(250, 1000)).toBeCloseTo(-CONSTRUCTION_SOUND.panSpread / 2);
    expect(panAt(500, 1000)).toBeCloseTo(0);
    expect(panAt(1000, 1000)).toBeCloseTo(CONSTRUCTION_SOUND.panSpread);
  });

  it("holds a point off the screen at the edge, and centres everything on a screen with no width", () => {
    expect(panAt(-300, 1000)).toBeCloseTo(-CONSTRUCTION_SOUND.panSpread);
    expect(panAt(1800, 1000)).toBeCloseTo(CONSTRUCTION_SOUND.panSpread);
    expect(panAt(10, 0)).toBe(0);
  });
});

describe("construction gaps", () => {
  it("are uneven, and shorter with more buildings, up to a limit", () => {
    expect(constructionGap(1, 0)).toBeCloseTo(CONSTRUCTION_SOUND.gapMin);
    expect(constructionGap(1, 1)).toBeCloseTo(CONSTRUCTION_SOUND.gapMax);
    expect(constructionGap(4, 0.5)).toBeLessThan(constructionGap(1, 0.5));
    expect(constructionGap(100, 0.5)).toBeCloseTo(constructionGap(1, 0.5) / CONSTRUCTION_SOUND.busiest);
  });
});

describe("Ambience", () => {
  it("schedules nothing before the first click or key", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    ambience.update(viewAt(STREET, [500]));
    expect(contexts).toHaveLength(0);
    const report = ambience.report();
    expect(report.blocked).toBe("locked");
    expect(report.wind.playing).toBe(false);
    expect(report.construction.playing).toBe(false);
  });

  it("starts the wind once audio starts, and sets its layer from the camera's height", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    ambience.update(viewAt(STREET));
    expect(ambience.report().wind).toEqual({ level: WIND.street, playing: true });
    const loops = ctx.sources.filter((s) => s.loop);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.started).not.toBeNull();
    const layer = engine.layer("wind").input() as unknown as FakeGain;
    expect(layer.gain.value).toBe(WIND.street);
    ambience.update(viewAt(CITY));
    expect(layer.gain.value).toBe(WIND.city);
    // Still the one wind, not a second started on top.
    expect(ctx.sources.filter((s) => s.loop)).toHaveLength(1);
  });

  it("with the ambience volume at zero schedules no layer, and stops the wind if it was playing", () => {
    const { engine, contexts } = engineWith({ ...DEFAULT_SOUND, ambience: 0 });
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    const nodes = () => ctx.sources.length + ctx.panners.length;
    run(ambience, ctx, engine, 10, viewAt(STREET, [200, 500, 800]));
    expect(nodes()).toBe(0);
    expect(ambience.report()).toMatchObject({ blocked: "silent", wind: { playing: false }, construction: { playing: false, played: 0 } });

    engine.setSettings({ ...DEFAULT_SOUND });
    ambience.update(viewAt(STREET, [500]));
    const wind = ctx.sources.find((s) => s.loop);
    expect(wind?.stopped).toBeNull();
    engine.setSettings({ ...DEFAULT_SOUND, ambience: 0 });
    ambience.update(viewAt(STREET, [500]));
    expect(wind?.stopped).not.toBeNull();
    const before = nodes();
    run(ambience, ctx, engine, 10, viewAt(STREET, [200, 500, 800]));
    expect(nodes()).toBe(before);
  });

  it("muted, schedules no layer", () => {
    const { engine, contexts } = engineWith({ ...DEFAULT_SOUND, muted: true });
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    run(ambience, ctx, engine, 10, viewAt(STREET, [500]));
    expect(ctx.sources).toHaveLength(0);
    expect(ambience.report().blocked).toBe("muted");
  });

  it("plays construction while buildings go up in view in the street band, placed by where they sit", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    run(ambience, ctx, engine, 10, viewAt(STREET, [100]));
    const report = ambience.report().construction;
    expect(report.playing).toBe(true);
    expect(report.sites).toBe(1);
    // One building's gaps are at most gapMax apart.
    expect(report.played).toBeGreaterThanOrEqual(Math.floor(10 / CONSTRUCTION_SOUND.gapMax));
    expect(report.pan).toBeCloseTo(panAt(100, 1000));
    for (const p of ctx.panners) expect(p.pan.value).toBeCloseTo(panAt(100, 1000));
  });

  it("is silent with no building going up, out of the street band, or with the city paused", () => {
    for (const view of [viewAt(STREET, []), viewAt(DISTRICT, [500]), viewAt(CITY, [500]), viewAt(STREET, [500], { running: false })]) {
      const { engine, contexts } = engineWith();
      const ambience = new Ambience(engine, seeded());
      engine.unlock();
      const ctx = first(contexts);
      run(ambience, ctx, engine, 10, view);
      expect(ambience.report().construction).toMatchObject({ playing: false, played: 0 });
      expect(ctx.panners).toHaveLength(0);
    }
  });

  it("stops when the last building in view is finished", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    run(ambience, ctx, engine, 5, viewAt(STREET, [500]));
    const played = ambience.report().construction.played;
    expect(played).toBeGreaterThan(0);
    run(ambience, ctx, engine, 5, viewAt(STREET, []));
    expect(ambience.report().construction).toMatchObject({ playing: false, played });
  });

  it("makes ten buildings going up a few voices, not ten, and leaves the rest of the cap to the cues", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    const ten = Array.from({ length: 10 }, (_, i) => 50 + i * 100);
    const most = run(ambience, ctx, engine, 30, viewAt(STREET, ten));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(CONSTRUCTION_SOUND.voices);
    // Busier than one building, but not ten times as busy.
    const one = engineWith();
    const alone = new Ambience(one.engine, seeded());
    one.engine.unlock();
    run(alone, first(one.contexts), one.engine, 30, viewAt(STREET, [500]));
    const busy = ambience.report().construction.played;
    const quiet = alone.report().construction.played;
    expect(busy).toBeGreaterThan(quiet);
    expect(busy).toBeLessThanOrEqual(quiet * CONSTRUCTION_SOUND.busiest * 1.5);
    // While construction sounds, a cue still finds a voice.
    expect(engine.play("road")).toBe("played");
  });

  it("takes construction voices from the cap the cues share", () => {
    const { engine, contexts } = engineWith(undefined, 2);
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    expect(engine.play("bulldoze")).toBe("played");
    expect(engine.play("bulldoze")).toBe("played");
    // Every voice is in use: the next construction sound is dropped, not added on top.
    // The frames pass with the audio clock held, so the two cues are still sounding when the first construction sound is due.
    for (let i = 0; i < 60; i++) ambience.update(viewAt(STREET, [500]));
    expect(ctx.currentTime).toBe(0);
    expect(engine.voices).toBe(2);
    expect(ctx.panners).toHaveLength(0);
    expect(ambience.report().construction.last).toBe("capped");
  });

  it("pauses in a hidden tab, so the wind does not play on with no frame to stop it, and starts again when shown", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    ambience.update(viewAt(STREET));
    const wind = ctx.sources.find((s) => s.loop);
    engine.setHidden(true);
    expect(ctx.state).toBe("suspended");
    // A cue asked for while hidden does not ask the context to resume.
    const before = ctx.resumed;
    expect(engine.play("road")).toBe("suspended");
    expect(ctx.resumed).toBe(before);
    ambience.update(viewAt(STREET, [500]));
    expect(ambience.report()).toMatchObject({ blocked: "suspended", wind: { playing: false }, construction: { playing: false } });
    expect(wind?.stopped).not.toBeNull();
    const resumed = ctx.resumed;
    engine.setHidden(false);
    expect(ctx.resumed).toBe(resumed + 1);
    // The browser runs the clock again.
    ctx.state = "running";
    ambience.update(viewAt(STREET));
    expect(ambience.report().wind.playing).toBe(true);
    // The wind's loop is made once and used again.
    const loops = ctx.sources.filter((s) => s.loop);
    expect(loops).toHaveLength(2);
    expect(loops[1]?.buffer).toBe(loops[0]?.buffer);
  });

  it("goes quiet, and leaves the frame loop running, if a Web Audio call throws", () => {
    const { engine, contexts } = engineWith();
    const ambience = new Ambience(engine, seeded());
    engine.unlock();
    const ctx = first(contexts);
    ctx.createStereoPanner = () => {
      throw new Error("no panner in this browser");
    };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(() => run(ambience, ctx, engine, 3, viewAt(STREET, [500]))).not.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(ctx.sources.find((s) => s.loop)?.stopped).not.toBeNull();
  });
});

describe("the wind's loop", () => {
  it("ends where it starts, so it has no seam", () => {
    const data = Float32Array.from([0.1, 0.3, -0.2, 0.4, 0.5]);
    levelEnds(data);
    expect(data[4]).toBeCloseTo(data[0] ?? NaN);
    expect(data[0]).toBeCloseTo(0.1);
    expect(data[2]).toBeCloseTo(-0.2 - 0.4 * 0.5);
  });
});

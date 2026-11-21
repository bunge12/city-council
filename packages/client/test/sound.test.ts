// Issue M3-02: the audio engine, the cue each answer makes, and the kept
// settings. The engine runs on a fake audio context that counts the nodes
// it is asked for, so "nothing scheduled" can be checked without listening.
import { describe, expect, it } from "vitest";
import { CommandCues } from "../src/sound/command-cues";
import { CUES, DEFAULT_SOUND, MAX_VOICES } from "../src/sound/config";
import { SoundEngine } from "../src/sound/engine";
import { engineWith, first, type FakeGain } from "./fake-audio";
import { SOUND_STORAGE_KEY, loadSound, saveSound } from "../src/sound/settings";

describe("SoundEngine", () => {
  it("makes no audio context and schedules nothing before the first interaction", () => {
    const { engine, contexts } = engineWith();
    expect(engine.play("road")).toBe("locked");
    expect(engine.play("reject")).toBe("locked");
    expect(contexts).toHaveLength(0);
    expect(engine.unlocked).toBe(false);
    expect(engine.voices).toBe(0);
    expect(engine.requests()).toEqual([
      { cue: "road", outcome: "locked" },
      { cue: "reject", outcome: "locked" },
    ]);
  });

  it("starts on the first interaction and plays from then on", () => {
    const { engine, contexts } = engineWith();
    engine.unlock();
    expect(contexts).toHaveLength(1);
    const ctx = first(contexts);
    expect(ctx.resumed).toBe(1);
    expect(engine.play("road")).toBe("played");
    expect(ctx.sources.length).toBe(CUES.road.tones.length);
    expect(ctx.sources.every((s) => s.started !== null && s.started >= ctx.currentTime)).toBe(true);
    // A second interaction resumes the same context; it never makes another.
    engine.unlock();
    expect(contexts).toHaveLength(1);
    expect(ctx.resumed).toBe(2);
  });

  it("holds the voice cap, and frees voices as cues end", () => {
    const { engine, contexts } = engineWith(undefined, 3);
    engine.unlock();
    const ctx = first(contexts);
    const outcomes = Array.from({ length: 5 }, () => engine.play("zone"));
    expect(outcomes).toEqual(["played", "played", "played", "capped", "capped"]);
    expect(engine.voices).toBe(3);
    const scheduled = ctx.sources.length;
    expect(scheduled).toBe(3 * CUES.zone.tones.length);
    // A second later every cue has ended, and the voices are free again.
    ctx.currentTime = 1;
    expect(engine.voices).toBe(0);
    expect(engine.play("zone")).toBe("played");
  });

  it("caps at the configured number by default", () => {
    const { engine } = engineWith();
    engine.unlock();
    const played = Array.from({ length: MAX_VOICES + 4 }, () => engine.play("road")).filter((o) => o === "played");
    expect(played).toHaveLength(MAX_VOICES);
  });

  it("mute silences everything: no cue is scheduled and the master is at zero", () => {
    const { engine, contexts } = engineWith({ ...DEFAULT_SOUND, muted: true });
    const layer = engine.layer("wind");
    layer.setLevel(0.8);
    engine.unlock();
    const ctx = first(contexts);
    const before = ctx.sources.length;
    for (const cue of Object.keys(CUES) as (keyof typeof CUES)[]) expect(engine.play(cue)).toBe("muted");
    expect(ctx.sources.length).toBe(before);
    // The master gain feeds the destination; both buses and the layer run through it.
    const master = ctx.gains.find((g) => g.outputs.includes(ctx.destination));
    expect(master?.gain.value).toBe(0);
    // Unmuted, cues play again.
    engine.setSettings({ ...DEFAULT_SOUND, muted: false });
    expect(master?.gain.value).toBeGreaterThan(0);
    expect(engine.play("undo")).toBe("played");
  });

  it("schedules nothing while the browser holds the context paused, and asks it to resume", () => {
    const { engine, contexts } = engineWith();
    engine.unlock();
    const ctx = first(contexts);
    ctx.state = "suspended";
    const resumedBefore = ctx.resumed;
    // Its clock is stopped, so cues on it would hold the voices for good.
    const outcomes = Array.from({ length: MAX_VOICES + 2 }, () => engine.play("road"));
    expect(outcomes.every((o) => o === "suspended")).toBe(true);
    expect(ctx.sources).toHaveLength(0);
    expect(engine.voices).toBe(0);
    expect(engine.unlocked).toBe(false);
    expect(ctx.resumed).toBeGreaterThan(resumedBefore);
    ctx.state = "running";
    expect(engine.unlocked).toBe(true);
    expect(engine.play("road")).toBe("played");
  });

  it("schedules nothing with the interface volume at zero", () => {
    const { engine, contexts } = engineWith({ ...DEFAULT_SOUND, interface: 0 });
    engine.unlock();
    expect(engine.play("bulldoze")).toBe("silent");
    expect(first(contexts).sources).toHaveLength(0);
  });

  it("says so when the browser gives no audio context, and keeps recording", () => {
    const engine = new SoundEngine({
      createContext: () => {
        throw new Error("no audio");
      },
      settings: { ...DEFAULT_SOUND },
    });
    engine.unlock();
    expect(engine.unlocked).toBe(false);
    expect(engine.play("road")).toBe("unavailable");
    expect(engine.requests()).toEqual([{ cue: "road", outcome: "unavailable" }]);
  });

  it("gives a layer a gain under the ambience bus once audio starts, at the level the view set", () => {
    const { engine, contexts } = engineWith({ ...DEFAULT_SOUND, ambience: 0.25 });
    const layer = engine.layer("wind");
    expect(layer.input()).toBeNull();
    layer.setLevel(0.6);
    engine.unlock();
    const ctx = first(contexts);
    const input = layer.input() as unknown as FakeGain;
    expect(input.gain.value).toBe(0.6);
    const ambienceBus = input.outputs[0] as FakeGain;
    expect(ambienceBus.gain.value).toBe(0.25);
    expect(engine.layer("wind")).toBe(layer);
    // A layer makes no sound until the ambience starts a source on it (ambience.test.ts).
    expect(ctx.sources).toHaveLength(0);
  });
});

describe("CommandCues", () => {
  const ok = { ok: true } as const;
  const refused = { ok: false, reason: "no" } as const;

  it("gives each tool's command its cue once the sim applied it", () => {
    const cues = new CommandCues();
    expect(cues.cueFor("BuildRoad", {}, ok)).toBe("road");
    expect(cues.cueFor("BuildRoadGrid", {}, ok)).toBe("road");
    expect(cues.cueFor("ZoneCells", {}, ok)).toBe("zone");
    expect(cues.cueFor("BulldozeRoad", {}, ok)).toBe("bulldoze");
    expect(cues.cueFor("BulldozeBuilding", {}, ok)).toBe("bulldoze");
    expect(cues.cueFor("Undo", {}, ok)).toBe("undo");
    expect(cues.cueFor("SetSpeed", { speed: 1 }, ok)).toBeNull();
    expect(cues.cueFor("NoOp", {}, ok)).toBeNull();
  });

  it("makes every refusal the refusal cue, never the command's own", () => {
    const cues = new CommandCues();
    expect(cues.cueFor("BuildRoad", {}, refused)).toBe("reject");
    expect(cues.cueFor("Undo", {}, refused)).toBe("reject");
    expect(cues.cueFor("SetSpeed", {}, refused)).toBe("reject");
  });

  it("makes one cue for a zone stroke sent as several commands", () => {
    const cues = new CommandCues();
    const heard = [1, 2, 3, 4].map(() => cues.cueFor("ZoneCells", { stroke: 7 }, ok));
    expect(heard).toEqual(["zone", null, null, null]);
    expect(cues.cueFor("ZoneCells", { stroke: 8 }, ok)).toBe("zone");
    expect(cues.cueFor("ZoneCells", {}, ok)).toBe("zone");
  });

  it("makes a stroke the sim took only in part heard as both a zone and a refusal, once each", () => {
    const cues = new CommandCues();
    const heard = [refused, ok, refused, ok].map((r) => cues.cueFor("ZoneCells", { stroke: 3 }, r));
    expect(heard).toEqual(["reject", "zone", null, null]);
  });
});

describe("sound settings", () => {
  function memory(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    };
  }

  it("reads defaults when nothing is kept, or what is kept is unreadable", () => {
    expect(loadSound(null)).toEqual(DEFAULT_SOUND);
    expect(loadSound(memory())).toEqual(DEFAULT_SOUND);
    expect(loadSound(memory({ [SOUND_STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_SOUND);
    expect(loadSound(memory({ [SOUND_STORAGE_KEY]: JSON.stringify({ interface: "loud", muted: 1 }) }))).toEqual(DEFAULT_SOUND);
  });

  it("keeps what the player chose, a volume of zero included", () => {
    const storage = memory();
    expect(saveSound(storage, { interface: 0, ambience: 0.3, muted: true })).toBe(true);
    expect(loadSound(storage)).toEqual({ interface: 0, ambience: 0.3, muted: true });
  });

  it("clamps volumes to 0 to 1", () => {
    const storage = memory({ [SOUND_STORAGE_KEY]: JSON.stringify({ interface: 4, ambience: -1, muted: false }) });
    expect(loadSound(storage)).toEqual({ interface: 1, ambience: 0, muted: false });
  });

  it("reports a browser that will not store", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveSound(storage, { ...DEFAULT_SOUND })).toBe(false);
  });
});

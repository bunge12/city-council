// A fake audio context for the sound tests (issues M3-02, M3-19). It counts
// the nodes it is asked for, so "nothing scheduled" can be checked without
// listening, and its clock moves only when a test moves it.
import { DEFAULT_SOUND } from "../src/sound/config";
import { SoundEngine, type SoundContext } from "../src/sound/engine";
import type { SoundSettings } from "../src/sound/settings";

export class FakeParam {
  value = 1;
  events: string[] = [];
  setValueAtTime(v: number): this {
    this.value = v;
    this.events.push("set");
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    this.events.push("target");
    return this;
  }
  linearRampToValueAtTime(): this {
    this.events.push("linear");
    return this;
  }
  exponentialRampToValueAtTime(): this {
    this.events.push("exp");
    return this;
  }
}

export class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];
  connect<T extends FakeNode | FakeParam>(to: T): T {
    this.outputs.push(to);
    return to;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

export class FakeSource extends FakeNode {
  readonly frequency = new FakeParam();
  type = "sine";
  buffer: unknown = null;
  loop = false;
  started: number | null = null;
  stopped: number | null = null;
  start(t: number): void {
    this.started = t;
  }
  stop(t: number): void {
    this.stopped = t;
  }
}

export class FakeContext {
  currentTime = 0;
  state: AudioContextState = "running";
  readonly sampleRate = 8000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly panners: FakePanner[] = [];
  resumed = 0;
  resume(): Promise<void> {
    this.resumed++;
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBufferSource(): FakeSource {
    return this.createOscillator();
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam } {
    return Object.assign(new FakeNode(), { type: "", frequency: new FakeParam() });
  }
  createStereoPanner(): FakePanner {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createBuffer(_channels: number, length: number): { getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
}

export function first(contexts: FakeContext[]): FakeContext {
  const ctx = contexts[0];
  if (!ctx) throw new Error("no audio context was made");
  return ctx;
}

export function engineWith(settings: SoundSettings = { ...DEFAULT_SOUND }, maxVoices?: number) {
  const contexts: FakeContext[] = [];
  const engine = new SoundEngine({
    createContext: () => {
      const ctx = new FakeContext();
      contexts.push(ctx);
      return ctx as unknown as SoundContext;
    },
    settings,
    ...(maxVoices === undefined ? {} : { maxVoices }),
  });
  return { engine, contexts };
}

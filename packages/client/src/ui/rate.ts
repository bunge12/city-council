// Measures how fast the sim is ticking, as the page sees it. Reads the page's
// clock, which is fine here: this is a readout, not sim code.

/** Ticks per real second over a sliding window of samples. */
export class TickRateMeter {
  private readonly windowMs: number;
  private readonly samples: { at: number; tick: number }[] = [];

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  /** Records that the mirror was at `tick` at real time `at`, in ms. */
  add(at: number, tick: number): void {
    const last = this.samples[this.samples.length - 1];
    // A snapshot that went back in time, such as a load, starts over.
    if (last && tick < last.tick) this.samples.length = 0;
    this.samples.push({ at, tick });
    // Keep one sample at or before the window's start, so the span covers it all.
    while (this.samples.length > 2 && (this.samples[1]?.at ?? at) <= at - this.windowMs) this.samples.shift();
  }

  /** Ticks per second over the window, or null with too little to go on. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at - first.at < this.windowMs / 4) return null;
    return ((last.tick - first.tick) * 1000) / (last.at - first.at);
  }
}

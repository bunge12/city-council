// Which milestones the player should hear and read about (M4-14). Display
// only: it reads the mirror's copy of `SimState.milestones` and nothing
// here feeds back into state.
//
// A milestone is announced once, on the update that brings it. The first
// snapshot, as on opening a city or reloading the page, brings milestones
// reached before the player was looking, so they make no notice and no
// sound. A later snapshot, sent when the copy fell out of step, announces
// those reached after the last tick the copy had: they were reached in play
// while its deltas went missing. A milestone credited without its grant, in
// a city saved before the milestones (M4-12) or a test city, is never
// announced.

import { CREDITED } from "@city-council/sim";

export class MilestoneWatch {
  /** How many milestones the copy held when last looked at, and its tick then, or null before a city. */
  private seen: { count: number; tick: number } | null = null;

  /**
   * Takes in the copy's milestones and tick after an update and returns the
   * index, in `MILESTONES`, of each one reached in play since the last
   * look, lowest first.
   */
  update(milestones: Int32Array | null, tick: number, kind: "snapshot" | "delta"): number[] {
    if (milestones === null) {
      this.seen = null;
      return [];
    }
    const before = this.seen;
    this.seen = { count: milestones.length, tick };
    if (before === null) return [];
    const reached: number[] = [];
    for (let i = before.count; i < milestones.length; i++) {
      const at = milestones[i] ?? CREDITED;
      if (at === CREDITED) continue;
      // A snapshot can carry milestones the copy has never seen and was opened with: only one reached since the copy's tick is news.
      if (kind === "snapshot" && at < before.tick) continue;
      reached.push(i);
    }
    return reached;
  }
}

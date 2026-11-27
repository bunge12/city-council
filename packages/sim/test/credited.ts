// Credits a test city with its milestones (M4-12). Densities 2 and 3 are
// locked until their milestones from M4, and a test that zones them on a new
// city credits it first, so it paints what it painted before. No grant is
// paid. A replay of a credited city's log starts from a city credited the
// same way (`replayFrom(credited(createState(seed)), ...)`).

import { creditMilestones, type SimState } from "../src/index";

/** `state` with its first `count` milestones credited, every one unless given, without grants. Returns it. */
export function credited<S extends SimState>(state: S, count?: number): S {
  creditMilestones(state, count);
  return state;
}

// A landmark's stage as the client draws and describes it (M4-17). The sim
// derives the stage from the milestones reached (landmarks.ts,
// `landmarkStage`) and stores nothing, so the client derives it the same
// way from its copy. The renderer also needs when the landmark last grew,
// so the construction animation plays on placing and again at each stage:
// the tick of the latest milestone reached that grows it, or the tick it
// was placed when that came later. A milestone credited rather than reached
// in play (`CREDITED`) has no tick, so it plays nothing.

import { CREDITED, LANDMARKS, MILESTONES, landmarkStage, landmarkStages } from "@city-council/sim";

/** A landmark's stage, how many it has, and the tick it was drawn going up from last. */
export interface LandmarkLook {
  stage: number;
  stages: number;
  /** The tick its construction animation starts on: when it was placed, or when it last grew if that came later. */
  since: number;
}

/** The stage of a landmark of kind `type` placed on tick `builtAt`, in a city that has reached `milestones`. */
export function landmarkLook(milestones: ArrayLike<number>, type: number, builtAt: number): LandmarkLook {
  const state = { milestones: milestones as Int32Array };
  const kind = LANDMARKS[type];
  let since = builtAt;
  if (kind) {
    const reached = Math.min(milestones.length, MILESTONES.length);
    for (let i = 0; i < reached; i++) {
      const tick = milestones[i] ?? CREDITED;
      if (tick !== CREDITED && tick > since && (MILESTONES[i]?.grows ?? []).includes(kind.id)) since = tick;
    }
  }
  return { stage: landmarkStage(state, type), stages: landmarkStages(type), since };
}

import { describe, expect, it } from "vitest";
import { DERIVED_STAGES, deserialize, hashState, prepareDerived, serialize, type DerivedStage } from "../src/index";
import jobs from "./fixtures/replay/jobs.json" with { type: "json" };
import { replayFixture, type ReplayFixture } from "./replay-helper";

// The loading screen (issue #327) shows how far `prepareDerived` has got on a
// loaded city from the stages it names as it starts each.
describe("prepareDerived's stages", () => {
  const city = replayFixture(jobs as ReplayFixture);
  const bytes = serialize(city);

  it("names every stage once, in order, on a city loaded from a save", () => {
    const loaded = deserialize(bytes).state;
    const seen: DerivedStage[] = [];
    prepareDerived(loaded, (stage) => seen.push(stage));
    expect(seen).toEqual([...DERIVED_STAGES]);
  });

  it("leaves the city as it leaves it without anyone told", () => {
    const told = deserialize(bytes).state;
    const untold = deserialize(bytes).state;
    prepareDerived(told, () => undefined);
    prepareDerived(untold);
    expect(hashState(told)).toBe(hashState(untold));
  });
});

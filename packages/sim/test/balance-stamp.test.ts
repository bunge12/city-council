import { describe, expect, it } from "vitest";
import { BALANCE_STAMP, createState, hashState, replay, replaysUnderThisBalance } from "../src/index";
import { balanceStampOf } from "../src/balance-stamp";

// The balance stamp (M1 review, issue 80): a city says which balance numbers
// it was made under, so a log is not replayed under others without notice.

describe("the balance stamp", () => {
  const files = {
    roads: {
      _about: "Words for people.",
      types: [{ id: "street", maxSlope: 0.16, buildCostPerMetre: { amount: 900, sourceYear: 2024, source: "A report", note: "Rounded." } }],
    },
    time: { ticksPerDay: 100 },
  };

  const copy = (): typeof files => JSON.parse(JSON.stringify(files)) as typeof files;

  it("changes when a number changes", () => {
    const steeper = copy();
    (steeper.roads.types[0] as { maxSlope: number }).maxSlope = 0.12;
    expect(balanceStampOf(steeper)).not.toBe(balanceStampOf(files));
    const dearer = copy();
    (dearer.roads.types[0] as { buildCostPerMetre: { amount: number } }).buildCostPerMetre.amount = 901;
    expect(balanceStampOf(dearer)).not.toBe(balanceStampOf(files));
  });

  it("does not change when only the words for people do, or the order of the keys", () => {
    const reworded = copy();
    reworded.roads._about = "Other words.";
    const price = (reworded.roads.types[0] as { buildCostPerMetre: Record<string, unknown> }).buildCostPerMetre;
    price["source"] = "Another report";
    price["note"] = "Not rounded.";
    price["sourceUrl"] = "https://example.com";
    expect(balanceStampOf(reworded)).toBe(balanceStampOf(files));
    expect(balanceStampOf({ time: files.time, roads: files.roads })).toBe(balanceStampOf(files));
  });

  it("is on every new city and every replayed one, and is part of the state hash", () => {
    const state = createState(5);
    expect(state.balance).toBe(BALANCE_STAMP);
    expect(BALANCE_STAMP).toMatch(/^[0-9a-f]{16}$/);
    expect(replaysUnderThisBalance(state)).toBe(true);
    expect(replay(5, [], 3).balance).toBe(BALANCE_STAMP);
    expect(hashState({ ...state, balance: "" })).not.toBe(hashState(state));
    expect(replaysUnderThisBalance({ balance: "" })).toBe(false);
  });
});

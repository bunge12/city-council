import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BALANCE_STAMP, createState, hashState, replay, replaysUnderThisBalance } from "../src/index";
import { BALANCE_FILES, balanceStampOf } from "../src/balance-stamp";

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

  it("covers every balance file the sim reads, and is pinned", () => {
    // budgets.json is CI's timing budgets, not the game's numbers, so it is not in the stamp.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../balance");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "budgets.json").map((f) => f.replace(/\.json$/, ""));
    expect(Object.keys(BALANCE_FILES).sort()).toEqual(files.sort());
    expect(BALANCE_STAMP).toBe(balanceStampOf(BALANCE_FILES));
    // Moves with any balance number. Update it with the replay fixtures and say which number moved.
    expect(BALANCE_STAMP).toBe("0ef336e5d5886479");
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

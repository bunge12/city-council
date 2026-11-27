// What the time card, the activity log and the milestone notice say about
// money (M4-14), and which money cues play. Display only: the figures come
// from the mirror's copy, and these check the words for a set of them.
import { describe, expect, it } from "vitest";
import { CREDITED, LEDGER_LINES, LINE, MILESTONES, type LedgerLine } from "@city-council/sim";
import { formatLogAmount, formatTreasury, formatTreasuryTitle } from "../src/ui/money-figures";
import { MilestoneWatch } from "../src/ui/milestone-watch";
import { milestoneLines } from "../src/ui/MilestoneNotice";
import { CommandCues, moneyCue } from "../src/sound/command-cues";
import { CUES } from "../src/sound/config";

/** A month's ledger with these lines filled, the rest at zero. */
function ledger(lines: Partial<Record<LedgerLine, number>>): Float64Array {
  const month = new Float64Array(LEDGER_LINES.length);
  for (const [line, amount] of Object.entries(lines)) month[LINE[line as LedgerLine]] = amount;
  return month;
}

describe("the treasury in the time card", () => {
  it("shows a dash before a city is open, like the date", () => {
    expect(formatTreasury(null)).toBe("-");
    expect(formatTreasuryTitle(null)).toBe("The city's money");
  });

  it("shows the treasury in short form, in the billions too", () => {
    expect(formatTreasury(20_000_000)).toBe("$20M");
    expect(formatTreasury(480_250_000)).toBe("$480M");
    expect(formatTreasury(3_240_000_000)).toBe("$3.2B");
    expect(formatTreasury(950)).toBe("$950");
    expect(formatTreasury(0)).toBe("$0");
  });

  it("shows a treasury below zero with its sign", () => {
    expect(formatTreasury(-412_000)).toBe("-$412K");
    expect(formatTreasury(-2_500_000)).toBe("-$2.5M");
  });

  it("gives the balance in full and the month so far, income, expenses and net, in the tooltip", () => {
    const month = ledger({ taxResidential: 1_200_000, chargeResidential: 300_000, grants: 5_000_000, construction: 4_100_000, roadUpkeep: 250_000 });
    expect(formatTreasuryTitle({ treasury: 21_950_000, month })).toBe(
      ["Treasury $21,950,000", "This month so far:", "Income $6.5M", "Expenses $4.3M", "Net +$2.1M"].join("\n"),
    );
  });

  it("says when the treasury is overdrawn, and gives a month that lost money a negative net", () => {
    const month = ledger({ taxResidential: 40_000, construction: 1_400_000, compensation: 90_000 });
    expect(formatTreasuryTitle({ treasury: -312_500, month })).toBe(
      ["Treasury -$312,500, overdrawn", "This month so far:", "Income $40K", "Expenses $1.5M", "Net -$1.4M"].join("\n"),
    );
  });

  it("reads a city in the billions", () => {
    const month = ledger({ taxResidential: 1_800_000_000, taxCommercial: 600_000_000, otherSpending: 2_100_000_000 });
    expect(formatTreasuryTitle({ treasury: 3_240_000_000, month })).toBe(
      ["Treasury $3,240,000,000", "This month so far:", "Income $2.4B", "Expenses $2.1B", "Net +$300M"].join("\n"),
    );
  });

  it("gives a month with nothing in it a net of nothing", () => {
    expect(formatTreasuryTitle({ treasury: 20_000_000, month: ledger({}) }).split("\n").at(-1)).toBe("Net $0");
  });
});

describe("money in the activity log", () => {
  it("names a cost, marks money paid in with a plus, and says nothing for a command that moved none", () => {
    expect(formatLogAmount(1_400_000)).toBe("$1.4M");
    expect(formatLogAmount(-12_000)).toBe("+$12K");
    expect(formatLogAmount(0)).toBe("");
    expect(formatLogAmount(undefined)).toBe("");
  });
});

describe("the milestone notice", () => {
  it("names the milestone, its grant and what it unlocked", () => {
    const village = MILESTONES[0];
    expect(village).toBeDefined();
    if (!village) return;
    expect(milestoneLines({ ...village, name: "Village", population: 1000, grant: 5_000_000, unlocks: ["density2", "cityHall"] })).toEqual({
      title: "Village reached",
      detail: "1,000 residents. Grant of $5M paid. Unlocked: Medium density and City Hall.",
    });
  });

  it("says nothing of unlocks for a milestone that opens none", () => {
    expect(milestoneLines({ name: "Town", population: 2500, grant: 8_000_000, unlocks: [] }).detail).toBe("2,500 residents. Grant of $8M paid.");
  });
});

describe("MilestoneWatch", () => {
  it("announces nothing the first snapshot brings, as on opening a city or a reload", () => {
    const watch = new MilestoneWatch();
    expect(watch.update(Int32Array.of(400), 500, "snapshot")).toEqual([]);
    expect(watch.update(Int32Array.of(400), 501, "delta")).toEqual([]);
  });

  it("announces each milestone a delta brings once, lowest first", () => {
    const watch = new MilestoneWatch();
    watch.update(new Int32Array(0), 0, "snapshot");
    expect(watch.update(new Int32Array(0), 1, "delta")).toEqual([]);
    expect(watch.update(Int32Array.of(900), 901, "delta")).toEqual([0]);
    expect(watch.update(Int32Array.of(900), 902, "delta")).toEqual([]);
    expect(watch.update(Int32Array.of(900, 1500, 1500), 1501, "delta")).toEqual([1, 2]);
  });

  it("never announces a milestone credited without its grant", () => {
    const watch = new MilestoneWatch();
    watch.update(new Int32Array(0), 0, "snapshot");
    expect(watch.update(Int32Array.of(CREDITED, CREDITED), 1, "delta")).toEqual([]);
  });

  it("announces a milestone a resync snapshot brings when it was reached after the copy's tick, as when the delta that crossed it went missing", () => {
    const watch = new MilestoneWatch();
    watch.update(Int32Array.of(400), 1000, "snapshot");
    expect(watch.update(Int32Array.of(400, 1200), 1300, "snapshot")).toEqual([1]);
    expect(watch.update(Int32Array.of(400, 1200), 1301, "delta")).toEqual([]);
  });

  it("starts again when the copy has no city", () => {
    const watch = new MilestoneWatch();
    watch.update(Int32Array.of(900), 1000, "snapshot");
    expect(watch.update(null, 0, "delta")).toEqual([]);
    expect(watch.update(Int32Array.of(900, 1500), 2000, "snapshot")).toEqual([]);
  });
});

describe("money cues", () => {
  it("plays money spent on a command that took money, and nothing for one that cost nothing, paid in or was refused", () => {
    expect(moneyCue({ ok: true, spent: 1_400_000 })).toBe("money");
    expect(moneyCue({ ok: true, spent: 0 })).toBeNull();
    expect(moneyCue({ ok: true, spent: -12_000 })).toBeNull();
    expect(moneyCue({ ok: false })).toBeNull();
  });

  it("leaves the command's own cue as it was, so a road is heard as a road and then money", () => {
    const cues = new CommandCues();
    expect(cues.cueFor("BuildRoadGrid", {}, { ok: true })).toBe("road");
  });

  it("starts money spent after the road cue's first tone, so the two are heard one after the other", () => {
    const firstMoney = Math.min(...CUES.money.tones.map((t) => t.at));
    expect(firstMoney).toBeGreaterThan(CUES.road.tones[0].at + CUES.road.tones[0].length / 2);
  });

  it("keeps every cue but the milestone under a quarter of a second, and the milestone under half", () => {
    for (const [name, recipe] of Object.entries(CUES)) {
      const end = Math.max(...recipe.tones.map((t) => t.at + t.length), "noise" in recipe ? recipe.noise.at + recipe.noise.length : 0);
      expect(end, name).toBeLessThan(name === "milestone" ? 0.5 : 0.25);
    }
  });
});

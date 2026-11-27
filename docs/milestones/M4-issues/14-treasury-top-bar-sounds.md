# M4-14: Treasury in the bottom right, money in the log, and money sounds

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 03, 12.

## Goal

The player always sees how much money the city has, hears when it is spent, and knows when a milestone is reached. See "Sound" and "City status" in the PRD.

## Scope

- The treasury in the same card as the time controls, in the bottom right corner, in short form ($3.2B, $480M). Below zero it shows in the warning colour. Before a city is open it shows "-", like the date
- Its tooltip gives this month's income and expenses so far and the net, from the mirror's ledger
- The activity log names the amount on each entry that moved money: "local built a street, $1.4M"
- The "money spent" interface sound on a command that charged the treasury, and the "milestone reached" sound on a milestone, through the sound engine from M3-02. The test hook M3-02 added records both
- A short notice when a milestone is reached: its name, its grant, and what it unlocked

## Out of scope

- The budget panel, which is issue 15
- Prices in the tools, which are issue 16

## Done when

- [ ] Unit tests for the treasury text and tooltip from a set of ledger figures, including below zero and in the billions
- [ ] A Playwright test builds a road and finds the treasury fall by the road's price, the log entry name the amount and the sound hook record "money spent"
- [ ] The same test passes a milestone from a city file a day short of it and finds the notice and the "milestone reached" sound
- [ ] The figures survive a reload
- [ ] Screenshots of the top bar with money, below zero, and of the milestone notice in the pull request
- [ ] No change to sim state, the snapshot version or the protocol version

## Notes

The money sound plays once per command, not once per segment of a grid.

Originally placed in the top bar, beside Stats. Moved to the time card before work started, as the issue says.

A treasury that flickers every tick is noise. It moves once a day with taxes and upkeep and at each command, which is what issue 02 proposes.

# M4-02: Treasury, ledger and the monthly close

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 01.

## Goal

The city has one treasury, and every dollar in or out of it is on a line of the month's budget. See "M4 Economy" in the PRD.

## Scope

- `SimState` gains the treasury, in whole dollars, and the ledger: income and expenses by line for the month in progress and for the month before. The lines are the PRD's table: residential, commercial, office and industrial tax, development charges by zone, grants, loans taken, construction, demolition, compensation, road upkeep, building upkeep, loan repayments, interest, and the "other city spending" line from the decision in M4.md. A line M4 does not fill yet stays at zero
- One internal function moves money: it takes a line and a whole-dollar amount and changes the treasury and the line together. Nothing else writes either
- The four tax rates, residential, commercial, office and industrial, at their defaults from `economy.json`. Issues 05 and 06 read them and issue 07 adds the command that sets them
- A new city starts with the starting grant from `economy.json`, on the grants line
- The budget closes on the first tick of each game month: the month in progress becomes the month before, and a new one starts at zero
- The statistics history from M3-04 gains a monthly sample of the treasury, the month's income, the month's expenses and the month's tax income. Money series are `Float64Array`, since a treasury passes the 2.1 billion an `Int32Array` holds. Issue 11 reads a year of tax income from them
- The exact daily share: a helper that spreads a yearly amount over the days of a game year with no fraction stored, day d charging floor(yearly × (d + 1) / 365) less floor(yearly × d / 365). Issues 04 and 05 use it
- The treasury and the ledger go in the delta when they change. The mirror holds them
- `SNAPSHOT_VERSION` and the protocol version go up. The migration gives an older city the starting grant and an empty ledger, with a test

## Out of scope

- Anything that charges or pays, which is 03 onward
- What the player sees, which is 14 and 15
- Loans, which are 11

## Done when

- [ ] Unit tests move money on each line and find the treasury equal to the starting grant plus every line ever moved
- [ ] A test of the daily share: over a year the days add up to the yearly amount exactly, for amounts from $1 to $10B
- [ ] A test steps across a month's end and finds the month filed and a new one at zero
- [ ] A test helper in `packages/sim/test` that checks the treasury against the ledger and the history at every step of a long scripted session, used by the later issues
- [ ] The migration test loads a version 29 city and finds it unchanged apart from the treasury, the ledger and the history's new series
- [ ] A replay gives the same state hash, and a city saved mid-month resumes to the same hash

## Notes

Settle the "other city spending" decision in M4.md with the project owner before starting. This issue adds its line, at $0 if the decision waits for issue 19, so adding it later is not another change to the shape of state.

Keep the ledger flat: a fixed list of lines, each a float64 for this month and one for the last. No objects keyed by line name in state.

The treasury can go below zero, down to the overdraft. Issue 03 enforces the floor. This issue only stores the number.

The closed month is what the budget panel shows as "last month". The history keeps the long view for the statistics panel.

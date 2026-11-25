# M4-03: Construction costs and the overdraft

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Roads cost what their plan says, and a city that has spent its money stops building. See "Prices in 2026 dollars" and the overdraft paragraph in the PRD.

## Scope

- `BuildRoad`, `BuildRoadGrid` and `UpgradeRoad` charge the cost their plan functions already work out, on the tick they apply, to the construction line
- `BulldozeRoad` charges its plan's demolition cost, less the refund share of the road's build cost from `economy.json`, to the demolition line. A bulldoze that refunds more than it costs pays into the treasury
- A command that would take the treasury below the overdraft is refused, with a reason that gives the price and what is left: "Costs $4.2M, $1.1M available". The check is in `validate`, and in the state-level previews the tools call: `previewBuildRoad` and `previewBuildRoadGrid` (buildings/bulldoze.ts) and one for upgrades, which return the price and the refusal. The plain `planRoad` has no treasury to check
- Zoning stays open past the overdraft, as the proposal in M4.md says. If the decision goes the other way, `ZoneCells` is refused instead. Either way, the PRD's overdraft paragraph is updated in this pull request
- Undo reverses exactly the money the undone command moved: a road undone is refunded in full, and a bulldoze undone takes its refund back. The amount goes on the undo record, since the log entry it points to can page out of live state. An undo that cannot pay is refused like any other command
- The amount every command moved is kept beside its log entry, in an array that pages with the live log, so the log can name who spent it. Not inside the entry: the log is the replay input, and a result does not belong in it
- A way for generators and tests to fund a city. `generateScaleCity`, the standard balance cities and the test builders set the treasury through a test helper, like the one that holds the demand bars, so they build what they built before
- `SNAPSHOT_VERSION` goes up for the undo amounts and the log's amounts, with a migration and a test

## Out of scope

- The price of buildings a road command takes with it, which is issue 09
- City Hall's price, which is issue 13
- The road tool showing the price in red, and the sounds, which are 16 and 14

## Done when

- [ ] Unit tests build, upgrade and bulldoze roads and find the treasury moved by exactly each plan's cost, on the right line
- [ ] A test brings the treasury to the overdraft and finds each costing command refused with the reason, and zoning not refused, or refused if the decision went that way
- [ ] A test undoes a build and a bulldoze and finds the money reversed exactly
- [ ] Two commands in one step that together pass the overdraft: the first applies and the second is dropped with the reason
- [ ] The three scale cities still meet their targets, and the M3 walkthroughs and balance cities still build what they built
- [ ] Replay fixtures with roads are recorded again, and the pull request says why
- [ ] A replay gives the same state hash

## Notes

The plan functions already return `cost` for the road tool's readout. Charge that number and nothing else, so the readout and the charge can never disagree.

Upkeep keeps running past the overdraft. A broke city is not stopped, it just cannot spend.

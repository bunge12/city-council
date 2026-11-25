# M4-04: Upkeep

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Every metre of road costs money every year, so a sprawling network is a cost the city carries. See "Upkeep is a share of build cost" in the PRD.

## Scope

- An upkeep system charges road upkeep once a game day, on the day's first tick, to the road upkeep line, with the exact daily share from issue 02
- Upkeep in `roads.json` becomes a yearly share of build cost per type, as the PRD says, in place of `upkeepPerMetrePerYear`
- The yearly total is a running sum the road network keeps as segments come, go and change type: each segment's build cost, with the bridge multiplier on a bridge, times its type's share. No pass over the segments
- A function gives each segment's yearly upkeep, for the road readout and for the budget overlay in issue 18
- Building upkeep for city-owned buildings uses the same daily charge. Issue 13 adds City Hall to it

## Out of scope

- Service and transit upkeep, which arrive with their modules
- Showing upkeep in the tools and the panel, which are 15 and 16

## Done when

- [ ] Unit tests build roads of each type and a bridge and find the yearly total equal to a sum over the segments
- [ ] A test charges a full year of days and finds the road upkeep line equal to the yearly total exactly
- [ ] A test of the running sum against a recount after builds, upgrades, bulldozes, splits and undos
- [ ] The system's tick time shows in the debug panel. Its mean and worst on the 500,000 resident city are in the pull request and held by the bench in `budgets.json`, not asserted in a test
- [ ] A replay gives the same state hash

## Notes

The running sum is derived, built at load and kept current by the functions that change the graph, like the spatial index. A sum kept through a city's history must equal one built at load, so keep it in whole dollars per year.

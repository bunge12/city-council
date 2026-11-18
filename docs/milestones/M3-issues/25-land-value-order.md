# M3-25: Land value orders the lots and shapes who moves in

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 07, 08, 11, 13.

## Goal

The best ground fills first, and wealthier households take it. See "Land value" in the PRD.

## Scope

- The grower takes the highest-value free lot of a zone first. This replaces the M2 draw from the generator
- The grower's list of free front cells is kept in value order, and updated as values change, so it never scans the city
- A cell where no lot fits is set aside until its ground changes, which ends the wasted draws the PRD records under "The grower"
- A newcomer's home is drawn among homes with room, weighted by land value
- A newcomer's wealth is drawn from a mix shaped by the value of the home it takes. Both arrivals in issue 08 and replaced households in issue 11 draw this way
- The weights are in `landvalue.json`
- If the grower's saved plan changes shape, `SNAPSHOT_VERSION` goes up with a migration and a test

## Out of scope

- Land value changing which density is built on empty ground. It never does
- Redevelopment, which is issue 14
- Land value setting tax, which is M4

## Done when

- [ ] A scenario test zones a strip by the water and a strip beside factories and finds the first full before the second starts
- [ ] A scenario test finds wealthier pops on the more valuable strip, on average, among both first arrivals and households replaced later
- [ ] A scenario test zones an R3 strip with gaps under 4 cells wide and finds no grower tick spent on them after the first try
- [ ] A replay gives the same buildings in the same order and the same state hash. The fixtures change, since the grower's order does, and the pull request says so
- [ ] A city saved and reloaded while it grows hashes the same as one that never stopped
- [ ] On the scale town with every cell zoned and every bar at 100, the grower's worst tick is inside its 5 ms share, with the number in the pull request

## Notes

Ties in value break by the lower cell, so the order never depends on how the map was walked.

The grower still draws the building type and the variant from the generator in state. Only the choice of ground changes.

A strict order builds outward from the best cell and can look mechanical. If it does, draw among the top few lots, and note the rule in the PRD.

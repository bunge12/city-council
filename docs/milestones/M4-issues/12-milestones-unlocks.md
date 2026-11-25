# M4-12: Milestones, grants and the density unlocks

Milestone: M4 Economy. Spec: [M4.md](../M4.md). Depends on: 02.

## Goal

Growing the city earns something: a grant, and new things to build. See "Progression" in the PRD.

## Scope

- `packages/sim/balance/progression.json`: about ten milestones up to 500,000 residents, each with a population, a name, a grant and its unlocks. The grants are prices with a source year or marked placeholders
- A milestone is reached the first time the population passes it. It is never lost when the population falls
- Reaching one pays its grant to the grants line and records it in state
- An unlock registry in `sim`: each unlock has an id and the milestone that opens it. M4 registers density 2, density 3, City Hall and the larger credit limit. Later modules register their own
- `ZoneCells` refuses a stroke at a locked density, with a reason that names the milestone. Cells already zoned at a locked density keep growing
- Milestones reached go in the delta. `SNAPSHOT_VERSION` and the protocol version go up. The migration credits an older city with every milestone its highest population passed, without their grants, as M4.md proposes, with a test

## Out of scope

- Showing the locks in the zone tool and the sound and toast, which are 16 and 14
- City Hall itself, which is issue 13
- Unlocks for road types, rail modes, services and plants, which their modules add

## Done when

- [ ] Unit tests pass a milestone and find the grant paid once, and pass it again after a fall and find nothing paid
- [ ] A test finds density 2 painting refused before its milestone and allowed after
- [ ] A test loads an M3 city zoned at density 3 and finds the milestones its population passed reached, no grants paid, and its density 3 cells still growing
- [ ] A replay gives the same state hash

## Notes

The PRD says density 2 unlocks at a low population, so a new city of houses can break even before then. Density 3 sits in the middle of the curve. Issue 19 sets the numbers.

The highest population a city has had is in the statistics history. Read it there for the migration.

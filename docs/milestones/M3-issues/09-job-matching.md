# M3-09: Job matching

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 08, 23.

## Goal

Pops find work, nearer jobs first. See "Job matching" in the PRD.

## Scope

- A job matching system in the step. It visits pops without work a slice per tick, with the cursor from issue 03
- A pop picks among buildings with open jobs its education allows, weighted toward nearer ones by free-flow travel time. The weight's shape and strength are in `demand.json`
- The draw comes from the generator in state
- Travel times come from issue 23's table of free-flow times between zones of the map
- A pop with no route to any open job stays without work
- A pop is one workplace. If the building it draws has fewer open jobs than the pop has workers, see the notes
- The grower builds no workplace in a zone while that zone's open jobs are above a set share of its jobs, in `demand.json`
- When a workplace is removed or abandoned, its pops lose their jobs and look again
- Each building's jobs filled, and the totals of employed and unemployed, stay current
- If the matching cursor or anything else here is state, `SNAPSHOT_VERSION` goes up with a migration and a test. The protocol version goes up if the delta gains a field

## Out of scope

- Congested travel time and mode choice, which are M5 and M6
- Commutes loading onto roads, which is M5
- Leaving for lack of work, which is issue 10
- Pops changing jobs for a nearer one. A pop keeps its job until it loses it

## Done when

- [ ] A scenario test puts homes between a near and a far workplace with equal jobs and finds more pops working at the near one, and some at the far one
- [ ] A scenario test offers only office jobs to low education pops and finds them unemployed
- [ ] A scenario test finds shops stop being built while open shop jobs are above the share, and start again as they fill
- [ ] A scenario test bulldozes a workplace and finds its pops unemployed, then working elsewhere
- [ ] No building has more jobs filled than it offers, checked after every step of a long scripted session
- [ ] The totals equal the recount at the end of each test
- [ ] A replay gives the same workplaces and the same state hash
- [ ] On the scale town with 150,000 pops all looking at once, the worst tick is inside the system's share of the 20 ms budget. The number is in the pull request

## Notes

This is the issue most likely to blow the tick budget. Measure before polishing. The cost is pops in the slice times candidate zones, not times buildings: pick a zone by its open jobs and travel time first, then a building inside it.

A pop larger than the open jobs in the building it drew is the awkward case. The proposal is to split the pop: the part that fits takes the jobs, and the rest stays a pop of its own and looks again. That is what the PRD means by a tower's pops being "split by where they work". The other choice is that a pop takes a workplace only if all its workers fit, which is simpler and leaves large pops stranded. Decide here and record it in the PRD.

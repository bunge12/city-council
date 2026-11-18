# M3-24: Vacancy and abandonment

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 10.

## Goal

Buildings that people have left stand vacant, then abandoned, and come back into use when demand returns. See "Four demand bars" in the PRD.

## Scope

- A home with no pops is vacant. A workplace is vacant while none of its jobs is filled and its zone's bar is below zero
- A building vacant for a set time is abandoned. An abandoned workplace offers no jobs, and an abandoned home no room
- An abandoned building comes back into use when its zone's bar is above zero, before the grower builds new ones, if its ground is still zoned for what it is
- Vacant and abandoned are building state, with the tick the building became so. They go in the building rows of the delta
- The check visits a slice of buildings per tick, every building once per game day
- The times are in `demand.json`. The proposal is about three game months vacant before a building is abandoned
- `SNAPSHOT_VERSION` and the protocol version go up, with a migration and a test

## Out of scope

- Clearing an abandoned building whose ground was rezoned, which is issue 14
- How vacant and abandoned buildings look, which is issue 17
- Demolition cost for abandoned buildings, which is M4

## Done when

- [ ] A scenario test empties a city of its jobs and finds homes vacant as pops leave, then abandoned about three game months later
- [ ] A scenario test brings the jobs back and finds abandoned homes taking people again before any new house is built
- [ ] A scenario test finds an abandoned factory offers no jobs, and offers them again once the industrial bar is above zero
- [ ] The totals equal the recount at the end of each test, with abandoned buildings' room and jobs left out of both
- [ ] A replay gives the same state hash, and a city saved with buildings part way to abandonment resumes to the same hash
- [ ] The system's tick time on the scale town is in the pull request

## Notes

A building that has just been built is not vacant yet. Start the clock when it has stood empty for a game month.

Jobs offered and capacity in the running totals leave out abandoned buildings, or the bars would read a dead district as open jobs and spare room.

A home emptied by turnover alone, with demand above zero, refills through arrivals long before the clock runs out. That is the "Home empties" row under "Turnover" in the PRD.

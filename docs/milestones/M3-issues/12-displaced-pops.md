# M3-12: Displaced pops

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 09.

## Goal

When a building goes, the people in it look for somewhere else. See "Removing things" and "Rezoning" in the PRD.

## Scope

- Removing a home, by `BulldozeBuilding`, by a road built through it, by `BulldozeRoad` or by issue 14's redevelopment, displaces its pops and no longer deletes them
- A displaced pop takes free room in another home that has a route to its job, or to an outside connection if it has none. It keeps its job when it can still reach it
- A displaced pop that finds no room leaves the city and counts as a departure
- Removing a workplace frees its jobs. Its pops stay in their homes and look for work, which issue 09 already does
- Displaced pops are placed in the step that removes the building, up to a cap per step. Past the cap the rest wait in a queue in state and are placed over the next ticks
- The bulldozer's plan functions count the people who would be displaced, so the price tag shows residents living there and not capacity
- The queue is state, so `SNAPSHOT_VERSION` goes up with a migration and a test

## Out of scope

- The relocation payment and the eminent domain price, which are M4
- The satisfaction hit to displaced pops and their neighbours, and the record of each expropriation, which are M4
- Undo bringing pops back. Undo restores roads and zoning and never buildings, as decided in M2

## Done when

- [ ] A scenario test bulldozes an occupied house beside empty ones and finds its pop in another home, with its job kept and the population unchanged
- [ ] A scenario test bulldozes every home in a full city and finds the pops gone and counted as departures
- [ ] A test runs `BulldozeBuilding` at its cap over occupied buildings and finds the step inside the 20 ms budget, with the queue drained over the ticks after
- [ ] The totals equal the recount, and no pop names a building that is gone, at every step of a long scripted session
- [ ] A replay gives the same state hash, and a city saved with pops in the queue resumes to the same hash
- [ ] The bulldozer's tag over a house shows the people living there. Screenshot in the pull request

## Notes

Issue #162 is open on `BulldozeBuilding` at its cap running past the tick. This issue adds work to the same step, so the queue is not optional. Check #162's state before starting.

A pop in the queue is homeless for a few ticks. It still counts in the population, and it still holds its job.

The tag is the only client change here. It needs browser evidence.

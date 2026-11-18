# M3-23: Free-flow travel times between zones

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: M2.

## Goal

The sim can say how long it takes to drive between any two parts of the city, cheaply enough to ask 150,000 times a game day.

## Scope

- The map is cut into travel zones. The proposal is one zone per 500 m chunk, which the sim already has
- A derived table of free-flow travel times between zones, built from the routing graph of M1-15. A zone's times are measured from the routing node nearest its middle that a road reaches
- A query: the time between two buildings, read from their zones. Two buildings in one zone get a short fixed time, so a pop can work next door
- A zone no road reaches, or a pair with no route, answers "no route"
- The table is rebuilt for the zones a change of roads can affect. When that is more than a tick's work, it settles over several ticks, up to a tick fixed when the change applied, as the zoning cells do with `cellsReadyAt`. Until then readers get the old table
- It lives outside state and is never saved or hashed. If the settling tick is state, `SNAPSHOT_VERSION` goes up with a migration and a test

## Out of scope

- Congested times, which are M5. M5's traffic zones may or may not be these zones
- Walking, cycling and transit times, which are M6 and M7
- Anything that reads the table. Job matching is issue 09

## Done when

- [ ] Unit tests check the table against the pathfinder between sample points on a small network, within a set tolerance
- [ ] A test finds a table kept current through a session of road changes equal to one built from scratch at the end
- [ ] A test bulldozes the only road between two halves of a town and finds "no route" between them
- [ ] A city saved while the table settles resumes to the same answers on the same ticks
- [ ] `pnpm bench` on the 30,000 segment city records the full build, the rebuild after one `BuildRoad`, the table's memory and the time of one query. No tick goes over the 20 ms budget
- [ ] Arithmetic is add, subtract, multiply, divide and `Math.sqrt` only

## Notes

The 12 km map has 576 chunks, so a full table is about 330,000 pairs. At two bytes a pair that is under 1 MB. One shortest-path tree per zone gives a row.

Rebuilding every row after every road is the cost to watch. A new street in one corner changes few rows by much. Start by rebuilding everything over a fixed number of ticks, measure, and narrow it only if the bench says so.

This runs beside the pop work. It needs nothing from M3.

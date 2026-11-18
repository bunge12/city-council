# M3-13: Land value

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 01.

## Goal

Every zoning cell has a value. See "Land value" in the PRD.

## Scope

- A value per zoning cell from four inputs: road access, distance to water, distance to the city centre, and pollution from industry nearby
- The weights, distances and the pollution radius per industrial density are in a new `packages/sim/balance/landvalue.json`, checked at load and part of the balance stamp
- The city centre: the middle of the city's jobs, recomputed on the first tick of each game month, and the middle of its homes while it has no jobs
- A land value system in the step that recomputes the map a slice per tick, and sooner around a change of roads, buildings or zoning
- A query: the value at a cell, and the parts that make it up
- Whether the values are state or derived is decided here. See the notes

## Out of scope

- Congestion, road noise, transit, services, parks, crime, satisfaction and plant pollution as inputs, each of which arrives with its module
- Land value setting the tax a building pays, which is M4
- Using the value: lot order and who moves in are issue 25, and redevelopment is issue 14
- The overlay, which is issue 18

## Done when

- [ ] Unit tests check each input alone: value falls with distance from water and from the centre, falls inside an industrial building's radius, and is higher on an avenue than on a street if the file says so
- [ ] A test builds a factory beside a zoned strip and finds the cells near it worth less within a game day
- [ ] A city saved and reloaded while values are being recomputed hashes the same as one that never stopped
- [ ] A replay gives the same values on the same ticks
- [ ] On the scale town the system's worst tick is inside its share of the 20 ms budget, and a full pass over the map finishes inside a game day. Both numbers in the pull request

## Notes

State or derived. If a cell's value is a pure function of roads, buildings, terrain and the centre, it can be derived and never saved, like the cell index. But a slice per tick means the values in use at any tick depend on where the pass has got to, and that has to be the same on every machine and after a reload. The simple answer is to make the values and the pass cursor state, at a byte or two per cell on about a million cells. The cheaper answer is a coarser grid than the cell, such as one value per 64 m square. Measure both and decide. If it is state, `SNAPSHOT_VERSION` goes up with a migration and a test, and the protocol version goes up when the values join the delta.

The PRD puts land value in a background worker. With four cheap inputs the proposal is to keep it in the step. If the 500,000 checkpoint in issue 20 says otherwise, it moves to a worker, and its results are applied on a tick fixed when the job started, under rule 5 in CLAUDE.md.

Distances use add, multiply and `Math.sqrt` only. The values feed the grower's order, which a replay on another machine must reproduce, so rule 6 applies: no `Math.pow` or `Math.exp` for the falloff. A piecewise linear falloff is enough.

The centre is the mean of building positions weighted by jobs. It needs issue 01's jobs function and no pops, which is why this can start early.

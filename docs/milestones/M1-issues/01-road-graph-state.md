# M1-01: Road graph in state and road balance data

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: M0.

## Goal

The city can hold a road network. Nothing builds one yet, but the arrays, the road type data and the save format are in place.

## Scope

- Nodes and segments in typed arrays indexed by id, with a free list so ids are reused in a fixed order
- Per node: position in metres, height, and a flag for nodes the player cannot remove
- Per segment: the two node ids, road type, network type of road, rail or path, vertical level, the curve control point, and length
- Arrays grow by doubling when full. Growth must not change the state hash of the data they hold
- Internal functions to add and remove a node or a segment and to list the segments at a node. No commands yet
- `packages/sim/balance/roads.json` with one entry per road type: street, avenue, one-way and highway. Each has lanes, one-way or not, speed, capacity, width, zonable or not, build cost per metre, upkeep, maximum slope and minimum curve radius
- Each price carries its source and source year, and one escalation factor brings it to 2026. The avenue price starts from the Phoenix arterial figure in the PRD
- `SNAPSHOT_VERSION` goes to 3, with a migration from 2 that adds an empty network, a test and a committed v3 fixture

## Out of scope

- Commands, which start in issue 03
- The spatial index and the routing graph
- Rail and path types in the balance file. The network type field exists and only road is used

## Done when

- [ ] Unit tests cover adding and removing nodes and segments, id reuse order, and array growth
- [ ] A state with a network serialises, deserialises and hashes the same
- [ ] A v2 save loads as a v3 city with no roads
- [ ] A test fails if a road type in the balance file is missing a field or a price has no source year
- [ ] No class instances, `Map`s or closures hold network data

## Notes

Slope and curve limits sit on the road type and not in code, because rail in M7 reuses this graph with gentler limits. The PRD has no source for the price of a local street. Look for one. If there is none, mark the number as a placeholder in the file and leave it on the PRD's still-to-price list.

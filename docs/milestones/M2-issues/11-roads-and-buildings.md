# M2-11: Roads, rezoning and buildings

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 10.

## Goal

Buildings follow the rules when the ground under them changes: a road goes, a road arrives, the zoning changes, or the player clears one.

## Scope

- Removing a road removes its cells and every building on them. That covers `BulldozeRoad` and the undo of a build
- A building is removed when any cell of its lot is removed or becomes blocked
- A new road across zoned ground blocks the cells under it and removes the buildings that stood on them. That covers `BuildRoad`, `BuildRoadGrid` and the undo of a bulldoze
- A split under a building's frontage leaves the building standing on the same ground
- An upgrade keeps the buildings on the road, by the rule issue 03 chose
- Rezoning built land leaves the building standing. So does clearing its zoning. The new zoning applies once the lot is free. See the table under "Rezoning" in the PRD
- `BulldozeBuilding` removes the named buildings. The payload carries each building's id and its lot's first cell, and the sim refuses the command when they do not match. The lot is free at once and the grower may build on it under the current zoning. It costs nothing until M4
- The plan functions for building a road, building a grid and bulldozing a road also return the buildings that would go and the residents they hold, for the previews in issue 15

## Out of scope

- The eminent domain price, which is M4
- Displaced pops, which are M3
- Redevelopment by owners, which is M3
- The undo records, which are issue 16

## Done when

- [ ] Unit tests cover each case in the scope list
- [ ] Bulldoze a street with houses on both sides: the cells and the houses are gone, and no building in state points at a missing cell
- [ ] Build a street through a row of houses: only the houses with a cell under the new road go
- [ ] Rezone a built R1 lot to C2: the house stays. Clear it with `BulldozeBuilding` and a C2 building grows there
- [ ] A `BulldozeBuilding` whose building changed since the player saw it is refused with a reason
- [ ] The plan functions and the applied commands remove the same buildings, shown by a test
- [ ] The replay fixtures gain a session that builds, zones, grows and bulldozes

## Notes

Building ids are reused from a free list, so an id alone can name a different building a tick later. Issue #94 found the same with segment ids. That is why `BulldozeBuilding` carries the lot as well.

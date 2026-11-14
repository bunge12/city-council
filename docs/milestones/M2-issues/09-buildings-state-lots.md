# M2-09: Buildings in state, building types and the lot finder

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 04.

## Goal

The city can hold buildings, and the sim can say which building fits which ground. Nothing grows yet.

## Scope

- `packages/sim/balance/buildings.json` with one entry per building type: zone, density, lot width and depth ranges in cells, and residents low and high for housing
- The six housing types and their numbers come from the table under "Residential building types" in the PRD
- Commercial, office, industrial and mixed get three or four starting types per density on lots from 1 × 1 to 6 × 6, marked as proposals in the file and added to the PRD as a table
- Buildings in typed arrays indexed by id, with a free list: the lot's first cell, its width and depth, zone, density, type, residents, a variant number and the tick it was built
- Per cell, the building standing on it, or none
- A lot is a rectangle of free cells with one zone and one density, fronting a road. It may run across the strips of segments that continue each other in a straight line
- The lot finder: given a free zoned cell, return the largest lot there that fits a building type, and the type. The lot's shape picks the type, by the three rules under "How the grower chooses" in the PRD
- When no type fits, the finder returns the reason, for the overlay in issue 15. An R3 lot under 4 × 4 is the first case
- Internal functions to add and remove a building. No command and no grower yet
- Buildings in the snapshot message and in deltas, and in the mirror by chunk
- `SNAPSHOT_VERSION` bump, with a migration to a city with no buildings, a test and a committed fixture

## Out of scope

- Growth, which is issue 10
- Jobs per building. The PRD lists them as an open question to answer before M3
- Lots deeper than six cells, which are issue 14
- Pops. A building stores how many residents it holds, and M3 fills it

## Done when

- [ ] A test fails if a building type is missing a field or two types of one zone and density claim the same lot shape
- [ ] Unit tests give the finder each row of the housing table and get that type back
- [ ] A shallow R2 strip yields townhomes and a deep one apartments. An R3 lot of 3 × 6 yields nothing, with the reason
- [ ] A state with buildings serialises, deserialises and hashes the same
- [ ] A delta after adding one building holds that building and nothing else
- [ ] No class instances, `Map`s or closures hold building data

## Notes

A T-junction on the far side of a street splits the segment, so a lot that could not cross a segment end would be cut for no reason the player can see. That is why lots may cross where the road runs straight on. Along a curve, the cells of a strip are not a clean grid. Decide here whether lots there are limited to one cell wide, or fitted some other way, and write it in the PRD.

The lot sizes for housing are the owner's starting proposal and are still an open question in the PRD. Keep every number in the balance file so answering it is a data change.

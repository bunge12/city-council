# M1-03: BuildRoad: straight segments and validation

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 02.

## Goal

A command builds a straight road between two points, and the sim refuses the ones that make no sense.

## Scope

- `BuildRoad` with a start point, an end point and a road type. The player id comes with the command, as always
- The sim rounds positions to a fixed grid, so two nodes are either the same or apart with no tolerance checks. Suggested step: one eighth of a metre
- An end point within the merge distance of an existing node joins that node. Otherwise a new node is created
- Validation, each with a reason a player can read: outside the map, shorter than the minimum length, a duplicate of an existing segment, too sharp an angle against another segment at a shared node, over water, steeper than the type allows
- Slope is checked by sampling the ground along the path, against the maximum slope of the road type
- Highway is refused as a buildable type until M5
- Node heights are set from the terrain
- The sim needs the terrain to validate. Terrain is rebuilt from the seed and is not in state, so give validation a way to read it that works the same in a worker, on a server and in replay
- A replay fixture that builds a small network

## Out of scope

- Splitting a segment that the new road crosses, which is issue 04. Until then a crossing is refused
- Curves and bridges
- Charging money. The cost exists in data and the treasury arrives in M4

## Done when

- [ ] Unit tests cover one accepted road and every rejection reason
- [ ] Two roads drawn to the same point share one node
- [ ] The replay fixture produces its committed hash
- [ ] A command checked at submit and made invalid by an earlier command in the same tick is dropped and not logged

## Notes

Merge distance, minimum length and minimum angle go in the balance file. Decide here how a road meets the ground, as M1.md describes, and record it in the PRD.

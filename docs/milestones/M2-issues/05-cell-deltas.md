# M2-05: Cell deltas in the protocol and the mirror

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 04.

## Goal

The client's read-only copy of the city holds the cells and stays current.

## Scope

- The snapshot message carries every cell's zone and density
- A delta carries only the cells that changed since the last one, grouped by segment
- If issue 03 made the blocked flags derived data, the mirror derives them with the same sim function, imported through the sim entry file. Only zones and densities travel
- The mirror answers the queries the renderer and the tools need: the cells in a chunk and the cell under a point
- The mirror reports which chunks changed, so the renderer rebuilds only those
- The protocol version goes up

## Out of scope

- Drawing, which is issue 06
- Building deltas, which are in issue 09

## Done when

- [ ] A test paints a strip of 100 cells and checks that the delta holds those cells and nothing else
- [ ] A test builds a road across zoned cells and checks the mirror matches the sim after the delta
- [ ] The mirror after a snapshot and the mirror after the same history of deltas are equal
- [ ] The size of a snapshot for the 30,000 segment city with every cell zoned is recorded in the pull request

## Notes

A road change can change many cells that no command named, because cells near the road are recomputed. Send those from the sim and do not have the client guess them, unless the blocked flags are derived on both sides from the same function.

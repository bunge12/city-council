# M1-18: Blocks enclosed by roads

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04, 09, 12.

## Goal

The sim knows every area fully enclosed by ground-level roads. M8 needs this for whole-block parks, and later modules use it for through-lots on large buildings and for per-block overlays. See "Parks and recreation" in the PRD.

## Scope

- Derive blocks from the road graph. Since issue 04, roads split wherever they cross, so each bounded face of the planar graph of ground-level road segments is one block
- Each block has an id, its boundary as an ordered loop of segments, and its area in square metres
- Only road segments at ground level bound a block. Bridges, tunnels, rail and off-street paths do not split one
- A dead-end street inside a block leaves it one block. Its segments sit inside the boundary walk and add no area
- The unbounded outer face is not a block. An area closed partly by water or the map edge has no road loop and is not a block
- Curved segments bound blocks too. A quadratic curve adds the exact area between its chord and the curve, two thirds of the triangle made by its ends and control point
- Blocks are derived data, like the spatial index and the routing graph. Kept current when a road is built, split, upgraded or bulldozed, and equal to a fresh rebuild
- Block ids and the order of each boundary loop come from the graph alone, so a block kept current and one rebuilt from a save get the same id
- A debug panel toggle that outlines each block and shows its area

## Out of scope

- Zoning cells, which arrive in M2, and anything a block does with them
- Whole-block parks, which are M8
- Through-lots and per-block overlays

## Done when

- [ ] Unit tests cover a single square, a grid of four, a block with a dead end inside, a block bounded by a curve, a loop closed by a bridge that is not a block, and a loop that opens when one side is bulldozed
- [ ] A new road through a block makes two blocks whose areas add up to the old one
- [ ] After a long run of builds and bulldozes, the blocks equal a fresh rebuild, ids included
- [ ] Updating blocks after one `BuildRoad` on a 30,000 segment network is measured and recorded
- [ ] A Playwright walkthrough closes a loop of roads, sees the block outlined with its area, bulldozes one side and sees it go

## Notes

The face walk orders the segments around each node by angle. Do that with exact comparisons (quadrant, then a cross product), not `Math.atan2`, so every machine walks the same faces (CLAUDE.md rule 6). The shoelace area uses only multiply and add.

A decision to record in the PRD: give blocks stable ids from their geometry, for example the lowest segment id on the loop with its direction. That keeps a block's id the same across a save and reload, and M8 can refer to a block without saving the block list.

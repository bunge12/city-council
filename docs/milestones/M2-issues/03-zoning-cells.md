# M2-03: Zoning cells along roads

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 01.

## Goal

Every zonable road has cells along both sides. Nothing paints them yet. See the first paragraph of "M2 Zoning and buildings" in the PRD.

## Scope

- Every ground-level segment whose road type is zonable gets cells of 8 m along both sides, starting at the road's edge and six deep. The numbers come from `zoning.json`
- A cell is named by its segment, its side, its place along the segment and its depth. That name is what state, commands and deltas use
- Along a curve the cells follow the road. Where cells of one strip would overlap on the inside of a bend, the one nearer the start of the segment stays
- A cell is blocked when its ground is water, when its slope passes the limit in `zoning.json`, when any road, rail or path surface covers it, or when it leaves the map
- Bridge spans, tunnels and elevated segments get no cells. Highways are not zonable, so the outside connection stubs get none
- Where the cells of two segments overlap, the older segment keeps its cells. Pieces of one split and streets of one grid share an age, and there the lower segment id wins
- A zone and a density per cell in state, both unzoned for now, in flat typed arrays with one offset per segment
- Cells are kept current. Adding, removing, splitting or upgrading a segment recomputes only the cells near it. When an older road goes, the younger road's cells take the freed ground
- A split carries each cell's zone onto the piece that now holds that ground
- Queries exported through the sim entry file: the cell at a point, and the cells inside a rectangle or a chunk
- Cell geometry is recomputed from the graph on load, so it uses only the arithmetic rule 6 in CLAUDE.md allows
- `SNAPSHOT_VERSION` bump, with a migration that gives an old city unzoned cells, a test and a committed fixture

## Out of scope

- Painting, which is issue 04
- Drawing cells, which is issue 06
- Lots and buildings, which start in issue 09

## Done when

- [ ] Unit tests cover a straight street, a curve in each direction, a crossing, a T-junction, a dead end, a street along a shore and a street on a slope
- [ ] Two parallel streets four cells apart: the older one keeps its full strip, whichever has the lower id
- [ ] Bulldoze the older of the two and the younger one's strip fills out
- [ ] A split leaves every zoned cell on the same ground with the same zone
- [ ] A city saved and reloaded mid-run hashes the same as one that never stopped
- [ ] `pnpm bench` times cell generation for the 30,000 segment city and one `BuildRoad` with the cells kept current. Both numbers are in the pull request, and the second stays inside the tick budget

## Notes

Decide here where cells live, and record it in the PRD. The zone and density of a cell must be in state, because a player set them. Whether a cell is blocked follows from the graph, the terrain and the ages, so it can be derived data like the spatial index and the blocks from M1. That keeps saves small, since about 30,000 segments carry on the order of a million cells.

Decide here what an upgrade does. A wider road pushes its edge out. The proposal is that cells keep their names and move out with the edge, so zoning and buildings stay with the road, and any cell that now lands on an older road's cell is blocked.

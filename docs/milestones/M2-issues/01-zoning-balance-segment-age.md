# M2-01: Zoning balance data and segment age

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: M1.

## Goal

The two things M1 left for M2 are in place before any cell exists: the cell numbers live in sim balance data, and every segment knows how old it is.

## Scope

- `packages/sim/balance/zoning.json` with the cell size of 8 m, the zoning depth of six cells, the five zones and the three densities. Exported through the sim entry file
- `SNAP.cellSize` and `SNAP.zoneDepthCells` in `packages/client/src/tools/config.ts` read from it. The length snap, the parallel offset and the grid tool's default depth follow without their own copy
- A build order number per segment, in a typed array beside the other segment fields, taken from a counter in state. A lower number is an older segment
- A split gives both pieces the parent's number. An upgrade and a reverse keep it. An undo that brings a bulldozed segment back restores the number it had, so the undo journal records it
- `SNAPSHOT_VERSION` goes to 9, with a migration from 8 that numbers existing segments in id order and sets the counter past them, a test and a committed v9 fixture

## Out of scope

- Cells, which are issue 03
- Building data, which is issue 09

## Done when

- [ ] A test fails if `zoning.json` is missing a field
- [ ] Changing the depth in `zoning.json` changes the parallel offset gaps and the grid tool's default depth, shown by a test
- [ ] Unit tests cover the number a segment gets when it is built, split, upgraded, reversed, bulldozed and brought back by undo
- [ ] A v8 save loads as a v9 city, and a city saved and reloaded mid-run hashes the same as one that never stopped
- [ ] The replay fixtures are re-recorded, with the reason in the pull request

## Notes

A v8 save holds no build order, so the migration has to invent one. Id order is the only one every machine agrees on. The order matters only where two roads compete for the same ground, and no cell exists before this milestone, so nothing a player has built changes.

See the last paragraph of "M1 review" in the PRD.

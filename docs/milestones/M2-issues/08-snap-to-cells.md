# M2-08: Snapping to zoning cells

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 05.

## Goal

The road tool snaps to existing zoning cells. This was on the M1 list and moved here, because the cells arrive in M2.

## Scope

- One more snap source in the list from M1: the corners and edges of existing cells, read from the mirror
- Its place in the order and its reach in pixels, decided here and recorded under "How snapping works" in the PRD
- A toggle beside the other guides, with a mark on screen when the snap holds
- A road drawn along the back of a strip leaves that strip whole, and a road drawn across a strip crosses on a cell line
- The grid tool's corners use the same source
- A check that the parallel offset and the length snap follow `zoning.json`, as issue 01 set up

## Out of scope

- Snapping to buildings
- Changes to the snap sources from M1

## Done when

- [ ] Unit tests cover a cursor near a cell corner, near a cell edge, and near both a cell and a node, where the node wins
- [ ] A Playwright test draws a street along the back of a zoned strip and no cell of the strip is blocked afterwards
- [ ] The toggle turns the source off
- [ ] Screenshots attached to the pull request

## Notes

The snap list is already long. If cells fight with the guide lines or the parallel offset in practice, say which one should win and why, and put it in the PRD.

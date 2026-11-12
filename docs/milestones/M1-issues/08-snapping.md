# M1-08: Snapping

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 07.

## Goal

The cursor lands where the player meant, so roads join cleanly without pixel hunting.

## Scope

- Snap targets, in priority order: an existing node, a point on an existing segment, an angle, the terrain grid
- Angle snapping is relative to the segments at the start node, in 15 degree steps, with 90 degrees and straight on winning when close
- When drawing toward an existing segment, the end can snap to meet it at a right angle
- Snapping to the 16 m terrain grid is a toggle and is off by default
- A length readout, with an option to snap length to whole 8 m steps so M2 cells line up
- Each snap shows a marker that says what it caught: a node, a segment, an angle guide line
- Holding a modifier key turns snapping off
- Snap distances are in screen pixels, so they feel the same in every zoom band
- Snapping is client work. It uses the spatial queries from issue 02 on the mirror and sends plain coordinates to the sim

## Out of scope

- Snapping to zoning cells, which moves to M2 because the cells do not exist yet
- Parallel road guides

## Done when

- [ ] Unit tests on the snap function cover each target, the priority between them, and the modifier key
- [ ] A Playwright walkthrough draws a block of four streets with clicks up to 10 pixels off target, and the result is four nodes and right angles
- [ ] A road snapped to a segment produces a T-junction and never a node a few centimetres off the segment
- [ ] Screenshots of each marker attached to the pull request

## Notes

Angle snapping needs trigonometry. That is fine in the client. The sim only ever sees the resulting coordinates, which it rounds to its position grid.

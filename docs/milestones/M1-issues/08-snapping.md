# M1-08: Snapping

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 07.

## Goal

The cursor lands where the player meant, so roads join cleanly without pixel hunting.

## Scope

- Snap targets, in priority order: an existing node, a point on an existing segment, an angle, the terrain grid
- Angle snapping is relative to the segments at the start node, or to the segment a road starts from. 90 and 45 degrees and straight on snap from further away than the lighter 15 degree steps, and win when close
- A right-angle marker shows at the start when the road is square to its source
- When drawing toward an existing segment, the end can snap to meet it at a right angle
- Snapping to the 16 m terrain grid is a toggle and is off by default
- A readout at the cursor: the angle to the source road, and the length in metres and in 8 m cells
- Length snap to whole 8 m steps, so M2 cells fit the frontage exactly
- A toggle in the toolbar for each guide: angle, length and terrain grid. The store keeps them, so issue 19 adds its two toggles to the same row
- Each snap shows a marker that says what it caught: a node, a segment, an angle guide line
- Holding a modifier key suspends every guide for a free-hand segment. Joining a node or a segment within the sim's 4 m merge distance still happens, because the sim does that itself
- Snap distances are in screen pixels, so they feel the same in every zoom band
- Snapping is client work. It uses the spatial queries from issue 02 on the mirror and sends plain coordinates to the sim

## Out of scope

- Snapping to zoning cells, which moves to M2 because the cells do not exist yet
- Guide lines from nearby roads and parallel offsets, which are issue 19
- The grid tool, which is issues 20 and 21

## Done when

- [ ] Unit tests on the snap function cover each target, the priority between them, each toggle and the modifier key
- [ ] A road drawn 3 degrees off square from a street snaps to 90 degrees and shows the right-angle marker. The same road with the angle toggle off keeps its 3 degrees
- [ ] The readout shows 96 m as 12 cells
- [ ] A Playwright walkthrough draws a block of four streets with clicks up to 10 pixels off target, and the result is four nodes and right angles
- [ ] A road snapped to a segment produces a T-junction and never a node a few centimetres off the segment
- [ ] Screenshots of each marker attached to the pull request

## Notes

Angle snapping needs trigonometry. That is fine in the client. The sim only ever sees the resulting coordinates, which it rounds to its position grid.

The PRD section "Angle and spacing guides" lists five guides. This issue builds angle snap, length snap and the readout. Guide lines and parallel offset are issue 19, so write the snap function as a list of sources that 19 can add to.

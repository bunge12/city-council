# M1-19: Guide lines and parallel offset

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 08.

## Goal

A new street lines up with the streets around it, and a street drawn beside another lands at a spacing that zones cleanly. This is the rest of "Angle and spacing guides" in the PRD.

## Scope

- Guide lines. While a road is being drawn, faint lines run perpendicular and parallel from nearby nodes and segments. The cursor snaps to a line when it is close, so a street lines up with one two blocks away
- Guide lines come from roads within a set distance of the cursor, found with the box query from issue 02 on the mirror. At most a set number show at once, nearest first
- Where two guide lines cross, the cursor snaps to the crossing
- Parallel offset. Drawing beside an existing road snaps the new road to set distances from it. The main one leaves twelve 8 m cells between the two roads, which is two strips of six cells back to back with no gap. Six cells, one strip, is the lighter one
- The offset is measured between road edges, not centre lines, so it takes both road widths from `roads.json`. Avenue beside street gives a different centre distance than street beside street
- Both guides are new sources in the snap function from issue 08. Nodes and segments still win over them. Their order against angle snap is decided here and written in the PRD
- Each guide shows what it caught: the line itself, and for an offset the distance in cells
- A toolbar toggle for each, next to the ones from issue 08. The modifier key from issue 08 suspends them too
- The search distance, the line limit and the offsets live in the client's tool config
- Client work only. The sim sees plain coordinates

## Out of scope

- Guides from zoning cells, which arrive in M2
- Guides along curves. A curved segment gives guide lines from its end nodes only
- The grid tool, which is issues 20 and 21

## Done when

- [ ] Unit tests cover a perpendicular line, a parallel line, a crossing of two lines, each offset for two road widths, and the priority against nodes, segments and angles
- [ ] A Playwright walkthrough draws a street, then a second one beside it with clicks up to 10 pixels off. The gap between the road edges is 96 m
- [ ] The walkthrough draws a third street whose end lines up with a node two blocks away
- [ ] With both toggles off, neither guide draws or snaps
- [ ] Drawing in a network of 30,000 segments keeps the frame time it had without guides
- [ ] Screenshots of both guides attached to the pull request

## Notes

Twelve cells assumes the M2 rule that each zonable segment gets cells six deep from its edge. If M2 changes the depth, the offsets change with it, so read them from one place.

Too many lines at once is worse than none. Start with a low limit and raise it only if lining up gets hard.

# M1-04: Intersections: splitting where roads cross or meet

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 03.

## Goal

Drawing a road across or onto another one makes an intersection.

## Scope

- When a new road crosses existing segments on the same level, each crossed segment splits at the crossing point and a shared node joins them
- When a new road starts or ends on the body of an existing segment, that segment splits there and a T-junction forms
- One `BuildRoad` may cross several segments. It becomes a chain of segments, in order along the drawn line
- A split keeps the road type, network type and level of the segment it splits
- A crossing that would leave a piece shorter than the minimum length moves to the nearby node if one is within the merge distance, and is refused otherwise
- A crossing at too shallow an angle is refused with a reason
- Segments on different levels or different network types do not split each other
- The ids of everything a command creates are assigned in a fixed order

## Out of scope

- Junction types and delays, which belong to M5
- Crossing a curve, which issue 09 adds

## Done when

- [ ] Unit tests cover a plain cross, a T-junction at each end, a line through three parallel roads, a crossing right next to an existing node, and a shallow crossing that is refused
- [ ] After any accepted command, no two segments on the same level cross without a shared node. A test checks this on 500 random roads
- [ ] A replay fixture with crossings produces its committed hash
- [ ] The crossing point is the same whichever of the two roads was drawn first

## Notes

The crossing point is rounded to the position grid, so a split segment may bend by a fraction of a millimetre. That is fine. What matters is that every machine rounds it to the same place.

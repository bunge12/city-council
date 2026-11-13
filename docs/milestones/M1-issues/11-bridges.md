# M1-11: Bridges over water

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 09.

## Goal

A road drawn across water becomes a bridge without the player picking a bridge tool.

## Scope

- When a `BuildRoad` path crosses water, the sim makes the span over water a bridge, with a node on each bank
- A bridge is a segment with its level set to bridge and its deck a set clearance above the water. This is the first use of the vertical level field
- The ramp from each bank up to the deck must fit the slope limit of the road type, or the road is refused with a reason
- A bridge has a maximum length and a cost multiplier per road type, both in the balance file
- A node may not sit in open water, so nothing can branch off the middle of a bridge
- A road may not start or end in water
- The renderer draws a deck, railings and piers down to the lake bed
- The tool preview shows which part will be a bridge and includes it in the cost

## Out of scope

- Bridges over dry valleys, tunnels and elevated roads. M5 builds them for roads and M7 reuses them for rail
- One road passing over another, which is issue 22
- Ships and bridge height classes

## Done when

- [ ] Unit tests cover a river crossing, a crossing longer than the limit, a bank too steep for the ramp, and an end point in water
- [ ] A bridge survives save, load and replay with the same hash
- [ ] Two bridges that cross each other over water are refused
- [ ] A Playwright walkthrough draws a street across a river and screenshots the bridge in the street and district bands
- [ ] The PRD records what "automatic bridges over water above a height" came to mean

## Notes

M1.md reads the PRD line as "bridge the water, with the deck above it". If that reading is wrong, fix it here before building.

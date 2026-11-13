# M1-22: Levels and crossings without an intersection

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04, 11.

## Goal

Two segments at different levels can cross without splitting each other. This is the M1 share of grade separation. See "Levels and grade separation" in the PRD. The control to raise and lower a road, ramps, tunnels and the underground view are M5.

## Scope

- The level field from issue 01 becomes general. The levels are tunnel, ground and two elevated levels, and the height of each is a value in `roads.json`
- A bridge from issue 11 stays what it is: an elevated segment whose deck height comes from the water under it
- A segment can hold a different level at each end, so that M5 can build a ramp without a new save version. M1 builds no ramps
- The crossing rule. Where two segments on the same network cross, the sim compares their heights at that point. With enough clearance they pass and no node forms. At the same height they split and join as in issue 04. In between, the build is refused with a reason. The clearance is a value in `roads.json`
- The heights use only exact arithmetic, like the rest of `BuildRoad` validation
- The spatial index queries from issue 02 can filter by level, so snapping and picking on the ground ignore a deck overhead
- The routing graph needs no change. Segments connect only where they share a node. A test proves a route cannot jump from one road to the road above it
- Blocks from issue 18 already count ground-level segments only. A test covers a block with an elevated segment passing over it
- The renderer draws a non-ground segment at its height, on plain piers. Enough to see it in the debug view
- No player tool sets a level in M1. Tests and the debug panel build raised segments through the internal functions, as issue 17 does for rail

## Out of scope

- The raise and lower key, ramps as buildable roads, tunnel mouths and the underground view, which are M5
- Costs for elevated roads and tunnels. The PRD lists them as still to price
- Zoning rules for elevated segments, which arrive with zoning in M2
- Rail, which reuses all of this in M7

## Done when

- [ ] Unit tests cover an elevated segment over a ground segment with no node formed, two segments at the same level splitting as before, a crossing with too little clearance refused with a reason, and a ground road passing under a bridge approach
- [ ] A route between the two roads of an overpass exists only if they share a node somewhere else
- [ ] A block under an elevated segment keeps its boundary and area
- [ ] The snapshot version is bumped with a migration and a test, if the shape of the level data changed
- [ ] An overpass survives save, load and replay with the same hash
- [ ] The crossing check is measured on the 30,000 segment network and fits the tick budget
- [ ] The PRD records the level heights and the clearance

## Notes

The code has four level values today: ground, bridge, tunnel and elevated. The PRD now asks for tunnel, ground and two elevated levels. Decide here how the bridge maps onto that, and write the answer in the PRD. One option is to keep the bridge as its own value with a height taken from the water.

Issue 11 refuses two bridges that cross over water. That stays, because both decks sit at the same clearance.

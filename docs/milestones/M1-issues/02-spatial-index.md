# M1-02: Spatial index over the road graph

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 01.

## Goal

The sim and the client can ask what road is near a point without scanning every segment.

## Scope

- A grid index with one cell per 500 m chunk, listing the nodes and segments that touch each cell
- Queries: nearest node within a radius, nearest point on any segment within a radius, and all segments that touch a box
- Queries take a network type filter
- The index updates when a node or segment is added or removed
- The index is derived data. It is rebuilt from the graph arrays on load and is not saved or hashed
- Decide where derived data lives and how a host rebuilds it, and write that down in the PRD. The routing graph in issue 15 follows the same pattern
- The queries are exported from the sim entry file as pure functions, so the client can run them on its read-only copy for picking and snapping

## Out of scope

- Snapping rules, which are issue 08
- Curves. Until issue 09 every segment is a straight line

## Done when

- [ ] Each query returns the same answer as a brute-force scan on a random network of 5,000 segments
- [ ] An index kept up to date through 1,000 random adds and removes equals one rebuilt from scratch
- [ ] Query results come back in a fixed order, by id, so nothing depends on insertion history
- [ ] A nearest-segment query on a 30,000 segment network takes under 0.1 ms on average, measured and recorded

## Notes

The M0 review warns about state hiding in module-level caches inside the sim. An index is allowed because a rebuild gives the same answers. The second and third checks above are what prove that.

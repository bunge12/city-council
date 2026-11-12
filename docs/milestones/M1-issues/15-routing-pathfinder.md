# M1-15: Routing graph and pathfinder

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04, 06.

## Goal

The sim can answer "how do I get from here to there by road", which every later module asks.

## Scope

- A routing graph derived from the network, with one edge per direction per segment. A one-way segment gives one edge
- Edge cost is free-flow travel time: length over the speed of the road type
- `findRoute` between two nodes returns the segments in order, the distance and the travel time, or says there is no route
- A network type filter, so a later rail route never leaves the track
- Routing between two points, not only two nodes: each point attaches to the nearest segment and may leave it in either permitted direction
- The routing graph is derived data and follows the pattern set in issue 02. It updates when the network changes and equals a fresh rebuild
- Ties between equal routes break by id, so the answer never depends on build order or on the machine
- A route tool in the debug panel: click two points, see the route highlighted with its length and time, or "no route"

## Out of scope

- Congestion, junction delays and turn restrictions, which are M5
- The coarse graph of arterials for long trips, which is M5
- Running the pathfinder in a background worker

## Done when

- [ ] Unit tests cover a shortest route that is not the fewest segments, a one-way that forces a detour, two unconnected networks, and a start and end on the same segment
- [ ] Results match a plain Dijkstra search on 200 random pairs across a random network
- [ ] A route across a 30,000 segment network takes under 20 ms, measured and recorded
- [ ] After a long run of builds and bulldozes, routes on the updated graph equal routes on a rebuilt one
- [ ] A Playwright walkthrough picks two points, sees the route, bulldozes the only link and sees "no route"

## Notes

M3 uses this for commute length and M5 replaces the edge cost with congested time. Keep the cost function separate from the search so that swap is small.

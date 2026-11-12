# M1-16: Outside connections at the map edge

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 12, 15.

## Goal

Every city starts with the fixed highway connections where new residents and trade will arrive.

## Scope

- Two or three connections per map, placed from the seed when the city is created. Each sits on dry, flat ground at the map edge, and they are spread across different sides where the terrain allows
- Each connection is a fixed node at the edge and a short highway stub leading into the map, ending in a node the player can build from
- The stub and its edge node cannot be bulldozed or upgraded
- Connections are stored in state as a short list of node ids, so later modules can find them
- Placement uses the seeded generator in state or exact arithmetic on the seed, and gives the same connections on every machine
- A migration adds connections to cities saved before this issue, with the snapshot version bump, a test and a fixture
- A new city has no other roads. The stubs are where the player starts
- The renderer marks each connection so the player can find it from the city band, and the camera starts looking at one
- A query that says whether a given node can reach any outside connection

## Out of scope

- People or goods arriving, which is M3
- The highway as a buildable type, which is M5
- A rail connection, which is M7

## Done when

- [ ] Unit tests on 100 seeds show two or three connections each, all on dry land at the edge, none within a set distance of another
- [ ] The connections for a set of seeds match committed values in Node and in the browser
- [ ] Bulldozing or upgrading a stub is refused with a reason
- [ ] A street built from a stub end routes to the connection
- [ ] An older save loads and gains its connections
- [ ] A Playwright screenshot shows a new city with its connections marked

## Notes

The terrain already tilts toward a sea on one of eight sides. A connection on that side would land in water, so expect some seeds to have all their connections on two or three sides.

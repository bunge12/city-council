# M1-12: BulldozeRoad and UpgradeRoad commands

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 04.

## Goal

Roads can be removed and changed to another type through commands.

## Scope

- `BulldozeRoad` removes one or more segments by id
- A node left with no segments is removed. A node left joining exactly two segments stays, so bulldozing never moves or merges what the player did not touch
- Nodes flagged as fixed cannot be removed, and neither can a segment marked as fixed
- `UpgradeRoad` changes the road type of one or more segments in place
- An upgrade is refused with a reason when the new type breaks a limit the old one met, such as slope, curve radius or bridge length
- Upgrading to or from one-way sets a direction. `UpgradeRoad` on a one-way with the same type reverses it
- Both commands report their price from the balance file: the full cost of the new type less part of the old for an upgrade, and a demolition cost for a bulldoze. Nothing is charged until M4
- A command that names a missing segment is refused whole. No half-applied commands

## Out of scope

- The tools, which are issue 13
- Refunds and eminent domain, which are M4
- Removing zoning cells and buildings with their road, which is M2

## Done when

- [ ] Unit tests cover removing a middle segment, a dead end, the last segment at a node, a fixed segment, and a list with one bad id
- [ ] Unit tests cover an accepted upgrade, a refused one, and reversing a one-way
- [ ] Bulldozing every segment leaves empty arrays and a full free list
- [ ] The spatial index after a long run of builds, upgrades and bulldozes equals a rebuilt one
- [ ] A replay fixture using both commands produces its committed hash

## Notes

A wider type takes more ground. In M2 that starts to matter for the cells and buildings beside the road. Here it only changes width.

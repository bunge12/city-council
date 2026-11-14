# M2-16: Undo for zoning, and for roads that carried buildings

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 04, 11.

## Goal

Ctrl+Z works on zoning, and undoing a road change brings the zoning back with it.

## Scope

- `ZoneCells` gets an undo record that holds what each changed cell was before. Undoing it puts those zones back
- The record is tied to its log entry and sits in the player's history with the road records. See "Undo" in the PRD
- Undoing a `BulldozeRoad` brings back the road and the zoning its cells had. The road's journal holds those zones
- Undoing a `BuildRoad` or a `BuildRoadGrid` removes the road and brings back the zoning of the cells it blocked
- Buildings do not come back through undo. The road and the zoning return, and the grower builds again
- `BulldozeBuilding` has no undo record
- An undo that is no longer valid is refused and stays at the top of the history, as in M1
- `SNAPSHOT_VERSION` bump if the record's shape changes, with a migration and a test

## Out of scope

- Undoing growth. The grower's work is not a player's command
- Refunds, which are M4

## Done when

- [ ] Unit tests cover undo of paint, repaint and clear, and undo of each road command over zoned cells
- [ ] Paint a strip, let houses grow, undo the paint: the cells are unzoned and the houses stay, by the rezoning rule
- [ ] Bulldoze a zoned street and undo: the street and its zoning are back, with no buildings
- [ ] A city saved and reloaded between a paint and its undo behaves the same as one that never stopped
- [ ] The PRD's "Undo" section says what undo does and does not bring back
- [ ] The undo walkthrough from M1 gains a zoning step

## Notes

Buildings staying gone is the simple rule, and it matches the rest of the design: the grower owns buildings, the player owns roads and zoning. It will matter more in M4, when clearing a building costs money. Say so if undo should bring buildings back.

A paint over a large area changes many cells. Keep the record small, for example as runs of cells with one old value, and measure the snapshot of a city with a long zoning history.

# M1-13: Upgrade and bulldoze tools

Milestone: M1 Road networks. Spec: [M1.md](../M1.md). Depends on: 07, 12.

## Goal

A player can upgrade and remove roads with the mouse.

## Scope

- A bulldoze tool. Hovering a segment highlights it, and a click sends `BulldozeRoad`
- Dragging with the bulldoze tool collects every segment the cursor passes over and sends one command on release
- An upgrade tool that uses the road type picker. Hovering shows the segment as it would look, and a click sends `UpgradeRoad`
- Dragging with the upgrade tool works the same way as bulldoze
- Right-click on a one-way with the upgrade tool reverses its direction
- Both tools show the price before the click, and the reason when the action would be refused
- Segments are picked with the spatial queries on the mirror, with a pick distance in screen pixels
- Fixed segments show as not removable on hover

## Out of scope

- Area and box selection
- A confirmation dialog. Undo in issue 14 is the safety net

## Done when

- [ ] A Playwright walkthrough upgrades a street to an avenue, sees it widen, then bulldozes it and sees it gone, with a log entry for each
- [ ] A drag across four segments produces one log entry
- [ ] Picking works on curves, on bridges and where two roads run close together
- [ ] Keyboard shortcuts for both tools work and are listed with the others
- [ ] Screenshots attached to the pull request

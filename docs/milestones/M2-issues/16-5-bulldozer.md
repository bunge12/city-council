# M2-16.5: The bulldozer as a tool of its own

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 11, 12, 15. Issue: #116.

## Goal

The bulldozer is one tool for everything the player can remove. With it on, whatever is under the cursor lights up, a price tag says what a click removes and what it costs, and the click removes it. Each milestone that adds something removable plugs a new target kind into this tool. The rules are in the PRD under "Removing things".

## Scope

- Its own dock button beside the road button. B turns it on and off, R the road tool, Page Up and Page Down tilt the camera. The road menu keeps upgrade only
- Hover picks one thing and marks it in the bulldoze orange. A building is picked by the box it is drawn as under the pointer's ray; a road keeps the screen-pixel pick. Where both are under the pointer, the building wins
- A price tag above whatever is picked, from the target's plan function: a road's price and the buildings and residents that go with it, a building's readout with a $0 price line and "Can't be undone", a drag's total, and a fixed road that cannot be removed
- A click sends `BulldozeRoad` or `BulldozeBuilding`. A drag collects every target of the kind it touched first and sends one command
- Roads and Buildings filters in the bulldozer's menu
- A target registry in the client, which later milestones add to
- The PRD's "Removing things" section, and a pointer to it in each of the M4 to M9 module specs

## Out of scope

- Eminent domain prices, which M4 adds to the tag
- Trees and every target from M5 on
- A confirmation dialog, and an undo for `BulldozeBuilding`
- New sim commands

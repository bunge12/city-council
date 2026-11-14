# M2-15: Tools and buildings: previews, clearing and lot marks

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 07, 11, 12.

## Goal

The tools tell the player what will happen to buildings before the click, and the overlay says why a lot stays empty.

## Scope

- The road tool, the grid tool and the bulldoze tool highlight the buildings their command would remove and show the count and the residents. The numbers come from the plan functions in issue 11
- The bulldoze tool can pick a building. A click sends `BulldozeBuilding`
- Hovering a building shows its type, zone, density, lot size and residents in a readout
- The zoning overlay marks zoned ground where no building type fits, with the reason from the lot finder on hover. An R3 lot under 4 × 4 is the first case

## Out of scope

- The eminent domain cost in the previews, which arrives with money in M4
- A confirmation dialog

## Done when

- [ ] A Playwright walkthrough draws a road through a row of houses, sees them highlighted with the count before the click, and sees them gone after
- [ ] The grid tool's preview counts the buildings inside the rectangle
- [ ] A click on a building with the bulldoze tool removes it, and one entry appears in the activity log
- [ ] An R3 lot of 3 × 6 shows the mark and the reason
- [ ] Screenshots attached to the pull request

## Notes

The PRD has the grid tool's preview show the eminent domain cost of buildings in the way. M2 shows the buildings and M4 adds the price.

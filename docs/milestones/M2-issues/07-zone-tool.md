# M2-07: Zone tool

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 06.

## Goal

A player paints zones with the mouse.

## Scope

- A zone tool in the build bar with a shortcut, listed with the others. Opening it turns the zoning overlay on
- A picker for the five zones and for densities 1 to 3, and an erase mode
- Fill: hover a road and the strip on that side of that stretch lights up. A click paints it. A depth setting from one to six cells says how far back the paint goes
- Brush: drag over cells to paint the ones under the cursor
- The preview runs `planZoneCells` on the mirror and shows the cells that would change and their count before the click
- Each click or drag sends one `ZoneCells`. A drag too long for one command is cut into several
- The painted cells stay on screen until the delta arrives, as the road tool does
- Escape or a right-click drops the stroke
- Tool state lives in the UI store and never touches sim state

## Out of scope

- Clearing buildings, which is issue 15
- Costs. Zoning is free

## Done when

- [ ] A Playwright walkthrough paints R1 along one side of a street with fill and sees the cells change and one entry in the activity log
- [ ] A fill at depth two paints two rows and no more
- [ ] A brush drag across two streets paints cells on both
- [ ] Erase clears painted cells
- [ ] A click where nothing would change sends nothing
- [ ] Screenshots of the preview and the painted cells attached to the pull request

## Notes

The depth setting is how a player shapes housing. The PRD has shallow R2 strips become townhomes and deep ones become apartments, so painting two rows has to be as easy as painting six.

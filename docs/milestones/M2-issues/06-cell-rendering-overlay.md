# M2-06: Cell rendering and the zoning overlay

Milestone: M2 Zoning and buildings. Spec: [M2.md](../M2.md). Depends on: 05.

## Goal

The player can see the cells and what each is zoned for.

## Scope

- Cells drawn on the ground as a grid beside each road, built from the mirror alone
- Each zone has its own colour and each density its own shade. An unzoned cell is an outline. A blocked cell is not drawn
- One mesh per 500 m chunk, rebuilt only when the mirror says a cell in it changed
- The cells show while a zoning overlay is on. A toggle and a shortcut turn it on, listed with the other shortcuts. Issue 07 turns it on with the zone tool
- Zoom bands: the grid with cell lines in the street and district bands, flat colour with no lines in the city band
- Cells lie on the terrain without flicker and do not hide roads
- The colours live in one client config file, with a legend in the UI
- Drawn at every preset. The overlay has no shadows and no lighting of its own

## Out of scope

- The marks for lots too small to build on, which are issue 15
- Buildings, which hide the cells under them from issue 12 on

## Done when

- [ ] A Playwright test loads a fixture city with all five zones at three densities and screenshots match in all three zoom bands
- [ ] Painting one strip rebuilds only the chunks it touches, shown by a counter in the debug panel
- [ ] The 30,000 segment city with every cell zoned holds the frame rate target with the overlay on, with the frame time recorded for each zoom band
- [ ] Both the WebGPU path and `?webgl` render the same picture
- [ ] Screenshots attached to the pull request

## Notes

Fifteen colours have to stay apart from each other and from the terrain, also for a colour-blind player. Pick the five hues for that and let density change lightness only.

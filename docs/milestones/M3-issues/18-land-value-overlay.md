# M3-18: Land value overlay

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 13.

## Goal

The player can see what the land is worth and why. The PRD asks for an info view for every sim value that affects growth.

## Scope

- A land value overlay, turned on from the build dock or a shortcut. It colours zoning cells by value on one sequential scale with a legend
- With it on, hovering a cell shows its value and the parts that make it up, from issue 13's query: "Water +12, Centre +8, Industry -20"
- It draws in the street and district bands per cell, and in the city band as one colour per chunk, like the zoning overlay
- It reuses the cell meshes from M2-06 with a different colour source. It builds no second set of geometry
- It follows the map as values change, a chunk at a time
- Only one overlay is on at a time. Turning this on turns the zoning overlay off, and the zone tool turns zoning back on

## Out of scope

- Overlays for satisfaction, traffic, pollution and services, which arrive with their modules
- Land value off the zoning cells, such as on open ground with no road
- Showing the city centre as a mark on the map, unless it comes for free

## Done when

- [ ] Unit tests for the colour scale and the hover text
- [ ] A Playwright test loads a city with a waterfront strip and a strip beside factories, turns the overlay on, and reads a higher value over the first
- [ ] Screenshots of the overlay in each zoom band in the pull request
- [ ] Turning the overlay on over the scale town takes no frame over 100 ms, with the number in the pull request
- [ ] No change to sim state or the snapshot version

## Notes

This is the first overlay that is not zoning, so it sets how overlays are chosen. Make the chooser a list, one entry per overlay, since M5 and M8 add more.

Issues #163 and #164 are open on the zoning overlay's cost on a big city. This overlay reads the same cells, so it inherits both problems. Do not make them worse, and check their state before starting.

How the client gets the values depends on issue 13's choice between state and derived. If they are state, they arrive in deltas per chunk. If derived, the client computes them from its mirror with the same sim function.

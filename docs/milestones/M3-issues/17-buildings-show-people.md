# M3-17: Buildings show who is in them

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 05, 24.

## Goal

A building on screen tells the player whether it is lived in, worked in, empty or given up.

## Scope

- The building readout shows people living there against room for a home, and jobs filled against jobs offered for a workplace. A mixed building shows both
- The readout shows the state when it is not ordinary: vacant, abandoned, or built and empty with the reason from issue 08, such as no route to an outside connection
- A vacant building is drawn with its lights and tint dulled. An abandoned one is drawn darker, with boarded windows where the model has them. Both hold in every zoom band, down to the flat blocks of the city band
- The change is a tint or a variant of the existing instanced meshes, so the draw call count does not rise
- The bulldozer's tag over an abandoned building says so
- The zoning overlay's lot marks gain no new mark. A vacant building is not free ground

## Out of scope

- A satisfaction overlay and the list of what moves a pop's score, which are M8
- Naming or listing single pops. The readout gives counts
- Where a building's residents work, which becomes interesting with traffic in M5

## Done when

- [ ] Unit tests for the readout's lines from a building row in each state
- [ ] A Playwright test loads a city file with one occupied, one vacant and one abandoned house side by side, hovers each and reads the lines
- [ ] Screenshots of the three in the street, district and city bands, at Low and at Balanced, in the pull request
- [ ] On the scale town with a tenth of its buildings abandoned, draw calls and frame time in each band are within a few percent of the M2 exit numbers, with both in the pull request
- [ ] No change to sim state or the snapshot version

## Notes

Colours come from a building's id in M2, so an abandoned look has to work across every tint. Scaling the tint toward grey and darkening it is enough to start.

The state arrives in the building rows of the delta from issue 24, so a building changing state re-tints one instance and rebuilds no chunk.

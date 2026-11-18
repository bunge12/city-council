# M3-15: Population and demand in the top bar

Milestone: M3 Demand. Spec: [M3.md](../M3.md). Depends on: 05, 06, 08.

## Goal

The player sees how many people live in the city and what it wants more of.

## Scope

- Population in the top bar, in place of the homes count from M2-18, with an arrow for its recent trend: up, down or level over the last game month
- Four demand bars beside it, residential, commercial, office and industrial, each drawn from -100 to 100 around a centre line, in the zone's colour from the zoning overlay
- A tooltip on each bar that lists what is pushing it up and down, from the parts issue 06 sends, in plain words: "Open jobs +40, Unemployment -15"
- Before a city is open both show "-", like the date
- The homes tooltip's capacity figure moves to the population tooltip: people against room

## Out of scope

- The statistics panel and its graph, which is issue 16
- The treasury and the approval rating, which join the top bar in M4 and M8
- A demand overlay on the map. The bars are city-wide numbers

## Done when

- [ ] Unit tests for the trend arrow and for the tooltip text from a set of parts
- [ ] A Playwright test starts a city, zones R1 from an outside connection, and reads the population rising and the arrow up
- [ ] The same test reads the residential bar's value and tooltip, and finds the bar's value equal to the sim's
- [ ] The figures survive a reload
- [ ] `protocol/homes.ts` and `e2e/homes.spec.ts` are replaced or removed, and the M2 walkthrough's step 14 reads the new figure
- [ ] Screenshots of the top bar with a growing city and a stalled one in the pull request
- [ ] No change to sim state, the snapshot version or the protocol version

## Notes

The bars are the game's main feedback from here on, so they sit where the eye already is. Keep them small: four bars about 8 px wide read at a glance.

The trend compares the population now with the last monthly sample. With no sample yet, it shows no arrow.

Mixed has no bar. Its tooltip line belongs on the zone tool's readout over mixed ground: "Builds when residential and commercial demand are both above zero".
